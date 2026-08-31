"""Fail-closed PoRW v2 verification with ephemeral, non-credential results."""

from dataclasses import dataclass
from enum import Enum
from typing import ClassVar, Literal, Never, Self, SupportsIndex

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
    """Authenticated external state to which one verification is bound.

    ``partials_leaf_count`` is the nonzero coverage-leaf count corresponding
    to Rust's validated ``coverage_bytes / TILE_BYTES``. ``model_n_tiles`` is
    the independently authenticated shape of the weights tree. Neither value,
    nor either commitment root, is derived from the reporter's proof.
    """

    scheme_id: str
    weights_root: bytes
    challenge: bytes
    device_id: bytes
    partials_root: bytes
    partials_leaf_count: int
    model_n_tiles: int


@dataclass(frozen=True, slots=True)
class TileFraudProof:
    """Canonical evidence for one committed tile-sketch disagreement."""

    scheme_id: str
    weights_root: bytes
    challenge: bytes
    device_id: bytes
    opening: CommittedOpening
    tile_bytes: bytes
    weights_proof: tuple[bytes, ...]


class FraudOutcome(Enum):
    """Normative result of checking one tile-fraud proof."""

    INVALID = "invalid"
    FRAUD = "fraud"
    NO_FRAUD = "no_fraud"


@dataclass(frozen=True, slots=True, init=False)
class PorwVerificationResult:
    """An ephemeral in-process diagnostic returned only by the verifier.

    This value is deliberately not a serializable credential. Callers cannot
    construct it directly; they must invoke :func:`verify_tile_fraud` locally.
    Python object identity is not an attestation and this class makes no claim
    against hostile code executing in the same interpreter.
    """

    context: PorwContext
    tile_index: int
    outcome: FraudOutcome
    creates_financial_entitlement: ClassVar[Literal[False]] = False

    def __new__(cls, *args: object, **kwargs: object) -> Self:
        del args, kwargs
        raise TypeError(
            "PorwVerificationResult cannot be constructed directly; call verify_tile_fraud"
        )

    def __reduce_ex__(self, protocol: SupportsIndex) -> Never:
        del protocol
        raise TypeError("PorwVerificationResult is an ephemeral diagnostic, not a credential")

    def __reduce__(self) -> Never:
        raise TypeError("PorwVerificationResult is an ephemeral diagnostic, not a credential")

    def __copy__(self) -> Never:
        raise TypeError("PorwVerificationResult is an ephemeral diagnostic, not a credential")

    def __deepcopy__(self, memo: dict[int, object]) -> Never:
        del memo
        raise TypeError("PorwVerificationResult is an ephemeral diagnostic, not a credential")


def _seal_verification_result(
    *,
    context: PorwContext,
    tile_index: int,
    outcome: FraudOutcome,
) -> PorwVerificationResult:
    """Create the result through the verifier's sole module-private path."""
    result: PorwVerificationResult = object.__new__(PorwVerificationResult)
    object.__setattr__(result, "context", context)
    object.__setattr__(result, "tile_index", tile_index)
    object.__setattr__(result, "outcome", outcome)
    return result


def _invalid(context: PorwContext, proof: object) -> PorwVerificationResult:
    tile_index = 0
    if (
        type(proof) is TileFraudProof
        and type(proof.opening) is CommittedOpening
        and _is_uint(proof.opening.tile_index, U64_LIMIT)
    ):
        tile_index = proof.opening.tile_index
    return _seal_verification_result(
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
    context_partials_root = _require_exact_bytes(context.partials_root, "partials_root")
    proof_weights_root = _require_exact_bytes(proof.weights_root, "weights_root")
    proof_challenge = _require_exact_bytes(proof.challenge, "challenge")
    proof_device_id = _require_exact_bytes(proof.device_id, "device_id")
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
                context_partials_root,
                proof_weights_root,
                proof_challenge,
                proof_device_id,
            )
        )
        and len(tile_bytes) == TILE_BYTES
    )
    return widths_are_valid and opening_proof_is_valid and weights_proof_is_valid


def _valid_numeric_domains(context: PorwContext, proof: TileFraudProof) -> bool:
    opening = proof.opening
    return (
        _is_uint(context.model_n_tiles, U64_LIMIT)
        and context.model_n_tiles != 0
        and _is_uint(context.partials_leaf_count, U64_LIMIT)
        and context.partials_leaf_count != 0
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
    made from the correct native classes fails closed with ``INVALID``. Use
    the returned result only in the current in-process control flow; never
    accept a stored or caller-supplied result as evidence.
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
    if not _valid_numeric_domains(context, proof):
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
        root=context.partials_root,
        leaf_count=context.partials_leaf_count,
        challenged_tile=opening.tile_index,
        opening=opening,
    ):
        return _invalid(context, proof)

    if not verify_counted_merkle(
        proof.weights_root,
        weights_leaf(opening.tile_index, proof.tile_bytes),
        opening.tile_index,
        context.model_n_tiles,
        proof.weights_proof,
    ):
        return _invalid(context, proof)

    slot_seed = int.from_bytes(
        blake3(proof.challenge + proof.device_id).digest()[:4],
        "little",
    )
    actual_sketch = _recompute_tile_sketch(slot_seed, opening.tile_index, proof.tile_bytes)
    outcome = FraudOutcome.NO_FRAUD if actual_sketch == opening.sketch else FraudOutcome.FRAUD
    return _seal_verification_result(
        context=context,
        tile_index=opening.tile_index,
        outcome=outcome,
    )
