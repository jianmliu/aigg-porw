"""Independent Python conformance checks for the locked PoRW v2 vector.

These tests deliberately implement the NumPy/BLAKE3 reference logic locally.
They do not import the Rust, Solidity, or Triton implementations.  The locked
vector contains proof-math fixtures only; deployment admission, identity,
deadline, and boundary non-inclusion policy are outside its scope.
"""

import json
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from blake3 import blake3


REPO_ROOT = Path(__file__).resolve().parents[3]
VECTOR_PATH = REPO_ROOT / "spec-cache/conformance/porw/sketch-tile-v2.json"
MASK32 = np.uint64(0xFFFFFFFF)
MASK64 = 0xFFFFFFFFFFFFFFFF
FMIX_M1 = np.uint64(0x85EBCA6B)
FMIX_M2 = np.uint64(0xC2B2AE35)


def _vector() -> dict:
    with VECTOR_PATH.open(encoding="utf-8") as stream:
        return json.load(stream)


def _unhex(value: str) -> bytes:
    return bytes.fromhex(value.removeprefix("0x"))


def _hex(value: bytes) -> str:
    return "0x" + value.hex()


def _reference_buffer(vector: dict) -> bytes:
    length = vector["reference_buffer"]["n_tiles"] * vector["params"]["tile_bytes"]
    return bytes(
        ((((index * 2654435761) & MASK64) >> 7) & 0xFF)
        for index in range(length)
    )


def _fmix32(value):
    value = np.asarray(value, dtype=np.uint64) & MASK32
    value = (value ^ (value >> np.uint64(16))) & MASK32
    value = (value * FMIX_M1) & MASK32
    value = (value ^ (value >> np.uint64(13))) & MASK32
    value = (value * FMIX_M2) & MASK32
    return (value ^ (value >> np.uint64(16))) & MASK32


def _tile_coeffs(slot_seed: int, tile_indices) -> np.ndarray:
    tile_indices = np.asarray(tile_indices, dtype=np.uint64)
    tile_seed = _fmix32(_fmix32(np.uint64(slot_seed) ^ tile_indices))
    words = np.arange(1024, dtype=np.uint64)
    return _fmix32(tile_seed[..., None] + ((words * np.uint64(0x9E3779B9)) & MASK32)) | 1


