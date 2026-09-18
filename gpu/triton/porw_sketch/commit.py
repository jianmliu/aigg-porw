"""BLAKE3 commitment, opening, and fraud-verdict reference for scheme v2.

This is the host-side verifier half of ``aigg:porw:sketch-tile:v2``: the tile
Merkle commitments, coverage-ordered partials commitments, adjacent-leaf
opening/non-inclusion checks, and the tile fraud verdict. The sketch
arithmetic itself lives in :mod:`porw_sketch.spec` (and the GPU sweep in
:mod:`porw_sketch.kernels`); this module only does the cryptographic binding.

Normative authority is the tagged private ``aigg-spec`` release; this is an
executable implementation reference, not the specification. The independent
BLAKE3 reimplementation in ``tests/test_conformance.py`` deliberately stays
separate and checks the locked vectors — this module reproduces the same tree
math so a demo or adapter built on it commits to the identical weights root.

All leaves and interior nodes are BLAKE3; trees are binary with
duplicate-last padding. Weights tiles are committed in tile order; partials
are committed in strictly-ascending coverage order, with the leaf count pinned
by the signed ``coverage_bytes / TILE_BYTES``.
"""

from __future__ import annotations

from blake3 import blake3

from .spec import TILE_BYTES, sketch_tiles
import numpy as np

U32_LIMIT = 1 << 32
U64_LIMIT = 1 << 64
HASH_BYTES = 32


