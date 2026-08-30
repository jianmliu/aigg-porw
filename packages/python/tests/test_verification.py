"""Context-bound tile-fraud verification against the locked PoRW v2 vector."""

import inspect
import json
from dataclasses import fields, replace
from pathlib import Path
from typing import Any, Never, cast

import pytest
from blake3 import blake3

import aigg_porw.commitments as commitment_module
import aigg_porw.merkle as merkle_module
import aigg_porw.verification as verification_module
from aigg_porw import (
    SCHEME_ID,
    TILE_BYTES,
    CommittedOpening,
    FraudOutcome,
    PorwContext,
    PorwVerificationResult,
    TileFraudProof,
    partials_leaf,
    verify_tile_fraud,
)

VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "spec-cache"
    / "conformance"
    / "porw"
    / "sketch-tile-v2.json"
)
U32_LIMIT = 1 << 32
U64_LIMIT = 1 << 64


def _unhex(value: object) -> bytes:
    assert isinstance(value, str)
    return bytes.fromhex(value.removeprefix("0x"))


def _vector() -> dict[str, object]:
    return cast(dict[str, object], json.loads(VECTOR_PATH.read_text(encoding="utf-8")))


def _root(leaves: tuple[bytes, ...]) -> bytes:
    level = leaves
    while len(level) > 1:
        level = tuple(
            blake3(
                level[index] + (level[index + 1] if index + 1 < len(level) else level[index])
            ).digest()
            for index in range(0, len(level), 2)
        )
    return level[0]


def _reference_tile(vector: dict[str, object], tile_index: int) -> bytes:
    reference = vector["reference_buffer"]
    assert isinstance(reference, dict)
    n_tiles = int(reference["n_tiles"])
    buffer = bytes(
        (((index * 2654435761) & (U64_LIMIT - 1)) >> 7) & 0xFF
        for index in range(n_tiles * TILE_BYTES)
    )
    start = tile_index * TILE_BYTES
    return buffer[start : start + TILE_BYTES]


def _canonical_proof(*, honest: bool = False) -> TileFraudProof:
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    seed = vector["slot_seed_derivation"]
    weights = vector["weights_tree"]
    assert isinstance(fixture, dict)
    assert isinstance(seed, dict)
    assert isinstance(weights, dict)
    fraud = fixture["fraud_proof_tile_3"]
    assert isinstance(fraud, dict)

    tile_index = int(fraud["tile_idx"])
    claimed_sketch = int(fixture["honest_s_tile_for_tile_3"] if honest else fraud["claimed_s_tile"])
    partials_proof: tuple[bytes, ...]
    if honest:
        coverage = fixture["coverage"]
        committed = fixture["committed_s_tiles"]
        assert isinstance(coverage, list)
        assert isinstance(committed, list)
        left_leaf = partials_leaf(int(coverage[0]), int(committed[0]))
        partials_root = _root((left_leaf, partials_leaf(tile_index, claimed_sketch)))
        partials_proof = (left_leaf,)
    else:
        partials_root = _unhex(fixture["partials_root"])
        partials_proof = tuple(
            _unhex(value) for value in cast(list[object], fraud["partials_proof"])
        )

    return TileFraudProof(
        scheme_id=SCHEME_ID,
        weights_root=_unhex(weights["root"]),
        challenge=_unhex(seed["global_challenge"]),
        device_id=_unhex(seed["device_id"]),
        model_n_tiles=4,
        partials_root=partials_root,
        partials_leaf_count=2,
        opening=CommittedOpening(
            tile_index=tile_index,
            sketch=claimed_sketch,
            index=int(fraud["partials_index"]),
            proof=partials_proof,
        ),
        tile_bytes=_reference_tile(vector, tile_index),
        weights_proof=tuple(_unhex(value) for value in cast(list[object], fraud["weights_proof"])),
    )


def _context(proof: TileFraudProof) -> PorwContext:
    return PorwContext(
        scheme_id=proof.scheme_id,
        weights_root=proof.weights_root,
        challenge=proof.challenge,
        device_id=proof.device_id,
    )


def test_locked_tampered_and_honest_scenarios_return_exact_outcomes() -> None:
    fraud = _canonical_proof()
    fraud_result = verify_tile_fraud(_context(fraud), fraud)
    assert fraud_result.outcome is FraudOutcome.FRAUD
    assert fraud_result.tile_index == 3

    honest = _canonical_proof(honest=True)
    honest_result = verify_tile_fraud(_context(honest), honest)
    assert honest_result.outcome is FraudOutcome.NO_FRAUD
    assert honest_result.tile_index == 3


def test_result_preserves_protocol_context_and_never_creates_entitlement() -> None:
    proof = _canonical_proof()
    context = _context(proof)
    result = verify_tile_fraud(context, proof)
    assert result.context == context
    assert result.creates_financial_entitlement is False
    with pytest.raises(TypeError, match="creates_financial_entitlement"):
        PorwVerificationResult(  # type: ignore[call-arg]
            context=context,
            tile_index=3,
            outcome=FraudOutcome.FRAUD,
            creates_financial_entitlement=True,
        )
    with pytest.raises((AttributeError, TypeError)):
        result.creates_financial_entitlement = True  # type: ignore[misc]


