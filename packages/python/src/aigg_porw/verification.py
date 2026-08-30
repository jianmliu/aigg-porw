"""Fail-closed, context-bound PoRW v2 tile-fraud verification."""

from dataclasses import dataclass, field
from enum import Enum

import numpy as np
from blake3 import blake3

from .commitments import (
    U32_LIMIT,
    U64_LIMIT,
    CommittedOpening,
    _is_uint,
    verify_committed_opening,
    weights_leaf,
)
from .merkle import _require_exact_bytes, _validate_proof_nodes, verify_counted_merkle
from .scheme import M32, SCHEME_ID, TILE_BYTES, tile_coeffs


@dataclass(frozen=True, slots=True)
class PorwContext:
    """Protocol subject to which one verification result is bound."""

    scheme_id: str
    weights_root: bytes
    challenge: bytes
    device_id: bytes


@dataclass(frozen=True, slots=True)
class TileFraudProof:
    """Canonical evidence for one committed tile-sketch disagreement."""

    scheme_id: str
    weights_root: bytes
    challenge: bytes
    device_id: bytes
    model_n_tiles: int
    partials_root: bytes
    partials_leaf_count: int
    opening: CommittedOpening
    tile_bytes: bytes
    weights_proof: tuple[bytes, ...]


class FraudOutcome(Enum):
    """Normative result of checking one tile-fraud proof."""

    INVALID = "invalid"
    FRAUD = "fraud"
    NO_FRAUD = "no_fraud"


@dataclass(frozen=True, slots=True)
class PorwVerificationResult:
    """A verdict bound to its exact protocol context, with no economic effect."""

    context: PorwContext
    tile_index: int
    outcome: FraudOutcome
    creates_financial_entitlement: bool = field(default=False, init=False)


def _invalid(context: PorwContext, proof: object) -> PorwVerificationResult:
    tile_index = 0
    if (
        type(proof) is TileFraudProof
        and type(proof.opening) is CommittedOpening
        and _is_uint(proof.opening.tile_index, U64_LIMIT)
    ):
        tile_index = proof.opening.tile_index
    return PorwVerificationResult(
        context=context,
        tile_index=tile_index,
        outcome=FraudOutcome.INVALID,
    )


def _require_exact_string(value: object, name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{name} must be an exact string")
    return value


def _prevalidate_bytes(context: PorwContext, proof: TileFraudProof) -> bool:
    """Scan every byte-bearing value before the verifier performs any hash."""
    context_weights_root = _require_exact_bytes(context.weights_root, "weights_root")
    context_challenge = _require_exact_bytes(context.challenge, "challenge")
    context_device_id = _require_exact_bytes(context.device_id, "device_id")
    proof_weights_root = _require_exact_bytes(proof.weights_root, "weights_root")
    proof_challenge = _require_exact_bytes(proof.challenge, "challenge")
    proof_device_id = _require_exact_bytes(proof.device_id, "device_id")
    partials_root = _require_exact_bytes(proof.partials_root, "partials_root")
    tile_bytes = _require_exact_bytes(proof.tile_bytes, "tile_bytes")

    opening_proof_is_valid = _validate_proof_nodes(proof.opening.proof)
    weights_proof_is_valid = _validate_proof_nodes(proof.weights_proof)
    widths_are_valid = (
        all(
            len(value) == 32
            for value in (
                context_weights_root,
                context_challenge,
                context_device_id,
                proof_weights_root,
                proof_challenge,
                proof_device_id,
                partials_root,
            )
        )
        and len(tile_bytes) == TILE_BYTES
    )
    return widths_are_valid and opening_proof_is_valid and weights_proof_is_valid


def _valid_numeric_domains(proof: TileFraudProof) -> bool:
    opening = proof.opening
    return (
        _is_uint(proof.model_n_tiles, U64_LIMIT)
        and proof.model_n_tiles != 0
        and _is_uint(proof.partials_leaf_count, U64_LIMIT)
        and proof.partials_leaf_count != 0
        and _is_uint(opening.tile_index, U64_LIMIT)
        and _is_uint(opening.sketch, U32_LIMIT)
        and _is_uint(opening.index, U64_LIMIT)
    )


def _recompute_tile_sketch(
    slot_seed: int,
    tile_index: int,
    tile_bytes: bytes,
) -> int:
    """Recompute one fixed-size tile using the canonical coefficient function."""
    words = np.frombuffer(tile_bytes, dtype="<u4").astype(np.uint64)
    coefficients = tile_coeffs(slot_seed, tile_index)
    return int((coefficients * words).sum(dtype=np.uint64) & np.uint64(M32))


def verify_tile_fraud(
    context: PorwContext,
    proof: TileFraudProof,
) -> PorwVerificationResult:
    """Verify one tile witness and preserve the exact caller-supplied context.

    Exact native byte objects are required because bytes are hash preimages;
    passing another byte-like class is programmer misuse and raises
    :class:`TypeError` before hashing. Structurally malformed protocol evidence
    made from the correct native classes fails closed with ``INVALID``.
    """
    if not isinstance(context, PorwContext):
        raise TypeError("context must be an exact PorwContext")
    if type(context) is not PorwContext or type(proof) is not TileFraudProof:
        return _invalid(context, proof)
    if type(proof.opening) is not CommittedOpening:
        return _invalid(context, proof)

    context_scheme = _require_exact_string(context.scheme_id, "scheme_id")
    proof_scheme = _require_exact_string(proof.scheme_id, "scheme_id")
    if not _prevalidate_bytes(context, proof):
        return _invalid(context, proof)
    if not _valid_numeric_domains(proof):
        return _invalid(context, proof)

    if (
        context_scheme != SCHEME_ID
        or proof_scheme != SCHEME_ID
        or proof_scheme != context_scheme
        or proof.weights_root != context.weights_root
        or proof.challenge != context.challenge
        or proof.device_id != context.device_id
    ):
        return _invalid(context, proof)

    opening = proof.opening
    if not verify_committed_opening(
        root=proof.partials_root,
        leaf_count=proof.partials_leaf_count,
        challenged_tile=opening.tile_index,
        opening=opening,
    ):
        return _invalid(context, proof)

    if not verify_counted_merkle(
        proof.weights_root,
        weights_leaf(opening.tile_index, proof.tile_bytes),
        opening.tile_index,
        proof.model_n_tiles,
        proof.weights_proof,
    ):
        return _invalid(context, proof)

    slot_seed = int.from_bytes(
        blake3(proof.challenge + proof.device_id).digest()[:4],
        "little",
    )
    actual_sketch = _recompute_tile_sketch(slot_seed, opening.tile_index, proof.tile_bytes)
    outcome = FraudOutcome.NO_FRAUD if actual_sketch == opening.sketch else FraudOutcome.FRAUD
    return PorwVerificationResult(
        context=context,
        tile_index=opening.tile_index,
        outcome=outcome,
    )
