"""PoRW v2 weight and per-slot sketch commitment helpers."""

from dataclasses import dataclass

from blake3 import blake3

from .merkle import (
    _require_exact_bytes,
    _validate_counted_proof,
    _validate_proof_nodes,
    verify_counted_merkle,
)
from .scheme import TILE_BYTES

U32_LIMIT = 1 << 32
U64_LIMIT = 1 << 64


def _require_exact_integer(value: object, name: str) -> int:
    if type(value) is not int:
        raise TypeError(f"{name} must be an exact integer")
    return value


def _require_uint(value: object, name: str, limit: int, width: str) -> int:
    exact = _require_exact_integer(value, name)
    if not 0 <= exact < limit:
        raise ValueError(f"{name} must be within the {width} range")
    return exact


def _is_uint(value: object, limit: int) -> bool:
    return type(value) is int and 0 <= value < limit


def weights_leaf(tile_index: int, tile: bytes) -> bytes:
    """Return ``blake3(LE64(tile_index) || canonical tile bytes)``."""
    tile_bytes = _require_exact_bytes(tile, "tile")
    exact_index = _require_uint(tile_index, "tile_index", U64_LIMIT, "u64")
    if len(tile_bytes) != TILE_BYTES:
        raise ValueError(f"tile must be exactly {TILE_BYTES} bytes")
    return blake3(exact_index.to_bytes(8, "little") + tile_bytes).digest()


def partials_leaf(tile_index: int, sketch: int) -> bytes:
    """Return ``blake3(LE64(tile_index) || LE32(sketch))``."""
    exact_index = _require_uint(tile_index, "tile_index", U64_LIMIT, "u64")
    exact_sketch = _require_uint(sketch, "sketch", U32_LIMIT, "u32")
    return blake3(exact_index.to_bytes(8, "little") + exact_sketch.to_bytes(4, "little")).digest()


@dataclass(frozen=True, slots=True)
class CommittedOpening:
    """A claimed partials leaf and its counted-Merkle opening."""

    tile_index: int
    sketch: int
    index: int
    proof: tuple[bytes, ...]


@dataclass(frozen=True, slots=True)
class NeighborWitness:
    """One authenticated neighbor in strict ascending coverage order."""

    tile_index: int
    sketch: int
    index: int
    proof: tuple[bytes, ...]


@dataclass(frozen=True, slots=True)
class InteriorNonInclusionWitness:
    """Adjacent committed leaves that strictly bracket a challenged tile."""

    left: NeighborWitness
    right: NeighborWitness


def _valid_common_context(root: bytes, leaf_count: object, challenged_tile: object) -> bool:
    root_bytes = _require_exact_bytes(root, "root")
    return (
        len(root_bytes) == 32
        and _is_uint(leaf_count, U64_LIMIT)
        and leaf_count != 0
        and _is_uint(challenged_tile, U64_LIMIT)
    )


def _valid_leaf_witness(witness: CommittedOpening | NeighborWitness, leaf_count: int) -> bool:
    return (
        _is_uint(witness.tile_index, U64_LIMIT)
        and _is_uint(witness.sketch, U32_LIMIT)
        and _is_uint(witness.index, U64_LIMIT)
        and _validate_counted_proof(witness.index, leaf_count, witness.proof)
    )


def verify_committed_opening(
    *, root: bytes, leaf_count: int, challenged_tile: int, opening: CommittedOpening
) -> bool:
    """Verify that the challenged tile is present in ``partials_root``."""
    _require_exact_bytes(root, "root")
    if type(opening) is not CommittedOpening:
        return False
    if not _validate_proof_nodes(opening.proof):
        return False
    if not _valid_common_context(root, leaf_count, challenged_tile):
        return False
    if not _valid_leaf_witness(opening, leaf_count):
        return False
    if opening.tile_index != challenged_tile:
        return False
    return verify_counted_merkle(
        root,
        partials_leaf(opening.tile_index, opening.sketch),
        opening.index,
        leaf_count,
        opening.proof,
    )


def verify_interior_non_inclusion(
    *,
    root: bytes,
    leaf_count: int,
    challenged_tile: int,
    witness: InteriorNonInclusionWitness,
) -> bool:
    """Verify adjacent committed leaves strictly bracketing a missing tile."""
    _require_exact_bytes(root, "root")
    if type(witness) is not InteriorNonInclusionWitness:
        return False
    left = witness.left
    right = witness.right
    left_is_neighbor = type(left) is NeighborWitness
    right_is_neighbor = type(right) is NeighborWitness
    left_proof_is_valid = _validate_proof_nodes(left.proof) if left_is_neighbor else False
    right_proof_is_valid = _validate_proof_nodes(right.proof) if right_is_neighbor else False
    if not left_is_neighbor or not right_is_neighbor:
        return False
    if not left_proof_is_valid or not right_proof_is_valid:
        return False
    if not _valid_common_context(root, leaf_count, challenged_tile):
        return False
    if not _valid_leaf_witness(left, leaf_count) or not _valid_leaf_witness(right, leaf_count):
        return False
    if left.index >= leaf_count or right.index >= leaf_count:
        return False
    if left.index + 1 != right.index:
        return False
    if not left.tile_index < challenged_tile < right.tile_index:
        return False

    return verify_counted_merkle(
        root,
        partials_leaf(left.tile_index, left.sketch),
        left.index,
        leaf_count,
        left.proof,
    ) and verify_counted_merkle(
        root,
        partials_leaf(right.tile_index, right.sketch),
        right.index,
        leaf_count,
        right.proof,
    )