@pytest.mark.parametrize(
    "change",
    [
        {"scheme_id": "aigg:porw:sketch-tile:v1"},
        {"weights_root": bytes([1]) + bytes(31)},
        {"challenge": bytes([2]) + bytes(31)},
        {"device_id": bytes([3]) + bytes(31)},
    ],
)
def test_context_binding_mismatches_are_invalid(change: dict[str, object]) -> None:
    proof = _canonical_proof()
    context = _context(proof)
    result = verify_tile_fraud(replace(context, **change), proof)  # type: ignore[arg-type]
    assert result.outcome is FraudOutcome.INVALID
    assert result.context == replace(context, **change)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "change",
    [
        {"scheme_id": "aigg:porw:sketch-tile:v1"},
        {"weights_root": bytes([1]) + bytes(31)},
        {"challenge": bytes([2]) + bytes(31)},
        {"device_id": bytes([4]) + bytes(31)},
    ],
)
def test_proof_binding_mismatches_are_invalid(change: dict[str, object]) -> None:
    proof = _canonical_proof()
    context = _context(proof)
    candidate = replace(proof, **cast(Any, change))
    result = verify_tile_fraud(context, candidate)
    assert result.outcome is FraudOutcome.INVALID
    assert result.context == context


@pytest.mark.parametrize(
    "mutation",
    [
        "claimed_sketch",
        "partials_index",
        "partials_proof",
        "tile_index",
        "tile_bytes",
        "weights_proof",
        "model_n_tiles",
        "partials_leaf_count",
        "partials_root",
    ],
)
def test_tampered_witness_fields_are_invalid(mutation: str) -> None:
    proof = _canonical_proof()
    if mutation == "claimed_sketch":
        proof = replace(proof, opening=replace(proof.opening, sketch=proof.opening.sketch ^ 1))
    elif mutation == "partials_index":
        proof = replace(proof, opening=replace(proof.opening, index=0))
    elif mutation == "partials_proof":
        node = proof.opening.proof[0]
        proof = replace(
            proof,
            opening=replace(proof.opening, proof=(bytes([node[0] ^ 1]) + node[1:],)),
        )
    elif mutation == "tile_index":
        proof = replace(proof, opening=replace(proof.opening, tile_index=2))
    elif mutation == "tile_bytes":
        proof = replace(proof, tile_bytes=bytes([proof.tile_bytes[0] ^ 1]) + proof.tile_bytes[1:])
    elif mutation == "weights_proof":
        node = proof.weights_proof[0]
        proof = replace(
            proof, weights_proof=(bytes([node[0] ^ 1]) + node[1:], *proof.weights_proof[1:])
        )
    elif mutation == "model_n_tiles":
        proof = replace(proof, model_n_tiles=3)
    elif mutation == "partials_leaf_count":
        proof = replace(proof, partials_leaf_count=1)
    elif mutation == "partials_root":
        proof = replace(proof, partials_root=bytes(32))
    assert verify_tile_fraud(_context(proof), proof).outcome is FraudOutcome.INVALID


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("model_n_tiles", -1),
        ("model_n_tiles", 0),
        ("model_n_tiles", U64_LIMIT),
        ("partials_leaf_count", -1),
        ("partials_leaf_count", 0),
        ("partials_leaf_count", U64_LIMIT),
    ],
)
def test_correct_native_malformed_counts_are_invalid(field: str, value: int) -> None:
    proof = replace(_canonical_proof(), **cast(Any, {field: value}))
    assert verify_tile_fraud(_context(proof), proof).outcome is FraudOutcome.INVALID


def test_correct_native_malformed_widths_and_nested_numbers_are_invalid() -> None:
    proof = _canonical_proof()
    malformed = (
        replace(proof, weights_root=bytes(31)),
        replace(proof, challenge=bytes(31)),
        replace(proof, device_id=bytes(33)),
        replace(proof, partials_root=bytes(31)),
        replace(proof, tile_bytes=proof.tile_bytes[:-1]),
        replace(proof, weights_proof=(bytes(31), *proof.weights_proof[1:])),
        replace(proof, opening=replace(proof.opening, tile_index=-1)),
        replace(proof, opening=replace(proof.opening, tile_index=U64_LIMIT)),
        replace(proof, opening=replace(proof.opening, sketch=U32_LIMIT)),
        replace(proof, opening=replace(proof.opening, index=True)),
    )
    for candidate in malformed:
        assert verify_tile_fraud(_context(candidate), candidate).outcome is FraudOutcome.INVALID


class _BytesSubclass(bytes):
    pass


class _IntSubclass(int):
    pass


class _ContextSubclass(PorwContext):
    pass


class _ProofSubclass(TileFraudProof):
    pass


class _OpeningSubclass(CommittedOpening):
    pass