def _sketch_tiles(
    slot_seed: int,
    buffer: bytes,
    tile_bytes: int,
    tile_indices=None,
) -> np.ndarray:
    words = np.frombuffer(buffer, dtype="<u4").astype(np.uint64)
    words = words.reshape(-1, tile_bytes // 4)
    if tile_indices is None:
        tile_indices = np.arange(words.shape[0], dtype=np.uint64)
    coefficients = _tile_coeffs(slot_seed, tile_indices)
    return (coefficients * words).sum(axis=1) & MASK32


def _weights_leaf(tile_index: int, tile: bytes) -> bytes:
    return blake3(tile_index.to_bytes(8, "little") + tile).digest()


def _partials_leaf(tile_index: int, sketch: int) -> bytes:
    return blake3(
        tile_index.to_bytes(8, "little") + sketch.to_bytes(4, "little")
    ).digest()


def _merkle_parent(left: bytes, right: bytes) -> bytes:
    return blake3(left + right).digest()


def _merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        return blake3(b"").digest()
    level = list(leaves)
    while len(level) > 1:
        level = [
            _merkle_parent(level[index], level[index + 1] if index + 1 < len(level) else level[index])
            for index in range(0, len(level), 2)
        ]
    return level[0]


def _merkle_proof(leaves: list[bytes], index: int) -> list[bytes]:
    if not leaves or index < 0 or index >= len(leaves):
        raise ValueError("Merkle proof index is outside the tree")
    proof = []
    level = list(leaves)
    while len(level) > 1:
        sibling_index = index - 1 if index % 2 else index + 1
        proof.append(level[sibling_index] if sibling_index < len(level) else level[index])
        level = [
            _merkle_parent(
                level[level_index],
                level[level_index + 1]
                if level_index + 1 < len(level)
                else level[level_index],
            )
            for level_index in range(0, len(level), 2)
        ]
        index //= 2
    return proof


def _merkle_verify_counted(
    root: bytes, leaf: bytes, index: int, leaf_count: int, proof: list[bytes]
) -> bool:
    if leaf_count <= 0 or index < 0 or index >= leaf_count:
        return False
    accumulator = leaf
    width = leaf_count
    proof_index = 0
    while width > 1:
        if proof_index >= len(proof):
            return False
        sibling = proof[proof_index]
        if index % 2 == 0:
            if index + 1 == width and sibling != accumulator:
                return False
            accumulator = _merkle_parent(accumulator, sibling)
        else:
            accumulator = _merkle_parent(sibling, accumulator)
        index //= 2
        width = (width + 1) // 2
        proof_index += 1
    return proof_index == len(proof) and accumulator == root


def _verify_committed_opening(
    *,
    root: bytes,
    leaf_count: int,
    challenged_tile: int,
    tile_index: int,
    sketch: int,
    index: int,
    proof: list[bytes],
) -> bool:
    return tile_index == challenged_tile and _merkle_verify_counted(
        root,
        _partials_leaf(tile_index, sketch),
        index,
        leaf_count,
        proof,
    )


def _verify_interior_non_inclusion(
    *,
    root: bytes,
    leaf_count: int,
    challenged_tile: int,
    left: dict,
    right: dict,
    left_proof: list[bytes],
    right_proof: list[bytes],
) -> bool:
    left_index = left["index"]
    right_index = right["index"]
    if not (0 <= left_index < leaf_count and 0 <= right_index < leaf_count):
        return False
    if left_index + 1 != right_index:
        return False
    if not left["tile_idx"] < challenged_tile < right["tile_idx"]:
        return False
    left_leaf = _partials_leaf(left["tile_idx"], left["s_tile"])
    right_leaf = _partials_leaf(right["tile_idx"], right["s_tile"])
    return _merkle_verify_counted(
        root, left_leaf, left_index, leaf_count, left_proof
    ) and _merkle_verify_counted(
        root, right_leaf, right_index, leaf_count, right_proof
    )


def _fraud_verdict(
    *,
    partials_root: bytes,
    weights_root: bytes,
    challenge: bytes,
    device_id: bytes,
    tile_index: int,
    claimed_sketch: int,
    partials_index: int,
    partials_proof: list[bytes],
    tile: bytes,
    weights_proof: list[bytes],
) -> str:
    if not _merkle_verify_counted(
        partials_root,
        _partials_leaf(tile_index, claimed_sketch),
        partials_index,
        2,
        partials_proof,
    ):
        return "Invalid"
    if not _merkle_verify_counted(
        weights_root,
        _weights_leaf(tile_index, tile),
        tile_index,
        4,
        weights_proof,
    ):
        return "Invalid"
    slot_seed = int.from_bytes(blake3(challenge + device_id).digest()[:4], "little")
    true_sketch = int(
        _sketch_tiles(slot_seed, tile, len(tile), np.array([tile_index], dtype=np.uint64))[0]
    )
    return "NoFraud" if claimed_sketch == true_sketch else "Fraud"


def test_vector_is_loaded_from_repository_root_and_scheme_is_exact():
    vector = _vector()
    assert VECTOR_PATH.is_file()
    assert vector["scheme"]["id"] == "aigg:porw:sketch-tile:v2"
    assert _hex(blake3(vector["scheme"]["id"].encode()).digest()) == vector["scheme"]["digest"]
    assert vector["params"] == {
        "tile_bytes": 4096,
        "tile_words": 1024,
        "golden32": "0x9e3779b9",
        "coverage_order": "strictly ascending tile index",
        "hash": "blake3",
        "note": "signature suite is a deployment choice outside the scheme id (ed25519 on Substrate, secp256k1/ecrecover on EVM)",
    }


def test_reference_buffer_matches_locked_hash():
    vector = _vector()
    buffer = _reference_buffer(vector)
    assert len(buffer) == 4 * 4096
    assert _hex(blake3(buffer).digest()) == vector["reference_buffer"]["blake3"]


def test_coefficients_match_locked_probes_and_are_odd():
    vector = _vector()
    fixture = vector["coefficients"]
    coefficients = _tile_coeffs(fixture["slot_seed"], np.array([0, 3], dtype=np.uint64))
    assert coefficients[0, :4].tolist() == fixture["tile0_first4"]
    assert coefficients[1, :4].tolist() == fixture["tile3_first4"]
    assert np.all((coefficients & 1) == 1)


def test_all_sketch_cases_match_locked_vector():
    vector = _vector()
    buffer = _reference_buffer(vector)
    for case in vector["sketches"]:
        sketches = _sketch_tiles(case["slot_seed"], buffer, vector["params"]["tile_bytes"])
        assert sketches.tolist() == case["per_tile"]


def test_slot_seed_ticket_chunks_and_audit_beacon_match():
    vector = _vector()
    seed_fixture = vector["slot_seed_derivation"]
    challenge = _unhex(seed_fixture["global_challenge"])
    device_id = _unhex(seed_fixture["device_id"])
    slot_seed = int.from_bytes(blake3(challenge + device_id).digest()[:4], "little")
    assert slot_seed == seed_fixture["slot_seed"]

    weights_root = _unhex(vector["weights_tree"]["root"])
    partials_root = _unhex(vector["tampered_commitment_scenario"]["partials_root"])
    ticket_input = weights_root + partials_root + slot_seed.to_bytes(4, "little")
    assert _hex(blake3(ticket_input).digest(length=32, seek=0)) == vector["ticket_chunks"]["index_0"]
    assert _hex(blake3(ticket_input).digest(length=32, seek=32)) == vector["ticket_chunks"]["index_1"]

    beacon_fixture = vector["audit_beacon"]
    beacon_input = (
        b"porw-cross-audit-v1"
        + _unhex(beacon_fixture["entropy"])
        + beacon_fixture["epoch"].to_bytes(8, "little")
    )
    assert _hex(blake3(beacon_input).digest()) == beacon_fixture["beacon"]


def test_weights_leaves_and_root_match_locked_tree():
    vector = _vector()
    tile_bytes = vector["params"]["tile_bytes"]
    buffer = _reference_buffer(vector)
    tiles = [buffer[offset : offset + tile_bytes] for offset in range(0, len(buffer), tile_bytes)]
    leaves = [_weights_leaf(index, tile) for index, tile in enumerate(tiles)]
    assert [_hex(leaf) for leaf in leaves] == vector["weights_tree"]["leaves"]
    assert _hex(_merkle_root(leaves)) == vector["weights_tree"]["root"]


def test_counted_merkle_rejects_negative_index_and_nonpositive_leaf_count():
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    leaves = [_unhex(value) for value in fixture["partials_leaves"]]
    root = _unhex(fixture["partials_root"])
    assert not _merkle_verify_counted(root, leaves[1], -1, 2, [leaves[0]])
    assert not _merkle_verify_counted(root, leaves[0], 0, 0, [])
    assert not _merkle_verify_counted(root, leaves[0], 0, -1, [])


def test_partials_tree_committed_opening_and_interior_non_inclusion_match():
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    leaves = [
        _partials_leaf(tile_index, sketch)
        for tile_index, sketch in zip(fixture["coverage"], fixture["committed_s_tiles"], strict=True)
    ]
    assert [_hex(leaf) for leaf in leaves] == fixture["partials_leaves"]
    root = _merkle_root(leaves)
    assert _hex(root) == fixture["partials_root"]

    opening = fixture["opening_committed_tile_3"]
    opening_proof = [_unhex(value) for value in opening["proof"]]
    opened_tile = fixture["coverage"][opening["leaf_index"]]
    opened_sketch = fixture["committed_s_tiles"][opening["leaf_index"]]
    assert opened_tile == 3
    assert opening["expected"] == (
        f"verifies; opened value {opened_sketch} != recomputed "
        f"{fixture['honest_s_tile_for_tile_3']} => TileFraudProof verdict Fraud"
    )
    assert _verify_committed_opening(
        root=root,
        leaf_count=len(leaves),
        challenged_tile=3,
        tile_index=opened_tile,
        sketch=opened_sketch,
        index=opening["leaf_index"],
        proof=opening_proof,
    )

    non_inclusion_keys = [
        key for key in fixture if key.startswith("non_inclusion_tile_")
    ]
    assert non_inclusion_keys == ["non_inclusion_tile_2"]
    non_inclusion_key = non_inclusion_keys[0]
    challenged_tile = int(non_inclusion_key.rsplit("_", 1)[1])
    assert challenged_tile == 2
    non_inclusion = fixture[non_inclusion_key]
    left = non_inclusion["left"]
    right = non_inclusion["right"]
    assert non_inclusion["expected"] == "adjacent bracket verifies => proven not committed"
    assert _verify_interior_non_inclusion(
        root=root,
        leaf_count=len(leaves),
        challenged_tile=challenged_tile,
        left=left,
        right=right,
        left_proof=_merkle_proof(leaves, left["index"]),
        right_proof=_merkle_proof(leaves, right["index"]),
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "left_s_tile",
        "right_s_tile",
        "right_tile_idx",
        "nonadjacent_positions",
        "out_of_range_position",
        "negative_left_index",
        "negative_right_index",
        "failed_bracketing",
    ],
)
def test_interior_non_inclusion_rejects_tampered_witness_fields(mutation):
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    non_inclusion = deepcopy(fixture["non_inclusion_tile_2"])
    left = non_inclusion["left"]
    right = non_inclusion["right"]
    challenged_tile = 2
    if mutation == "left_s_tile":
        left["s_tile"] ^= 1
    elif mutation == "right_s_tile":
        right["s_tile"] ^= 1
    elif mutation == "right_tile_idx":
        right["tile_idx"] += 1
    elif mutation == "nonadjacent_positions":
        right["index"] = left["index"]
    elif mutation == "out_of_range_position":
        right["index"] += 1
    elif mutation == "negative_left_index":
        left["index"] = -1
    elif mutation == "negative_right_index":
        right["index"] = -1
    elif mutation == "failed_bracketing":
        challenged_tile = left["tile_idx"]

    leaves = [_unhex(value) for value in fixture["partials_leaves"]]
    root = _unhex(fixture["partials_root"])
    original = fixture["non_inclusion_tile_2"]
    assert not _verify_interior_non_inclusion(
        root=root,
        leaf_count=len(leaves),
        challenged_tile=challenged_tile,
        left=left,
        right=right,
        left_proof=_merkle_proof(leaves, original["left"]["index"]),
        right_proof=_merkle_proof(leaves, original["right"]["index"]),
    )


