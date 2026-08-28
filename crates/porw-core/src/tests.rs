//! Tests, including cross-language vectors generated from the independently
//! maintained Python reference (see `gpu/triton/`). The
//! deterministic buffer is `buf[i] = ((i * 2654435761) >> 7) & 0xFF` over
//! wrapping u64 arithmetic, 4 tiles.

use super::*;
#[cfg(feature = "scale")]
use alloc::vec;
#[cfg(feature = "scale")]
use parity_scale_codec::{Decode, Encode};

const N_TILES: usize = 4;

/// Per-tile sketches for slot seeds [1, 0xDEADBEEF, 0x9E3779B9], generated
/// by the Python/numpy reference implementation.
const VECTOR_CASES: [(u32, [u32; N_TILES]); 3] = [
    (1, [3485902744, 372182208, 1349964192, 38446344]),
    (
        0xDEAD_BEEF,
        [1557940684, 3400778530, 3931927942, 1241214034],
    ),
    (0x9E37_79B9, [1823348526, 1479624626, 958815834, 3798367726]),
];

/// First four per-word coefficients of tiles 0 and 3 at slot seed 1.
const COEFF_PROBE_TILE0: [u32; 4] = [1461123477, 2317529113, 1004244359, 3102047685];
const COEFF_PROBE_TILE3: [u32; 4] = [2272955061, 2986084877, 4130036541, 2293564949];

fn reference_buffer() -> Vec<u8> {
    (0..(N_TILES * TILE_BYTES) as u64)
        .map(|i| ((i.wrapping_mul(2654435761) >> 7) & 0xFF) as u8)
        .collect()
}

fn buffer_tiles(buf: &[u8]) -> Vec<[u8; TILE_BYTES]> {
    buf.chunks_exact(TILE_BYTES)
        .map(|c| c.try_into().unwrap())
        .collect()
}

#[test]
fn cross_language_sketch_vectors() {
    let tiles = buffer_tiles(&reference_buffer());
    for (seed, expected) in VECTOR_CASES {
        for (idx, tile) in tiles.iter().enumerate() {
            assert_eq!(
                sketch_tile(seed, idx as u64, tile),
                expected[idx],
                "seed {seed:#x} tile {idx}"
            );
        }
    }
}

#[test]
fn cross_language_coeff_vectors() {
    let r0 = tile_seed(1, 0);
    let r3 = tile_seed(1, 3);
    for j in 0..4u32 {
        assert_eq!(word_coeff(r0, j), COEFF_PROBE_TILE0[j as usize]);
        assert_eq!(word_coeff(r3, j), COEFF_PROBE_TILE3[j as usize]);
    }
}

#[test]
fn coefficients_are_odd() {
    let r = tile_seed(0xDEAD_BEEF, 7);
    for j in 0..TILE_WORDS as u32 {
        assert_eq!(word_coeff(r, j) & 1, 1);
    }
}

#[test]
fn a_single_bit_change_alters_the_linear_sketch() {
    let tiles = buffer_tiles(&reference_buffer());
    let baseline = sketch_tile(42, 0, &tiles[0]);
    // This limited single-delta property does not imply collision resistance.
    // Try every bit position of a few words plus a pseudo-random sample.
    let mut lcg = 0x1234_5678_u64;
    for trial in 0..256 {
        let (byte, bit) = if trial < 32 {
            (trial / 8, trial % 8)
        } else {
            lcg = lcg
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (
                ((lcg >> 33) as usize) % TILE_BYTES,
                ((lcg >> 29) as usize) % 8,
            )
        };
        let mut bad = tiles[0];
        bad[byte] ^= 1 << bit;
        assert_ne!(sketch_tile(42, 0, &bad), baseline, "byte {byte} bit {bit}");
    }
}