def test_exact_protocol_classes_and_integers_fail_closed() -> None:
    proof = _canonical_proof()
    context = _context(proof)
    context_subclass = _ContextSubclass(
        context.scheme_id, context.weights_root, context.challenge, context.device_id
    )
    proof_subclass = _ProofSubclass(
        proof.scheme_id,
        proof.weights_root,
        proof.challenge,
        proof.device_id,
        proof.model_n_tiles,
        proof.partials_root,
        proof.partials_leaf_count,
        proof.opening,
        proof.tile_bytes,
        proof.weights_proof,
    )
    opening_subclass = _OpeningSubclass(
        proof.opening.tile_index,
        proof.opening.sketch,
        proof.opening.index,
        proof.opening.proof,
    )
    assert verify_tile_fraud(context_subclass, proof).outcome is FraudOutcome.INVALID
    assert verify_tile_fraud(context, proof_subclass).outcome is FraudOutcome.INVALID
    assert (
        verify_tile_fraud(context, replace(proof, opening=opening_subclass)).outcome
        is FraudOutcome.INVALID
    )
    assert (
        verify_tile_fraud(context, replace(proof, model_n_tiles=_IntSubclass(4))).outcome
        is FraudOutcome.INVALID
    )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("weights_root", "root", "weights_root must be exact bytes"),
        ("challenge", bytearray(32), "challenge must be exact bytes"),
        ("device_id", memoryview(bytes(32)), "device_id must be exact bytes"),
        ("partials_root", _BytesSubclass(32), "partials_root must be exact bytes"),
        ("tile_bytes", "tile", "tile_bytes must be exact bytes"),
    ],
)
def test_programmer_bytes_misuse_raises_before_hashing(
    monkeypatch: pytest.MonkeyPatch, field: str, value: object, message: str
) -> None:
    proof = _canonical_proof()
    candidate = replace(proof, **cast(Any, {field: value}))
    calls = _forbid_hashing(monkeypatch)
    with pytest.raises(TypeError, match=f"^{message}$"):
        verify_tile_fraud(_context(proof), candidate)
    assert calls == []


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("weights_root", bytearray(32), "weights_root must be exact bytes"),
        ("challenge", memoryview(bytes(32)), "challenge must be exact bytes"),
        ("device_id", _BytesSubclass(32), "device_id must be exact bytes"),
    ],
)
def test_context_bytes_misuse_raises_before_hashing(
    monkeypatch: pytest.MonkeyPatch, field: str, value: object, message: str
) -> None:
    proof = _canonical_proof()
    context = replace(_context(proof), **cast(Any, {field: value}))
    calls = _forbid_hashing(monkeypatch)
    with pytest.raises(TypeError, match=f"^{message}$"):
        verify_tile_fraud(context, proof)
    assert calls == []


def _forbid_hashing(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def forbidden_blake3(*args: object, **kwargs: object) -> Never:
        calls.append(1)
        raise AssertionError("hashing occurred before recursive input validation")

    monkeypatch.setattr(verification_module, "blake3", forbidden_blake3)
    monkeypatch.setattr(commitment_module, "blake3", forbidden_blake3)
    monkeypatch.setattr(merkle_module, "blake3", forbidden_blake3)
    return calls


def test_late_nested_bytes_misuse_wins_over_earlier_binding_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proof = _canonical_proof()
    bad_context = replace(_context(proof), scheme_id="wrong")
    bad_proof = (*proof.weights_proof[:-1], "late-node")
    candidate = replace(proof, weights_proof=cast(tuple[bytes, ...], bad_proof))
    calls = _forbid_hashing(monkeypatch)
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_tile_fraud(bad_context, candidate)
    assert calls == []


def test_byte_subclasses_in_nested_proofs_raise_before_hashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proof = _canonical_proof()
    candidate = replace(
        proof,
        opening=replace(proof.opening, proof=(_BytesSubclass(proof.opening.proof[0]),)),
    )
    calls = _forbid_hashing(monkeypatch)
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_tile_fraud(_context(proof), candidate)
    assert calls == []


def test_context_proof_and_result_are_frozen_and_slotted() -> None:
    proof = _canonical_proof()
    context = _context(proof)
    result = verify_tile_fraud(context, proof)
    for value in (context, proof, result):
        assert not hasattr(value, "__dict__")
        with pytest.raises((AttributeError, TypeError)):
            cast(Any, value).extra = 1


def test_protocol_api_has_no_economic_or_identity_policy_fields() -> None:
    forbidden = ("worker", "mep", "token", "amount", "price", "capacity", "unit")
    field_names = {
        field.name.lower()
        for cls in (PorwContext, TileFraudProof, PorwVerificationResult)
        for field in fields(cls)
    }
    parameters = {name.lower() for name in inspect.signature(verify_tile_fraud).parameters}
    assert parameters == {"context", "proof"}
    assert not any(term in name for name in field_names | parameters for term in forbidden)


def test_fraud_outcome_values_are_stable() -> None:
    assert {outcome.value for outcome in FraudOutcome} == {"invalid", "fraud", "no_fraud"}