@pytest.mark.parametrize(
    "mutation",
    ["tile_idx", "s_tile", "leaf_index", "negative_leaf_index", "proof"],
)
def test_committed_opening_rejects_tampered_witness_fields(mutation):
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    opening = fixture["opening_committed_tile_3"]
    leaf_index = opening["leaf_index"]
    tile_index = fixture["coverage"][leaf_index]
    sketch = fixture["committed_s_tiles"][leaf_index]
    proof = [_unhex(value) for value in opening["proof"]]
    if mutation == "tile_idx":
        tile_index += 1
    elif mutation == "s_tile":
        sketch ^= 1
    elif mutation == "leaf_index":
        leaf_index -= 1
    elif mutation == "negative_leaf_index":
        leaf_index = -1
    elif mutation == "proof":
        proof[0] = bytes([proof[0][0] ^ 1]) + proof[0][1:]

    assert not _verify_committed_opening(
        root=_unhex(fixture["partials_root"]),
        leaf_count=len(fixture["partials_leaves"]),
        challenged_tile=3,
        tile_index=tile_index,
        sketch=sketch,
        index=leaf_index,
        proof=proof,
    )


def test_fraud_and_no_fraud_algebraic_verdicts():
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    fraud = fixture["fraud_proof_tile_3"]
    assert fraud["tile_bytes"] == "generate tile 3 from reference_buffer.formula"
    tile_bytes = vector["params"]["tile_bytes"]
    buffer = _reference_buffer(vector)
    tile = buffer[fraud["tile_idx"] * tile_bytes : (fraud["tile_idx"] + 1) * tile_bytes]
    shared = {
        "weights_root": _unhex(vector["weights_tree"]["root"]),
        "challenge": _unhex(vector["slot_seed_derivation"]["global_challenge"]),
        "device_id": _unhex(vector["slot_seed_derivation"]["device_id"]),
        "tile_index": fraud["tile_idx"],
        "partials_index": fraud["partials_index"],
        "tile": tile,
        "weights_proof": [_unhex(value) for value in fraud["weights_proof"]],
    }
    assert _fraud_verdict(
        partials_root=_unhex(fixture["partials_root"]),
        claimed_sketch=fraud["claimed_s_tile"],
        partials_proof=[_unhex(value) for value in fraud["partials_proof"]],
        **shared,
    ) == fraud["expected_verdict"]

    honest_sketch = fixture["honest_s_tile_for_tile_3"]
    honest_leaves = [
        _partials_leaf(fixture["coverage"][0], fixture["committed_s_tiles"][0]),
        _partials_leaf(fraud["tile_idx"], honest_sketch),
    ]
    assert _fraud_verdict(
        partials_root=_merkle_root(honest_leaves),
        claimed_sketch=honest_sketch,
        partials_proof=[honest_leaves[0]],
        **shared,
    ) == "NoFraud"