#[test]
fn two_word_msb_changes_cancel_in_the_linear_sketch_but_not_the_commitment() {
    let original = [0u8; TILE_BYTES];
    let mut changed = original;
    changed[3] = 0x80;
    changed[7] = 0x80;

    for slot_seed in [0, 1, 42, 0xDEAD_BEEF, u32::MAX] {
        for tile_idx in [0, 1, 7, u32::MAX as u64, u64::MAX] {
            assert_eq!(
                sketch_tile(slot_seed, tile_idx, &original),
                sketch_tile(slot_seed, tile_idx, &changed),
                "two MSB deltas cancel modulo 2^32 for seed {slot_seed:#x}, tile {tile_idx}"
            );
            assert_ne!(
                weights_leaf(tile_idx, &original),
                weights_leaf(tile_idx, &changed),
                "the cryptographic byte commitment still distinguishes the tiles"
            );
        }
    }
}

#[test]
fn merkle_proofs_roundtrip() {
    let tiles = buffer_tiles(&reference_buffer());
    let leaves: Vec<Hash32> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| weights_leaf(i as u64, t))
        .collect();
    let root = merkle_root(&leaves);
    for (i, leaf) in leaves.iter().enumerate() {
        let proof = merkle_proof(&leaves, i);
        assert!(merkle_verify(&root, leaf, i, &proof));
        // Wrong index or tampered leaf must fail.
        assert!(!merkle_verify(&root, leaf, i + 1, &proof) || leaves.len() == 1);
        let mut bad = *leaf;
        bad[0] ^= 1;
        assert!(!merkle_verify(&root, &bad, i, &proof));
    }
}

#[test]
fn counted_merkle_verification_accepts_complete_three_and_five_leaf_trees() {
    for leaf_count in [3usize, 5] {
        let leaves: Vec<Hash32> = (0..leaf_count)
            .map(|i| *blake3::hash(&(i as u64).to_le_bytes()).as_bytes())
            .collect();
        let root = merkle_root(&leaves);
        for (index, leaf) in leaves.iter().enumerate() {
            assert!(merkle_verify_counted(
                &root,
                leaf,
                index as u64,
                leaf_count as u64,
                &merkle_proof(&leaves, index),
            ));
        }
        assert!(!merkle_verify_counted(
            &root,
            &leaves[0],
            leaf_count as u64,
            leaf_count as u64,
            &merkle_proof(&leaves, 0),
        ));
    }
}

#[test]
fn counted_merkle_verification_rejects_invalid_counts_and_proof_lengths() {
    let leaves: Vec<Hash32> = (0..3u64)
        .map(|i| *blake3::hash(&i.to_le_bytes()).as_bytes())
        .collect();
    let root = merkle_root(&leaves);
    let proof = merkle_proof(&leaves, 1);

    assert!(!merkle_verify_counted(&root, &leaves[1], 0, 0, &proof));
    assert!(!merkle_verify_counted(&root, &leaves[1], 3, 3, &proof));

    let mut missing = proof.clone();
    missing.pop();
    assert!(!merkle_verify_counted(&root, &leaves[1], 1, 3, &missing));

    let mut extra = proof;
    extra.push([0u8; 32]);
    assert!(!merkle_verify_counted(&root, &leaves[1], 1, 3, &extra));
}

#[test]
fn counted_merkle_verification_rejects_wrong_duplicate_last_siblings() {
    let leaves: Vec<Hash32> = (0..5u64)
        .map(|i| *blake3::hash(&i.to_le_bytes()).as_bytes())
        .collect();
    let root = merkle_root(&leaves);
    let mut proof = merkle_proof(&leaves, 4);
    assert!(merkle_verify_counted(&root, &leaves[4], 4, 5, &proof));

    proof[0][0] ^= 1;
    assert!(!merkle_verify_counted(&root, &leaves[4], 4, 5, &proof));

    let mut proof = merkle_proof(&leaves, 4);
    proof[1][0] ^= 1;
    assert!(!merkle_verify_counted(&root, &leaves[4], 4, 5, &proof));
}

