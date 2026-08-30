"""PoRW sketch-tile v2 research implementation reference in NumPy.

Normative authority lives in the tagged private ``aigg-spec`` release. This
module preserves the canonical v2 integer arithmetic over bytes as stored in
device memory. It is an algebraic consistency check, not proof of byte
equality, residency, inference execution, or financial entitlement.
"""

import numpy as np

SCHEME_ID = "aigg:porw:sketch-tile:v2"
TILE_BYTES = 4096
WORD_BYTES = 4
TILE_WORDS = TILE_BYTES // WORD_BYTES
GOLDEN32 = 0x9E3779B9
FMIX_M1 = 0x85EBCA6B
FMIX_M2 = 0xC2B2AE35
M32 = 0xFFFFFFFF

# Private memory policy: each batch covers at most 1 MiB of input. The uint64
# words, coefficients, and multiplication result therefore remain bounded;
# only the one-u64-per-tile output scales with the full input.
_SKETCH_BATCH_TILES = 256


def _require_u32(value: int, name: str) -> None:
    if type(value) is not int:
        raise TypeError(f"{name} must be an exact integer")
    if not 0 <= value <= M32:
        raise ValueError(f"{name} must be within the u32 range")


def fmix32(h: np.ndarray) -> np.ndarray:
    """Return the vectorized Murmur3 32-bit finalizer for uint64 values."""
    if type(h) is not np.ndarray or h.dtype != np.dtype(np.uint64):
        raise TypeError("h must be an exact numpy.ndarray with dtype uint64")

    result = h.copy()
    result &= np.uint64(M32)
    result ^= result >> np.uint64(16)
    result &= np.uint64(M32)
    result *= np.uint64(FMIX_M1)
    result &= np.uint64(M32)
    result ^= result >> np.uint64(13)
    result &= np.uint64(M32)
    result *= np.uint64(FMIX_M2)
    result &= np.uint64(M32)
    result ^= result >> np.uint64(16)
    result &= np.uint64(M32)
    return result


def tile_coeffs(slot_seed: int, tile_idx: np.ndarray | int) -> np.ndarray:
    """Return odd per-word coefficients with shape ``tile_idx.shape + (1024,)``.

    A scalar exact integer tile index produces a one-dimensional result.
    Arrays must be exact ``numpy.ndarray`` instances with dtype ``uint64``;
    implicit list, scalar, dtype, and subclass coercions are rejected.
    """
    _require_u32(slot_seed, "slot_seed")
    if type(tile_idx) is int:
        if not 0 <= tile_idx <= np.iinfo(np.uint64).max:
            raise ValueError("tile_idx must be within the u64 range")
        tile_indices = np.array(tile_idx, dtype=np.uint64)
    elif type(tile_idx) is np.ndarray and tile_idx.dtype == np.dtype(np.uint64):
        tile_indices = tile_idx
    else:
        raise TypeError(
            "tile_idx must be an exact integer or exact numpy.ndarray with dtype uint64"
        )

    mixed_seed = np.array((slot_seed & M32) ^ tile_indices, dtype=np.uint64)
    r_tile = fmix32(fmix32(mixed_seed))
    word_indices = np.arange(TILE_WORDS, dtype=np.uint64)
    return fmix32(r_tile[..., None] + (word_indices * GOLDEN32 & M32)) | 1


def _sketch_tile_batch(slot_seed: int, buf: np.ndarray, first_tile_index: int) -> np.ndarray:
    n_tiles = buf.size // TILE_BYTES
    if n_tiles > _SKETCH_BATCH_TILES:
        raise ValueError("internal sketch batch exceeds the private tile cap")

    # Every view and conversion is scoped to this bounded batch. Absolute tile
    # indices are retained across batches because they are part of the v2
    # coefficient preimage.
    words = buf.view("<u4").reshape(n_tiles, TILE_WORDS).astype(np.uint64)
    tile_indices = np.arange(first_tile_index, first_tile_index + n_tiles, dtype=np.uint64)
    coefficients = tile_coeffs(slot_seed, tile_indices)
    return (coefficients * words).sum(axis=1) & M32


def sketch_tiles(slot_seed: int, buf: np.ndarray) -> np.ndarray:
    """Return one canonical u32-valued sketch per 4096-byte tile.

    ``buf`` must be an exact, C-contiguous, one-dimensional uint8 ndarray.
    Read-only arrays, including ``numpy.frombuffer(bytes, dtype=uint8)``, are
    accepted because the function never mutates the input.
    """
    _require_u32(slot_seed, "slot_seed")
    if type(buf) is not np.ndarray or buf.dtype != np.dtype(np.uint8):
        raise TypeError("buf must be an exact numpy.ndarray with dtype uint8")
    if buf.ndim != 1:
        raise ValueError("buf must be one-dimensional")
    if not buf.flags.c_contiguous:
        raise ValueError("buf must be C-contiguous")
    if buf.size % TILE_BYTES != 0:
        raise ValueError("buf length must be a multiple of TILE_BYTES")

    n_tiles = buf.size // TILE_BYTES
    sketches = np.empty(n_tiles, dtype=np.uint64)
    for first_tile_index in range(0, n_tiles, _SKETCH_BATCH_TILES):
        last_tile_index = min(first_tile_index + _SKETCH_BATCH_TILES, n_tiles)
        first_byte = first_tile_index * TILE_BYTES
        last_byte = last_tile_index * TILE_BYTES
        sketches[first_tile_index:last_tile_index] = _sketch_tile_batch(
            slot_seed,
            buf[first_byte:last_byte],
            first_tile_index,
        )
    return sketches