def _is_uint(value: object, limit: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < limit


def derive_slot_seed(global_challenge: bytes, device_id: bytes) -> int:
    """First 4 LE bytes of ``blake3(global_challenge || device_id)`` (u32).

    Public and per-device: two honest devices covering the same model derive
    different slot seeds, so their committed sketch values differ by
    construction. This is the basis of cross-device audit.
    """
    if len(global_challenge) != 32 or len(device_id) != 32:
        raise ValueError("global_challenge and device_id must be 32 bytes")
    digest = blake3(bytes(global_challenge) + bytes(device_id)).digest()
    return int.from_bytes(digest[:4], "little")


def weights_leaf(tile_index: int, tile: bytes) -> bytes:
    """``blake3(LE64 tile_index || tile_bytes)`` over a canonical 4 KiB tile."""
    if not _is_uint(tile_index, U64_LIMIT):
        raise ValueError("tile_index out of u64 range")
    if not isinstance(tile, (bytes, bytearray)) or len(tile) != TILE_BYTES:
        raise ValueError("tile must be exactly TILE_BYTES")
    return blake3(int(tile_index).to_bytes(8, "little") + bytes(tile)).digest()


def partials_leaf(tile_index: int, sketch: int) -> bytes:
    """``blake3(LE64 tile_index || LE32 s_tile)``."""
    if not _is_uint(tile_index, U64_LIMIT) or not _is_uint(sketch, U32_LIMIT):
        raise ValueError("tile_index/sketch out of range")
    return blake3(
        int(tile_index).to_bytes(8, "little") + int(sketch).to_bytes(4, "little")
    ).digest()


def merkle_parent(left: bytes, right: bytes) -> bytes:
    return blake3(bytes(left) + bytes(right)).digest()


def merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        return blake3(b"").digest()
    level = list(leaves)
    while len(level) > 1:
        level = [
            merkle_parent(
                level[i], level[i + 1] if i + 1 < len(level) else level[i]
            )
            for i in range(0, len(level), 2)
        ]
    return level[0]


def merkle_proof(leaves: list[bytes], index: int) -> list[bytes]:
    if not leaves or index < 0 or index >= len(leaves):
        raise ValueError("Merkle proof index is outside the tree")
    proof: list[bytes] = []
    level = list(leaves)
    while len(level) > 1:
        sibling = index - 1 if index % 2 else index + 1
        proof.append(level[sibling] if sibling < len(level) else level[index])
        level = [
            merkle_parent(
                level[i], level[i + 1] if i + 1 < len(level) else level[i]
            )
            for i in range(0, len(level), 2)
        ]
        index //= 2
    return proof


def merkle_verify_counted(
    root: bytes, leaf: bytes, index: int, leaf_count: int, proof: list[bytes]
) -> bool:
    """Verify inclusion in a duplicate-last tree with a pinned leaf count.

    The leaf count is authenticated out of band (signed ``coverage_bytes``),
    so the duplicate-last padding at each odd boundary is checked rather than
    trusted — a prover cannot silently shorten the tree.
    """
    if (
        not _is_uint(index, U64_LIMIT)
        or not _is_uint(leaf_count, U64_LIMIT)
        or leaf_count == 0
        or index >= leaf_count
    ):
        return False
    acc = leaf
    width = leaf_count
    p = 0
    while width > 1:
        if p >= len(proof):
            return False
        sibling = proof[p]
        if index % 2 == 0:
            if index + 1 == width and sibling != acc:
                return False
            acc = merkle_parent(acc, sibling)
        else:
            acc = merkle_parent(sibling, acc)
        index //= 2
        width = (width + 1) // 2
        p += 1
    return p == len(proof) and acc == root


def sketch_one_tile(slot_seed: int, tile_index: int, tile: bytes) -> int:
    """Recompute a single tile's s_tile from its bytes (verifier side)."""
    if not isinstance(tile, (bytes, bytearray)) or len(tile) != TILE_BYTES:
        raise ValueError("tile must be exactly TILE_BYTES")
    buf = np.frombuffer(bytes(tile), dtype=np.uint8)
    # sketch_tiles is defined for tile 0..n; shift the coefficients to the
    # tile's real index by sketching a buffer positioned at that index.
    return int(_sketch_at(slot_seed, tile_index, buf))


def _sketch_at(slot_seed: int, tile_index: int, tile_bytes: np.ndarray) -> int:
    from .spec import tile_coeffs, TILE_WORDS, M32

    words = tile_bytes.view("<u4").astype(np.uint64)
    coeffs = tile_coeffs(slot_seed, int(tile_index))
    return int((coeffs * words).sum() & M32)


def verify_committed_opening(
    partials_root: bytes,
    leaf_count: int,
    slot_seed: int,
    tile_index: int,
    sketch: int,
    proof: list[bytes],
    position: int,
) -> bool:
    """A committed opening: the prover reveals (tile_index, s_tile) at a
    coverage position and proves it is the committed partials leaf there."""
    leaf = partials_leaf(tile_index, sketch)
    return merkle_verify_counted(partials_root, leaf, position, leaf_count, proof)


def verify_non_inclusion(
    partials_root: bytes,
    leaf_count: int,
    challenged_tile: int,
    left: dict,
    right: dict,
    left_proof: list[bytes],
    right_proof: list[bytes],
) -> bool:
    """Prove a challenged tile index is *not* in the coverage set.

    Two committed partials leaves at adjacent positions bracket the challenged
    index: ``left.tile_idx < challenged_tile < right.tile_idx`` and
    ``left.index + 1 == right.index``. Because coverage is strictly ascending,
    no covered leaf can lie between them, so the challenged tile is provably
    uncovered. (Boundary cases before the first or after the last covered leaf
    are handled by the deployment adapter; this is the interior case.)
    """
    if not _is_uint(leaf_count, U64_LIMIT) or leaf_count == 0:
        return False
    if not _is_uint(challenged_tile, U64_LIMIT):
        return False
    li, ri = left["index"], right["index"]
    for value, limit in (
        (left["tile_idx"], U64_LIMIT), (left["s_tile"], U32_LIMIT), (li, U64_LIMIT),
        (right["tile_idx"], U64_LIMIT), (right["s_tile"], U32_LIMIT), (ri, U64_LIMIT),
    ):
        if not _is_uint(value, limit):
            return False
    if not (li < leaf_count and ri < leaf_count):
        return False
    if li + 1 != ri:
        return False
    if not left["tile_idx"] < challenged_tile < right["tile_idx"]:
        return False
    lleaf = partials_leaf(left["tile_idx"], left["s_tile"])
    rleaf = partials_leaf(right["tile_idx"], right["s_tile"])
    return merkle_verify_counted(
        partials_root, lleaf, li, leaf_count, left_proof
    ) and merkle_verify_counted(
        partials_root, rleaf, ri, leaf_count, right_proof
    )


def fraud_verdict(
    slot_seed: int,
    partials_root: bytes,
    weights_root: bytes,
    leaf_count: int,
    weights_count: int,
    tile_index: int,
    tile: bytes,
    committed_sketch: int,
    partials_position: int,
    partials_proof: list[bytes],
    weights_proof: list[bytes],
) -> str:
    """Adjudicate a tile fraud proof.

    Returns ``"fraud"`` when the committed sketch does not match the sketch
    recomputed from the opened canonical tile bytes (and both openings verify),
    ``"no_fraud"`` when it matches, and ``"invalid"`` when either opening fails
    or an input is out of domain. The weights opening binds the exact tile
    bytes to the committed weights root; the partials opening binds the
    challenged sketch; the recomputation is the algebraic check between them.
    """
    if not isinstance(tile, (bytes, bytearray)) or len(tile) != TILE_BYTES:
        return "invalid"
    if not _is_uint(committed_sketch, U32_LIMIT):
        return "invalid"
    wleaf = weights_leaf(tile_index, tile)
    if not merkle_verify_counted(
        weights_root, wleaf, tile_index, weights_count, weights_proof
    ):
        return "invalid"
    pleaf = partials_leaf(tile_index, committed_sketch)
    if not merkle_verify_counted(
        partials_root, pleaf, partials_position, leaf_count, partials_proof
    ):
        return "invalid"
    recomputed = sketch_one_tile(slot_seed, tile_index, tile)
    return "no_fraud" if recomputed == committed_sketch else "fraud"