#[test]
fn envelope_and_tickets() {
    // 70 GB coverage swept 3.2x against a 240 GB/slot envelope: allowed.
    let cov = 70_u64 << 30;
    assert!(check_envelope(cov, 3200, 240 * (1 << 30)));
    // Claiming 4x against the same envelope: rejected.
    assert!(!check_envelope(cov, 4000, 240 * (1 << 30)));
    // Tickets scale linearly with coverage and multiplier.
    let unit = 1 << 30;
    assert_eq!(ticket_count(cov, 1000, unit), 70);
    assert_eq!(ticket_count(cov, 2000, unit), 140);
    // Distinct chunk indexes, slot seeds and models yield distinct tickets.
    let model = [3u8; 32];
    let root = [7u8; 32];
    assert_ne!(
        ticket_chunk(&model, &root, 1, 0),
        ticket_chunk(&model, &root, 1, 1)
    );
    assert_ne!(
        ticket_chunk(&model, &root, 1, 0),
        ticket_chunk(&model, &root, 2, 0)
    );
    let model2 = [4u8; 32];
    assert_ne!(
        ticket_chunk(&model, &root, 1, 0),
        ticket_chunk(&model2, &root, 1, 0)
    );
}

fn build_solution_and_proofs(
    tamper_tile: Option<usize>,
) -> (PorwSolution, [u8; 32], Hash32, Vec<TileFraudProof>) {
    let challenge = [9u8; 32];
    let device_id = [3u8; 32];
    let slot_seed = derive_slot_seed(&challenge, &device_id);
    let tiles = buffer_tiles(&reference_buffer());

    let weight_leaves: Vec<Hash32> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| weights_leaf(i as u64, t))
        .collect();
    let model_root = merkle_root(&weight_leaves);

    let mut s_tiles: Vec<u32> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| sketch_tile(slot_seed, i as u64, t))
        .collect();
    if let Some(i) = tamper_tile {
        s_tiles[i] ^= 0xBAD; // the accused commits a wrong per-tile value
    }
    let partial_leaves: Vec<Hash32> = s_tiles
        .iter()
        .enumerate()
        .map(|(i, s)| partials_leaf(i as u64, *s))
        .collect();
    let partials_root = merkle_root(&partial_leaves);

    let solution = PorwSolution {
        device_id,
        model_id: model_root,
        sketch: s_tiles.iter().fold(0u32, |a, s| a.wrapping_add(*s)),
        partials_root,
        coverage_bytes: (N_TILES * TILE_BYTES) as u64,
        m_t_millis: 1000,
        chunk_index: 0,
        signature: [0u8; 64],
    };

    let proofs = (0..N_TILES)
        .map(|i| TileFraudProof {
            tile_idx: i as u64,
            claimed_s_tile: s_tiles[i],
            partials_index: i as u64,
            partials_proof: merkle_proof(&partial_leaves, i),
            tile_bytes: tiles[i].to_vec(),
            weights_proof: merkle_proof(&weight_leaves, i),
        })
        .collect();

    (solution, challenge, model_root, proofs)
}

#[test]
fn fraud_proof_honest_solution_shows_no_fraud() {
    let (solution, challenge, model_root, proofs) = build_solution_and_proofs(None);
    for proof in &proofs {
        assert_eq!(
            verify_tile_fraud_proof(&solution, &challenge, &model_root, N_TILES as u64, proof),
            FraudVerdict::NoFraud
        );
    }
}

#[test]
fn fraud_proof_catches_tampered_commitment() {
    let (solution, challenge, model_root, proofs) = build_solution_and_proofs(Some(2));
    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[2],
        ),
        FraudVerdict::Fraud
    );
    // Untampered tiles remain clean.
    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[0],
        ),
        FraudVerdict::NoFraud
    );
}

#[test]
fn fraud_proof_rejects_malformed_evidence() {
    let (solution, challenge, model_root, mut proofs) = build_solution_and_proofs(None);
    // Tile bytes that do not authenticate under R_W.
    proofs[1].tile_bytes[0] ^= 1;
    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[1],
        ),
        FraudVerdict::Invalid
    );
    // Wrong length.
    proofs[0].tile_bytes.pop();
    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[0],
        ),
        FraudVerdict::Invalid
    );
    // Broken partials path.
    proofs[3].partials_proof[0][0] ^= 1;
    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[3],
        ),
        FraudVerdict::Invalid
    );
}

