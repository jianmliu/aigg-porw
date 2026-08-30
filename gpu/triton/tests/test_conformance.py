"""Locked-vector conformance through the canonical ``aigg_porw`` package.

Only expected-tree builders remain local to this test. Scheme arithmetic,
commitment verification, and fraud verdicts are always exercised through the
packaged implementation consumed by the Triton adapter.
"""

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from aigg_porw import (
    SCHEME_ID,
    TILE_BYTES,
    CommittedOpening,
    FraudOutcome,
    InteriorNonInclusionWitness,
    NeighborWitness,
    PorwContext,
    TileFraudProof,
    partials_leaf,
    sketch_tiles,
    tile_coeffs,
    verify_committed_opening,
    verify_counted_merkle,
    verify_interior_non_inclusion,
    verify_tile_fraud,
    weights_leaf,
)
from blake3 import blake3
from porw_sketch import spec as compatibility_spec

REPO_ROOT = Path(__file__).resolve().parents[3]
VECTOR_PATH = REPO_ROOT / "spec-cache/conformance/porw/sketch-tile-v2.json"
PROVENANCE_PATH = VECTOR_PATH.with_suffix(".provenance.json")
MASK64 = (1 << 64) - 1


def _vector() -> dict[str, object]:
    value = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _mapping(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    return value


def _list(value: object) -> list[object]:
    assert isinstance(value, list)
    return value


def _unhex(value: object) -> bytes:
    assert isinstance(value, str)
    return bytes.fromhex(value.removeprefix("0x"))


def _hex(value: bytes) -> str:
    return "0x" + value.hex()


def _reference_buffer(vector: dict[str, object]) -> bytes:
    reference = _mapping(vector["reference_buffer"])
    length = int(reference["n_tiles"]) * TILE_BYTES
    return bytes(
        ((((index * 2654435761) & MASK64) >> 7) & 0xFF) for index in range(length)
    )


def _expected_root(leaves: tuple[bytes, ...]) -> bytes:
    if not leaves:
        return blake3(b"").digest()
    level = leaves
    while len(level) > 1:
        level = tuple(
            blake3(
                level[index]
                + (level[index + 1] if index + 1 < len(level) else level[index])
            ).digest()
            for index in range(0, len(level), 2)
        )
    return level[0]


def _expected_proof(leaves: tuple[bytes, ...], index: int) -> tuple[bytes, ...]:
    if not leaves or not 0 <= index < len(leaves):
        raise ValueError("expected-tree proof index is outside the tree")
    result: list[bytes] = []
    level = leaves
    while len(level) > 1:
        sibling_index = index - 1 if index % 2 else index + 1
        result.append(
            level[sibling_index] if sibling_index < len(level) else level[index]
        )
        level = tuple(
            blake3(
                level[position]
                + (
                    level[position + 1]
                    if position + 1 < len(level)
                    else level[position]
                )
            ).digest()
            for position in range(0, len(level), 2)
        )
        index //= 2
    return tuple(result)


def _proof_inputs(*, honest: bool = False) -> tuple[PorwContext, TileFraudProof]:
    vector = _vector()
    fixture = _mapping(vector["tampered_commitment_scenario"])
    fraud = _mapping(fixture["fraud_proof_tile_3"])
    seed = _mapping(vector["slot_seed_derivation"])
    weights = _mapping(vector["weights_tree"])
    coverage = _list(fixture["coverage"])
    committed = _list(fixture["committed_s_tiles"])

    tile_index = int(fraud["tile_idx"])
    claimed_sketch = int(
        fixture["honest_s_tile_for_tile_3"] if honest else fraud["claimed_s_tile"]
    )
    if honest:
        left_leaf = partials_leaf(int(coverage[0]), int(committed[0]))
        partials_proof = (left_leaf,)
        partials_root = _expected_root(
            (left_leaf, partials_leaf(tile_index, claimed_sketch))
        )
    else:
        partials_proof = tuple(
            _unhex(value) for value in _list(fraud["partials_proof"])
        )
        partials_root = _unhex(fixture["partials_root"])

    proof = TileFraudProof(
        scheme_id=SCHEME_ID,
        weights_root=_unhex(weights["root"]),
        challenge=_unhex(seed["global_challenge"]),
        device_id=_unhex(seed["device_id"]),
        opening=CommittedOpening(
            tile_index=tile_index,
            sketch=claimed_sketch,
            index=int(fraud["partials_index"]),
            proof=partials_proof,
        ),
        tile_bytes=_reference_buffer(vector)[
            tile_index * TILE_BYTES : (tile_index + 1) * TILE_BYTES
        ],
        weights_proof=tuple(_unhex(value) for value in _list(fraud["weights_proof"])),
    )
    context = PorwContext(
        scheme_id=SCHEME_ID,
        weights_root=proof.weights_root,
        challenge=proof.challenge,
        device_id=proof.device_id,
        partials_root=partials_root,
        partials_leaf_count=len(coverage),
        model_n_tiles=int(_mapping(vector["reference_buffer"])["n_tiles"]),
    )
    return context, proof


def test_triton_compatibility_module_reexports_exact_packaged_objects() -> None:
    import aigg_porw.scheme as canonical

    assert compatibility_spec.fmix32 is canonical.fmix32
    assert compatibility_spec.tile_coeffs is canonical.tile_coeffs
    assert compatibility_spec.sketch_tiles is canonical.sketch_tiles
    assert compatibility_spec.SCHEME_ID == canonical.SCHEME_ID


def test_vector_identity_and_provenance_raw_bytes_are_locked() -> None:
    vector = _vector()
    scheme = _mapping(vector["scheme"])
    assert VECTOR_PATH.is_file()
    assert scheme["id"] == SCHEME_ID
    assert _hex(blake3(SCHEME_ID.encode()).digest()) == scheme["digest"]
    assert hashlib.sha256(VECTOR_PATH.read_bytes()).hexdigest() == (
        "fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7"
    )
    assert hashlib.sha256(PROVENANCE_PATH.read_bytes()).hexdigest() == (
        "fbb301486fb47da28fbfdad96a062abb3ad88615e0e3a1044ff0e0dbd3d1fc50"
    )

    seed_fixture = _mapping(vector["slot_seed_derivation"])
    challenge = _unhex(seed_fixture["global_challenge"])
    device_id = _unhex(seed_fixture["device_id"])
    slot_seed = int.from_bytes(blake3(challenge + device_id).digest()[:4], "little")
    assert slot_seed == seed_fixture["slot_seed"]

    weights_root = _unhex(_mapping(vector["weights_tree"])["root"])
    partials_root = _unhex(
        _mapping(vector["tampered_commitment_scenario"])["partials_root"]
    )
    ticket_input = weights_root + partials_root + slot_seed.to_bytes(4, "little")
    ticket_chunks = _mapping(vector["ticket_chunks"])
    assert (
        _hex(blake3(ticket_input).digest(length=32, seek=0)) == ticket_chunks["index_0"]
    )
    assert (
        _hex(blake3(ticket_input).digest(length=32, seek=32))
        == ticket_chunks["index_1"]
    )

    beacon_fixture = _mapping(vector["audit_beacon"])
    beacon_input = (
        b"porw-cross-audit-v1"
        + _unhex(beacon_fixture["entropy"])
        + int(beacon_fixture["epoch"]).to_bytes(8, "little")
    )
    assert _hex(blake3(beacon_input).digest()) == beacon_fixture["beacon"]


def test_reference_buffer_coefficients_and_all_sketches_match_vector() -> None:
    vector = _vector()
    reference = _mapping(vector["reference_buffer"])
    buffer = _reference_buffer(vector)
    assert _hex(blake3(buffer).digest()) == reference["blake3"]

    coefficient_fixture = _mapping(vector["coefficients"])
    coefficients = tile_coeffs(
        int(coefficient_fixture["slot_seed"]),
        np.array([0, 3], dtype=np.uint64),
    )
    assert coefficients[0, :4].tolist() == coefficient_fixture["tile0_first4"]
    assert coefficients[1, :4].tolist() == coefficient_fixture["tile3_first4"]
    assert np.all((coefficients & 1) == 1)

    array = np.frombuffer(buffer, dtype=np.uint8)
    for case_value in _list(vector["sketches"]):
        case = _mapping(case_value)
        assert sketch_tiles(int(case["slot_seed"]), array).tolist() == case["per_tile"]


def test_weights_and_partials_commitments_match_locked_trees() -> None:
    vector = _vector()
    buffer = _reference_buffer(vector)
    tiles = tuple(
        buffer[offset : offset + TILE_BYTES]
        for offset in range(0, len(buffer), TILE_BYTES)
    )
    weight_leaves = tuple(weights_leaf(index, tile) for index, tile in enumerate(tiles))
    weights = _mapping(vector["weights_tree"])
    assert [_hex(leaf) for leaf in weight_leaves] == weights["leaves"]
    assert _hex(_expected_root(weight_leaves)) == weights["root"]

    fixture = _mapping(vector["tampered_commitment_scenario"])
    partials_leaves = tuple(
        partials_leaf(int(tile_index), int(sketch))
        for tile_index, sketch in zip(
            _list(fixture["coverage"]),
            _list(fixture["committed_s_tiles"]),
            strict=True,
        )
    )
    assert [_hex(leaf) for leaf in partials_leaves] == fixture["partials_leaves"]
    assert _hex(_expected_root(partials_leaves)) == fixture["partials_root"]


@pytest.mark.parametrize("leaf_count", [3, 5])
def test_packaged_counted_merkle_handles_odd_duplicate_last_trees(
    leaf_count: int,
) -> None:
    leaves = tuple(
        blake3(f"leaf-{index}".encode()).digest() for index in range(leaf_count)
    )
    root = _expected_root(leaves)
    for index, leaf in enumerate(leaves):
        proof = _expected_proof(leaves, index)
        assert verify_counted_merkle(root, leaf, index, leaf_count, proof)
    final_proof = _expected_proof(leaves, leaf_count - 1)
    wrong_duplicate = (leaves[-2], *final_proof[1:])
    assert not verify_counted_merkle(
        root, leaves[-1], leaf_count - 1, leaf_count, wrong_duplicate
    )


def test_packaged_opening_and_interior_non_inclusion_match_vector() -> None:
    vector = _vector()
    fixture = _mapping(vector["tampered_commitment_scenario"])
    root = _unhex(fixture["partials_root"])
    opening_fixture = _mapping(fixture["opening_committed_tile_3"])
    opening = CommittedOpening(
        tile_index=3,
        sketch=int(_list(fixture["committed_s_tiles"])[1]),
        index=int(opening_fixture["leaf_index"]),
        proof=tuple(_unhex(value) for value in _list(opening_fixture["proof"])),
    )
    assert verify_committed_opening(
        root=root,
        leaf_count=2,
        challenged_tile=3,
        opening=opening,
    )

    leaves = tuple(_unhex(value) for value in _list(fixture["partials_leaves"]))
    non_inclusion = _mapping(fixture["non_inclusion_tile_2"])
    left = _mapping(non_inclusion["left"])
    right = _mapping(non_inclusion["right"])
    witness = InteriorNonInclusionWitness(
        left=NeighborWitness(
            int(left["tile_idx"]),
            int(left["s_tile"]),
            int(left["index"]),
            _expected_proof(leaves, int(left["index"])),
        ),
        right=NeighborWitness(
            int(right["tile_idx"]),
            int(right["s_tile"]),
            int(right["index"]),
            _expected_proof(leaves, int(right["index"])),
        ),
    )
    assert verify_interior_non_inclusion(
        root=root,
        leaf_count=2,
        challenged_tile=2,
        witness=witness,
    )


def test_packaged_fraud_verifier_matches_locked_fraud_and_honest_cases() -> None:
    fraud_context, fraud_proof = _proof_inputs()
    fraud_result = verify_tile_fraud(fraud_context, fraud_proof)
    assert fraud_result.outcome is FraudOutcome.FRAUD
    assert fraud_result.context == fraud_context
    assert fraud_result.creates_financial_entitlement is False

    honest_context, honest_proof = _proof_inputs(honest=True)
    honest_result = verify_tile_fraud(honest_context, honest_proof)
    assert honest_result.outcome is FraudOutcome.NO_FRAUD
    assert honest_result.context == honest_context

    tampered = replace(
        fraud_proof,
        opening=replace(
            fraud_proof.opening,
            proof=(bytes(32),),
        ),
    )
    assert verify_tile_fraud(fraud_context, tampered).outcome is FraudOutcome.INVALID


def test_two_word_msb_collision_is_visible_to_weight_commitment() -> None:
    vector = _vector()
    original = bytearray(_reference_buffer(vector)[:TILE_BYTES])
    changed = original.copy()
    changed[3] ^= 0x80
    changed[7] ^= 0x80

    assert weights_leaf(0, bytes(original)) != weights_leaf(0, bytes(changed))
    original_array = np.frombuffer(original, dtype=np.uint8)
    changed_array = np.frombuffer(changed, dtype=np.uint8)
    for case_value in _list(vector["sketches"]):
        case = _mapping(case_value)
        seed = int(case["slot_seed"])
        assert np.array_equal(
            sketch_tiles(seed, original_array),
            sketch_tiles(seed, changed_array),
        )