@pytest.mark.parametrize(
    "mutation",
    [
        "claimed_s_tile",
        "partials_index",
        "negative_partials_index",
        "partials_proof",
        "tile_idx",
        "tile_bytes",
        "weights_proof",
    ],
)
def test_fraud_verdict_rejects_tampered_cryptographic_witness_fields(mutation):
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    fraud = fixture["fraud_proof_tile_3"]
    tile_bytes = vector["params"]["tile_bytes"]
    buffer = _reference_buffer(vector)
    tile = buffer[fraud["tile_idx"] * tile_bytes : (fraud["tile_idx"] + 1) * tile_bytes]
    inputs = {
        "partials_root": _unhex(fixture["partials_root"]),
        "weights_root": _unhex(vector["weights_tree"]["root"]),
        "challenge": _unhex(vector["slot_seed_derivation"]["global_challenge"]),
        "device_id": _unhex(vector["slot_seed_derivation"]["device_id"]),
        "tile_index": fraud["tile_idx"],
        "claimed_sketch": fraud["claimed_s_tile"],
        "partials_index": fraud["partials_index"],
        "partials_proof": [_unhex(value) for value in fraud["partials_proof"]],
        "tile": tile,
        "weights_proof": [_unhex(value) for value in fraud["weights_proof"]],
    }
    if mutation == "claimed_s_tile":
        inputs["claimed_sketch"] ^= 1
    elif mutation == "partials_index":
        inputs["partials_index"] -= 1
    elif mutation == "negative_partials_index":
        inputs["partials_index"] = -1
    elif mutation == "partials_proof":
        proof = inputs["partials_proof"][0]
        inputs["partials_proof"][0] = bytes([proof[0] ^ 1]) + proof[1:]
    elif mutation == "tile_idx":
        inputs["tile_index"] -= 1
    elif mutation == "tile_bytes":
        inputs["tile"] = bytes([tile[0] ^ 1]) + tile[1:]
    elif mutation == "weights_proof":
        proof = inputs["weights_proof"][0]
        inputs["weights_proof"][0] = bytes([proof[0] ^ 1]) + proof[1:]

    assert _fraud_verdict(**inputs) == "Invalid"


def test_two_word_msb_collision_is_deterministic_but_weights_leaves_differ():
    vector = _vector()
    tile_bytes = vector["params"]["tile_bytes"]
    original = bytearray(_reference_buffer(vector)[:tile_bytes])
    changed = original.copy()
    changed[3] ^= 0x80
    changed[7] ^= 0x80

    assert original != changed
    assert _weights_leaf(0, original) != _weights_leaf(0, changed)
    for case in vector["sketches"]:
        original_sketch = _sketch_tiles(case["slot_seed"], original, tile_bytes)
        changed_sketch = _sketch_tiles(case["slot_seed"], changed, tile_bytes)
        assert np.array_equal(original_sketch, changed_sketch)