#[test]
fn fraud_proof_rejects_unbound_or_invalid_tree_context() {
    let (solution, challenge, model_root, proofs) = build_solution_and_proofs(None);

    let mut single_leaf_proof = proofs[0].clone();
    single_leaf_proof.weights_proof.clear();
    let tile: &[u8; TILE_BYTES] = single_leaf_proof.tile_bytes.as_slice().try_into().unwrap();
    let unbound_root = weights_leaf(0, tile);
    assert_ne!(unbound_root, solution.model_id);
    assert_eq!(
        verify_tile_fraud_proof(&solution, &challenge, &unbound_root, 1, &single_leaf_proof),
        FraudVerdict::Invalid
    );

    let mut zero_coverage = solution.clone();
    zero_coverage.coverage_bytes = 0;
    assert_eq!(
        verify_tile_fraud_proof(
            &zero_coverage,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[0],
        ),
        FraudVerdict::Invalid
    );

    let mut misaligned_coverage = solution.clone();
    misaligned_coverage.coverage_bytes += 1;
    assert_eq!(
        verify_tile_fraud_proof(
            &misaligned_coverage,
            &challenge,
            &model_root,
            N_TILES as u64,
            &proofs[0],
        ),
        FraudVerdict::Invalid
    );

    assert_eq!(
        verify_tile_fraud_proof(
            &solution,
            &challenge,
            &model_root,
            (N_TILES - 1) as u64,
            &proofs[N_TILES - 1],
        ),
        FraudVerdict::Invalid
    );
}

#[test]
fn fraud_proof_works_for_non_contiguous_coverage() {
    // MoE-style coverage: tile 3 committed at partials position 1. Before
    // `partials_index` was added the verifier used tile_idx as the leaf
    // position, so an honest proof against a sparse coverage set could not
    // verify at all.
    let challenge = [9u8; 32];
    let device_id = [3u8; 32];
    let slot_seed = derive_slot_seed(&challenge, &device_id);
    let tiles = buffer_tiles(&reference_buffer());
    let weight_leaves: Vec<Hash32> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| weights_leaf(i as u64, t))
        .collect();
    let model_root = merkle_root(&weight_leaves);

    let coverage: [u64; 2] = [1, 3];
    let mut s_tiles: Vec<u32> = coverage
        .iter()
        .map(|&i| sketch_tile(slot_seed, i, &tiles[i as usize]))
        .collect();
    s_tiles[1] ^= 0xBAD; // tamper the value committed for tile 3
    let partial_leaves: Vec<Hash32> = coverage
        .iter()
        .zip(&s_tiles)
        .map(|(&i, &s)| partials_leaf(i, s))
        .collect();
    let solution = PorwSolution {
        device_id,
        model_id: model_root,
        sketch: s_tiles.iter().fold(0u32, |a, s| a.wrapping_add(*s)),
        partials_root: merkle_root(&partial_leaves),
        coverage_bytes: (coverage.len() * TILE_BYTES) as u64,
        m_t_millis: 1000,
        chunk_index: 0,
        signature: [0u8; 64],
    };

    let proof = TileFraudProof {
        tile_idx: 3,
        claimed_s_tile: s_tiles[1],
        partials_index: 1, // coverage-order position, not the tile index
        partials_proof: merkle_proof(&partial_leaves, 1),
        tile_bytes: tiles[3].to_vec(),
        weights_proof: merkle_proof(&weight_leaves, 3),
    };
    assert_eq!(
        verify_tile_fraud_proof(&solution, &challenge, &model_root, N_TILES as u64, &proof),
        FraudVerdict::Fraud
    );

    // Lying about the position: the leaf hash binds tile_idx, so the proof
    // simply fails to verify — it cannot shift blame across tiles.
    let mut shifted = proof.clone();
    shifted.partials_index = 0;
    assert_eq!(
        verify_tile_fraud_proof(&solution, &challenge, &model_root, N_TILES as u64, &shifted),
        FraudVerdict::Invalid
    );
}

