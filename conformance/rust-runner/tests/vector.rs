use aigg_porw_core::{
    Hash32, PORW_SCHEME_ID, TILE_BYTES, TILE_WORDS, audit_beacon, derive_slot_seed, merkle_proof,
    merkle_root, partials_leaf, porw_scheme_digest, sketch_tile, ticket_chunk, weights_leaf,
};

const N_TILES: usize = 4;
const VECTOR_CASES: [(u32, [u32; N_TILES]); 3] = [
    (1, [3485902744, 372182208, 1349964192, 38446344]),
    (
        0xDEAD_BEEF,
        [1557940684, 3400778530, 3931927942, 1241214034],
    ),
    (0x9E37_79B9, [1823348526, 1479624626, 958815834, 3798367726]),
];
const COEFF_PROBE_TILE0: [u32; 4] = [1461123477, 2317529113, 1004244359, 3102047685];
const COEFF_PROBE_TILE3: [u32; 4] = [2272955061, 2986084877, 4130036541, 2293564949];

fn repository_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn reference_buffer() -> Vec<u8> {
    (0..(N_TILES * TILE_BYTES) as u64)
        .map(|i| ((i.wrapping_mul(2654435761) >> 7) & 0xFF) as u8)
        .collect()
}

fn buffer_tiles(buf: &[u8]) -> Vec<[u8; TILE_BYTES]> {
    buf.chunks_exact(TILE_BYTES)
        .map(|chunk| chunk.try_into().unwrap())
        .collect()
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn json_hash_list(hashes: &[Hash32], indent: &str) -> String {
    hashes
        .iter()
        .map(|hash| format!("{indent}\"{}\"", hex_bytes(hash)))
        .collect::<Vec<_>>()
        .join(",\n")
}

fn generate_conformance_fixture() -> String {
    let buffer = reference_buffer();
    let tiles = buffer_tiles(&buffer);
    let weight_leaves: Vec<Hash32> = tiles
        .iter()
        .enumerate()
        .map(|(index, tile)| weights_leaf(index as u64, tile))
        .collect();
    let weights_root = merkle_root(&weight_leaves);

    let challenge = [9u8; 32];
    let device_id = [3u8; 32];
    let slot_seed = derive_slot_seed(&challenge, &device_id);
    let coverage: [u64; 2] = [1, 3];
    let mut s_tiles: Vec<u32> = coverage
        .iter()
        .map(|&index| sketch_tile(slot_seed, index, &tiles[index as usize]))
        .collect();
    let honest_tile3 = s_tiles[1];
    s_tiles[1] ^= 0xBAD;
    let partial_leaves: Vec<Hash32> = coverage
        .iter()
        .zip(&s_tiles)
        .map(|(&index, &sketch)| partials_leaf(index, sketch))
        .collect();
    let partials_root = merkle_root(&partial_leaves);

    let sketch_cases = VECTOR_CASES
        .iter()
        .map(|(seed, values)| {
            format!(
                "    {{ \"slot_seed\": {seed}, \"per_tile\": [{}] }}",
                values
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");

    let proof_of =
        |leaves: &[Hash32], index: usize| json_hash_list(&merkle_proof(leaves, index), "        ");

    format!(
        r#"{{
  "scheme": {{
    "id": "{scheme_id}",
    "digest": "{scheme_digest}"
  }},
  "params": {{
    "tile_bytes": {tile_bytes},
    "tile_words": {tile_words},
    "golden32": "0x9e3779b9",
    "coverage_order": "strictly ascending tile index",
    "hash": "blake3",
    "note": "signature suite is a deployment choice outside the scheme id (ed25519 on Substrate, secp256k1/ecrecover on EVM)"
  }},
  "reference_buffer": {{
    "formula": "buf[i] = ((i * 2654435761) >> 7) & 0xFF, wrapping u64 arithmetic, i in 0..n_tiles*tile_bytes",
    "n_tiles": 4,
    "blake3": "{buffer_hash}"
  }},
  "coefficients": {{
    "note": "word_coeff(tile_seed(slot_seed, tile_idx), j); always odd",
    "slot_seed": 1,
    "tile0_first4": [{c0}],
    "tile3_first4": [{c3}]
  }},
  "sketches": [
{sketch_cases}
  ],
  "slot_seed_derivation": {{
    "global_challenge": "{challenge_hex}",
    "device_id": "{device_hex}",
    "slot_seed": {slot_seed}
  }},
  "weights_tree": {{
    "leaves": [
{weight_leaves_json}
    ],
    "root": "{weights_root_hex}"
  }},
  "ticket_chunks": {{
    "note": "ticket_chunk(model_id=weights_root, partials_root, slot_seed, index)",
    "index_0": "{chunk0}",
    "index_1": "{chunk1}"
  }},
  "audit_beacon": {{
    "epoch": 7,
    "entropy": "{beacon_entropy}",
    "beacon": "{beacon}"
  }},
  "tampered_commitment_scenario": {{
    "coverage": [1, 3],
    "honest_s_tile_for_tile_3": {honest_tile3},
    "committed_s_tiles": [{committed0}, {committed1}],
    "partials_leaves": [
{partials_leaves_json}
    ],
    "partials_root": "{partials_root_hex}",
    "opening_committed_tile_3": {{
      "leaf_index": 1,
      "proof": [
{opening_proof}
      ],
      "expected": "verifies; opened value {committed1} != recomputed {honest_tile3} => TileFraudProof verdict Fraud"
    }},
    "non_inclusion_tile_2": {{
      "left":  {{ "tile_idx": 1, "s_tile": {committed0}, "index": 0 }},
      "right": {{ "tile_idx": 3, "s_tile": {committed1}, "index": 1 }},
      "expected": "adjacent bracket verifies => proven not committed"
    }},
    "fraud_proof_tile_3": {{
      "tile_idx": 3,
      "claimed_s_tile": {committed1},
      "partials_index": 1,
      "partials_proof": [
{fraud_partials_proof}
      ],
      "tile_bytes": "generate tile 3 from reference_buffer.formula",
      "weights_proof": [
{fraud_weights_proof}
      ],
      "expected_verdict": "Fraud"
    }}
  }}
}}
"#,
        scheme_id = PORW_SCHEME_ID,
        scheme_digest = hex_bytes(&porw_scheme_digest()),
        tile_bytes = TILE_BYTES,
        tile_words = TILE_WORDS,
        buffer_hash = hex_bytes(blake3::hash(&buffer).as_bytes()),
        c0 = COEFF_PROBE_TILE0
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        c3 = COEFF_PROBE_TILE3
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        challenge_hex = hex_bytes(&challenge),
        device_hex = hex_bytes(&device_id),
        weight_leaves_json = json_hash_list(&weight_leaves, "      "),
        weights_root_hex = hex_bytes(&weights_root),
        chunk0 = hex_bytes(&ticket_chunk(&weights_root, &partials_root, slot_seed, 0)),
        chunk1 = hex_bytes(&ticket_chunk(&weights_root, &partials_root, slot_seed, 1)),
        beacon_entropy = hex_bytes(&[0xAB; 32]),
        beacon = hex_bytes(&audit_beacon(7, &[0xAB; 32])),
        committed0 = s_tiles[0],
        committed1 = s_tiles[1],
        partials_leaves_json = json_hash_list(&partial_leaves, "      "),
        partials_root_hex = hex_bytes(&partials_root),
        opening_proof = proof_of(&partial_leaves, 1),
        fraud_partials_proof = proof_of(&partial_leaves, 1),
        fraud_weights_proof = proof_of(&weight_leaves, 3),
    )
}

#[test]
fn generated_vector_matches_the_locked_repository_cache() {
    let generated = generate_conformance_fixture();
    let path = repository_root().join("spec-cache/conformance/porw/sketch-tile-v2.json");
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("locked conformance vector missing: {error}"));
    assert_eq!(
        committed, generated,
        "reference implementation differs from the locked conformance vector; \
         an intentional semantic change requires a new scheme id and a new \
         reviewed aigg-spec release"
    );
}
