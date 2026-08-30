"""PoRW v2 weight and per-slot sketch commitment helpers."""

from dataclasses import dataclass

from blake3 import blake3

from .merkle import _require_exact_bytes, verify_counted_merkle
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


def _valid_leaf_witness(witness: CommittedOpening | NeighborWitness) -> bool:
    return (
        _is_uint(witness.tile_index, U64_LIMIT)
        and _is_uint(witness.sketch, U32_LIMIT)
        and _is_uint(witness.index, U64_LIMIT)
        and type(witness.proof) is tuple
    )


def verify_committed_opening(
    *, root: bytes, leaf_count: int, challenged_tile: int, opening: CommittedOpening
) -> bool:
    """Verify that the challenged tile is present in ``partials_root``."""
    if not _valid_common_context(root, leaf_count, challenged_tile):
        return False
    if type(opening) is not CommittedOpening or not _valid_leaf_witness(opening):
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
    if not _valid_common_context(root, leaf_count, challenged_tile):
        return False
    if type(witness) is not InteriorNonInclusionWitness:
        return False
    left = witness.left
    right = witness.right
    if type(left) is not NeighborWitness or type(right) is not NeighborWitness:
        return False
    if not _valid_leaf_witness(left) or not _valid_leaf_witness(right):
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