#[test]
fn audit_assignment_is_deterministic_and_excludes_target() {
    let beacon = audit_beacon(7, &[0xAB; 32]);
    let model = [5u8; 32];
    let replicas: Vec<Hash32> = (0u8..6).map(|i| [i; 32]).collect();
    let target = replicas[2];

    let a = select_auditors(&beacon, &model, &target, &replicas, 3);
    let b = select_auditors(&beacon, &model, &target, &replicas, 3);
    assert_eq!(a, b, "assignment must be a pure function of the beacon");
    assert_eq!(a.len(), 3);
    assert!(!a.contains(&target), "a device never audits itself");
    // A different beacon reshuffles the panel (overwhelmingly likely).
    let other = select_auditors(&audit_beacon(8, &[0xAB; 32]), &model, &target, &replicas, 3);
    assert_ne!(a, other);
    // Fewer peers than k: everyone else is assigned.
    let small = select_auditors(&beacon, &model, &target, &replicas[2..4], 3);
    assert_eq!(small.len(), 1, "target excluded, one peer remains");
    // No peers at all (single-replica model): empty panel.
    let none = select_auditors(&beacon, &model, &target, &[target], 3);
    assert!(none.is_empty());
}

#[test]
fn audit_tile_sample_is_deterministic_distinct_and_bounded() {
    let beacon = audit_beacon(7, &[0xAB; 32]);
    let (model, target, auditor) = ([5u8; 32], [2u8; 32], [1u8; 32]);

    let s = audit_tile_sample(&beacon, &model, &target, &auditor, 1000, 32);
    assert_eq!(
        s,
        audit_tile_sample(&beacon, &model, &target, &auditor, 1000, 32)
    );
    assert_eq!(s.len(), 32);
    assert!(s.iter().all(|&i| i < 1000));
    let mut dedup = s.clone();
    dedup.sort_unstable();
    dedup.dedup();
    assert_eq!(dedup.len(), 32, "sampled tiles must be distinct");

    // Different auditors of the same target sample different tiles
    // (overwhelmingly likely), widening combined coverage.
    let other = audit_tile_sample(&beacon, &model, &target, &[9u8; 32], 1000, 32);
    assert_ne!(s, other);

    // Requesting at least as many tiles as exist audits everything.
    assert_eq!(
        audit_tile_sample(&beacon, &model, &target, &auditor, 8, 32),
        (0..8).collect::<Vec<u64>>()
    );
    assert!(audit_tile_sample(&beacon, &model, &target, &auditor, 0, 4).is_empty());
}

#[test]
fn opening_responses_prove_commitment_and_non_commitment() {
    // Strictly ascending sparse coverage over tiles {1, 3}; challenged tiles
    // 0 (before), 2 (between), 3 (committed), 5 (after).
    let challenge = [9u8; 32];
    let device_id = [3u8; 32];
    let slot_seed = derive_slot_seed(&challenge, &device_id);
    let tiles = buffer_tiles(&reference_buffer());
    let coverage: [u64; 2] = [1, 3];
    let s_tiles: Vec<u32> = coverage
        .iter()
        .map(|&i| sketch_tile(slot_seed, i, &tiles[i as usize]))
        .collect();
    let leaves: Vec<Hash32> = coverage
        .iter()
        .zip(&s_tiles)
        .map(|(&i, &s)| partials_leaf(i, s))
        .collect();
    let root = merkle_root(&leaves);
    let n_leaves = leaves.len() as u64;
    let wit = |pos: usize| LeafWitness {
        tile_idx: coverage[pos],
        s_tile: s_tiles[pos],
        index: pos as u64,
        proof: merkle_proof(&leaves, pos),
    };

    // Committed tile: opening verifies and returns the committed value.
    assert_eq!(
        verify_opening_response(&root, n_leaves, 3, &OpeningResponse::Committed(wit(1))),
        Ok(Some(s_tiles[1]))
    );
    // Claiming the wrong tile with a real leaf fails.
    assert_eq!(
        verify_opening_response(&root, n_leaves, 2, &OpeningResponse::Committed(wit(1))),
        Err(())
    );

    // Between two committed leaves: bracketed non-inclusion.
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            2,
            &OpeningResponse::NotCommitted {
                left: Some(wit(0)),
                right: Some(wit(1)),
            }
        ),
        Ok(None)
    );
    // Before the first leaf.
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            0,
            &OpeningResponse::NotCommitted {
                left: None,
                right: Some(wit(0)),
            }
        ),
        Ok(None)
    );
    // After the last leaf.
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            5,
            &OpeningResponse::NotCommitted {
                left: Some(wit(1)),
                right: None,
            }
        ),
        Ok(None)
    );

    // A committed tile cannot be denied: any non-inclusion shape around it
    // fails (tile 3 IS the last leaf; claiming "after last" needs
    // l.tile_idx < challenged which fails, bracketing fails adjacency/order).
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            3,
            &OpeningResponse::NotCommitted {
                left: Some(wit(1)),
                right: None,
            }
        ),
        Err(())
    );
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            3,
            &OpeningResponse::NotCommitted {
                left: Some(wit(0)),
                right: Some(wit(1)),
            }
        ),
        Err(())
    );
    // Non-adjacent bracket is rejected (hiding a leaf between them).
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            2,
            &OpeningResponse::NotCommitted {
                left: Some(wit(0)),
                right: Some(LeafWitness { index: 2, ..wit(1) }),
            }
        ),
        Err(())
    );
    // Empty answer never verifies.
    assert_eq!(
        verify_opening_response(
            &root,
            n_leaves,
            2,
            &OpeningResponse::NotCommitted {
                left: None,
                right: None,
            }
        ),
        Err(())
    );
}

#[test]
fn opening_response_enforces_counted_odd_tree_shape() {
    let entries = [(1u64, 11u32), (3, 33), (5, 55)];
    let leaves: Vec<Hash32> = entries
        .iter()
        .map(|&(tile_idx, s_tile)| partials_leaf(tile_idx, s_tile))
        .collect();
    let root = merkle_root(&leaves);
    let witness = LeafWitness {
        tile_idx: entries[2].0,
        s_tile: entries[2].1,
        index: 2,
        proof: merkle_proof(&leaves, 2),
    };
    assert_eq!(
        verify_opening_response(
            &root,
            entries.len() as u64,
            entries[2].0,
            &OpeningResponse::Committed(witness.clone()),
        ),
        Ok(Some(entries[2].1))
    );

    let mut wrong_duplicate = witness.clone();
    wrong_duplicate.proof[0][0] ^= 1;
    assert_eq!(
        verify_opening_response(
            &root,
            entries.len() as u64,
            entries[2].0,
            &OpeningResponse::Committed(wrong_duplicate),
        ),
        Err(())
    );

    let mut extra = witness;
    extra.proof.push([0u8; 32]);
    assert_eq!(
        verify_opening_response(
            &root,
            entries.len() as u64,
            entries[2].0,
            &OpeningResponse::Committed(extra),
        ),
        Err(())
    );
}

#[test]
fn opening_response_rejects_overflowing_witness_indices_without_panicking() {
    let overflow = LeafWitness {
        tile_idx: 0,
        s_tile: 0,
        index: u64::MAX,
        proof: Vec::new(),
    };
    let right = LeafWitness {
        tile_idx: 2,
        s_tile: 0,
        index: 0,
        proof: Vec::new(),
    };
    let root = [0u8; 32];

    assert_eq!(
        verify_opening_response(
            &root,
            1,
            1,
            &OpeningResponse::NotCommitted {
                left: Some(overflow.clone()),
                right: Some(right),
            },
        ),
        Err(())
    );
    assert_eq!(
        verify_opening_response(
            &root,
            1,
            1,
            &OpeningResponse::NotCommitted {
                left: Some(overflow),
                right: None,
            },
        ),
        Err(())
    );
}

#[test]
fn scheme_id_is_stable() {
    // Pinned by ExecutionProfile.porw_scheme_id / IPoRWVerifier.schemeId()
    // in aigg-spec; a semantic change to the sketch is a NEW id, so this
    // constant must never drift for the v2 semantics.
    assert_eq!(PORW_SCHEME_ID, "aigg:porw:sketch-tile:v2");
    assert_eq!(
        porw_scheme_digest(),
        *blake3::hash(PORW_SCHEME_ID.as_bytes()).as_bytes()
    );
}

// Frozen from the pre-extraction `subspace-proof-of-residency` implementation
// at 8d8569004c2322aabe26cd59c12bbfe7dc4de1a1. These literals are deliberately
// not generated by the implementation under test.
#[cfg(feature = "scale")]
fn scale_golden_bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(core::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid frozen hex")
        })
        .collect()
}

#[cfg(feature = "scale")]
fn assert_scale_golden<T>(value: &T, frozen_hex: &str)
where
    T: Encode + Decode + PartialEq + core::fmt::Debug,
{
    let expected = scale_golden_bytes(frozen_hex);
    assert_eq!(value.encode(), expected, "SCALE bytes drifted");

    let mut input = expected.as_slice();
    assert_eq!(T::decode(&mut input).expect("golden must decode"), *value);
    assert!(input.is_empty(), "golden decoder must consume every byte");

    let mut truncated = &expected[..expected.len() - 1];
    assert!(
        T::decode(&mut truncated).is_err(),
        "truncated golden encoding must fail"
    );
}

#[cfg(feature = "scale")]
fn scale_golden_solution() -> PorwSolution {
    PorwSolution {
        device_id: [0x11; 32],
        model_id: [0x22; 32],
        sketch: 0x4433_2211,
        partials_root: [0x33; 32],
        coverage_bytes: 0x0102_0304_0506_0708,
        m_t_millis: 0x1112_1314_1516_1718,
        chunk_index: 0x2122_2324_2526_2728,
        signature: [0x44; 64],
    }
}

#[cfg(feature = "scale")]
fn scale_golden_witness() -> LeafWitness {
    LeafWitness {
        tile_idx: 0x2122_2324_2526_2728,
        s_tile: 0x5566_7788,
        index: 0x3132_3334_3536_3738,
        proof: vec![[0x88; 32], [0x99; 32]],
    }
}

#[test]
#[cfg(feature = "scale")]
fn porw_solution_scale_bytes_match_pre_extraction_golden() {
    assert_scale_golden(
        &scale_golden_solution(),
        concat!(
            "1111111111111111111111111111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222222222222222222222222222",
            "11223344",
            "3333333333333333333333333333333333333333333333333333333333333333",
            "080706050403020118171615141312112827262524232221",
            "4444444444444444444444444444444444444444444444444444444444444444",
            "4444444444444444444444444444444444444444444444444444444444444444",
        ),
    );
}

#[test]
#[cfg(feature = "scale")]
fn tile_fraud_proof_scale_bytes_match_pre_extraction_golden() {
    let value = TileFraudProof {
        tile_idx: 0x0102_0304_0506_0708,
        claimed_s_tile: 0x1122_3344,
        partials_index: 0x1112_1314_1516_1718,
        partials_proof: vec![[0x55; 32], [0x66; 32]],
        tile_bytes: vec![0xaa, 0xbb, 0xcc, 0xdd],
        weights_proof: vec![[0x77; 32]],
    };
    assert_scale_golden(
        &value,
        concat!(
            "080706050403020144332211181716151413121108",
            "5555555555555555555555555555555555555555555555555555555555555555",
            "6666666666666666666666666666666666666666666666666666666666666666",
            "10aabbccdd04",
            "7777777777777777777777777777777777777777777777777777777777777777",
        ),
    );
}

#[test]
#[cfg(feature = "scale")]
fn leaf_witness_scale_bytes_match_pre_extraction_golden() {
    assert_scale_golden(
        &scale_golden_witness(),
        concat!(
            "282726252423222188776655383736353433323108",
            "8888888888888888888888888888888888888888888888888888888888888888",
            "9999999999999999999999999999999999999999999999999999999999999999",
        ),
    );
}

#[test]
#[cfg(feature = "scale")]
fn committed_opening_response_scale_bytes_match_pre_extraction_golden() {
    let value = OpeningResponse::Committed(scale_golden_witness());
    assert_scale_golden(
        &value,
        concat!(
            "00",
            "282726252423222188776655383736353433323108",
            "8888888888888888888888888888888888888888888888888888888888888888",
            "9999999999999999999999999999999999999999999999999999999999999999",
        ),
    );
}

#[test]
#[cfg(feature = "scale")]
fn not_committed_opening_response_scale_bytes_match_pre_extraction_golden() {
    let value = OpeningResponse::NotCommitted {
        left: Some(scale_golden_witness()),
        right: None,
    };
    assert_scale_golden(
        &value,
        concat!(
            "0101",
            "282726252423222188776655383736353433323108",
            "8888888888888888888888888888888888888888888888888888888888888888",
            "9999999999999999999999999999999999999999999999999999999999999999",
            "00",
        ),
    );

    let mut invalid_variant = &[2u8][..];
    assert!(OpeningResponse::decode(&mut invalid_variant).is_err());
}

// ---------------------------------------------------------------------------
// Cross-language conformance fixtures (aigg-spec §15)
// ---------------------------------------------------------------------------
//
// The locked root cache is the vector set an independent
// implementation (e.g. the Solidity verifier of the EVM deployment) must
// reproduce bit-for-bit. This test regenerates the fixture content from the
// chain-neutral reference implementation and fails if it differs from the
// read-only cached bytes. Cache promotion happens in aigg-spec, never here.

#[cfg(feature = "repository-conformance")]
fn hex_bytes(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(feature = "repository-conformance")]
fn json_hash_list(hashes: &[Hash32], indent: &str) -> String {
    hashes
        .iter()
        .map(|h| format!("{indent}\"{}\"", hex_bytes(h)))
        .collect::<Vec<_>>()
        .join(",\n")
}

#[cfg(feature = "repository-conformance")]
fn generate_conformance_fixture() -> String {
    let tiles = buffer_tiles(&reference_buffer());
    let buffer = reference_buffer();

    // Weights tree over the full 4-tile reference model.
    let weight_leaves: Vec<Hash32> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| weights_leaf(i as u64, t))
        .collect();
    let weights_root = merkle_root(&weight_leaves);

    // Scenario: device commits sparse ascending coverage {1, 3} with the
    // value for tile 3 tampered (matches the fraud-proof unit tests).
    let challenge = [9u8; 32];
    let device_id = [3u8; 32];
    let slot_seed = derive_slot_seed(&challenge, &device_id);
    let coverage: [u64; 2] = [1, 3];
    let mut s_tiles: Vec<u32> = coverage
        .iter()
        .map(|&i| sketch_tile(slot_seed, i, &tiles[i as usize]))
        .collect();
    let honest_tile3 = s_tiles[1];
    s_tiles[1] ^= 0xBAD;
    let partial_leaves: Vec<Hash32> = coverage
        .iter()
        .zip(&s_tiles)
        .map(|(&i, &s)| partials_leaf(i, s))
        .collect();
    let partials_root = merkle_root(&partial_leaves);

    let sketch_cases = VECTOR_CASES
        .iter()
        .map(|(seed, values)| {
            format!(
                "    {{ \"slot_seed\": {seed}, \"per_tile\": [{}] }}",
                values
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");

    let proof_of = |leaves: &[Hash32], i: usize| {
        let p = merkle_proof(leaves, i);
        json_hash_list(&p, "        ")
    };

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
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", "),
        c3 = COEFF_PROBE_TILE3
            .iter()
            .map(|v| v.to_string())
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
#[cfg(feature = "repository-conformance")]
fn conformance_fixture_is_current() {
    let generated = generate_conformance_fixture();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec-cache/conformance/porw/sketch-tile-v2.json"
    );
    let committed = std::fs::read_to_string(path).expect("locked conformance vector missing");
    assert_eq!(
        committed, generated,
        "reference implementation differs from the locked conformance vector; \
         an intentional semantic change requires a new scheme id and a new \
         reviewed aigg-spec release"
    );
}
