"""PoRW sketch — research implementation reference in NumPy.

Normative authority lives in the tagged private aigg-spec release. This module
is an executable implementation reference, not the canonical specification.

Scheme v2 implementation (u32-optimized, PoC parameters):

- The input weight buffer is a byte array (the bytes as stored in HBM:
  fp16/bf16/int8/fp4 — the sketch is over stored bytes, not decoded values).
- Scheme word: **32-bit** little-endian word ``w_j`` (index j over the buffer).
- Scheme tile: TILE_BYTES = 4096 bytes = TILE_WORDS = 1024 words.
- Per-slot input: ``slot_seed`` (u32). Its derivation and identity binding are
  deployment-adapter responsibilities.

Coefficients and linear sketch arithmetic:

    r_tile     = fmix32(fmix32(slot_seed ^ tile_idx))
    c_j        = fmix32(r_tile + (j_in_tile * GOLDEN32)) | 1  # per word, odd
    s_tile     = sum_j c_j * w_j   mod 2^32                   # per tile
    sketch     = fold of all covered s_tile                    # global

All operations wrap mod 2^32.  Order-independence: s_tile is a sum mod 2^32,
so any kernel decomposition (any block shape, any launch order, atomic or
idempotent accumulation) yields the same value as long as every covered word
contributes exactly once per slot.

All arithmetic is integer and exact — independent of GPU FP behavior. Odd
coefficients prevent one word's MSB delta from disappearing on its own, but do
not make this linear sketch collision resistant. For every slot seed and tile,
two word-MSB deltas cancel deterministically because
``2^31 * (c_p + c_q) = 0 mod 2^32`` for odd ``c_p`` and ``c_q``.

The sketch is an algebraic consistency check. It does not prove byte equality,
residency, or inference execution. Cryptographic Merkle openings separately
authenticate sampled bytes, subject to deployment admission and challenge
assumptions.
"""

import numpy as np

TILE_BYTES = 4096
WORD_BYTES = 4
TILE_WORDS = TILE_BYTES // WORD_BYTES
GOLDEN32 = 0x9E3779B9
FMIX_M1 = 0x85EBCA6B
FMIX_M2 = 0xC2B2AE35
M32 = 0xFFFFFFFF


def fmix32(h: np.ndarray) -> np.ndarray:
    """murmur3 32-bit finalizer, vectorized, on uint64 arrays masked to u32.

    The reference uses uint64 + explicit masking; the Triton kernels use
    native u32 wrapping arithmetic — bit-identical by construction.
    """
    h = h & M32
    h = (h ^ (h >> 16)) & M32
    h = (h * FMIX_M1) & M32
    h = (h ^ (h >> 13)) & M32
    h = (h * FMIX_M2) & M32
    h = (h ^ (h >> 16)) & M32
    return h


def tile_coeffs(slot_seed: int, tile_idx: np.ndarray | int) -> np.ndarray:
    """Per-word coefficients for one or more tiles.

    Returns shape (..., TILE_WORDS) uint64 (values < 2^32).
    """
    tile_idx = np.asarray(tile_idx, dtype=np.uint64)
    r_tile = fmix32(fmix32((slot_seed & M32) ^ tile_idx))
    j = np.arange(TILE_WORDS, dtype=np.uint64)
    # ``| 1`` prevents a single word's bit-31 delta from vanishing. It does
    # not prevent deterministic cancellation between two word-MSB deltas.
    return fmix32(r_tile[..., None] + (j * GOLDEN32 & M32)) | 1


def sketch_tiles(slot_seed: int, buf: np.ndarray) -> np.ndarray:
    """Reference sketch: per-tile s_tile over a contiguous byte buffer.

    buf: uint8 array, length a multiple of TILE_BYTES.
    Returns uint64 array (values < 2^32), one entry per tile.
    """
    assert buf.dtype == np.uint8 and buf.size % TILE_BYTES == 0
    words = buf.view("<u4").astype(np.uint64).reshape(-1, TILE_WORDS)
    n_tiles = words.shape[0]
    coeffs = tile_coeffs(slot_seed, np.arange(n_tiles, dtype=np.uint64))
    return (coeffs * words).sum(axis=1) & M32


def sketch_tiles_broken_per_tile_coeff(slot_seed: int, buf: np.ndarray) -> np.ndarray:
    """The BROKEN variant (per-tile constant coefficient) used by the attack
    demo in tests: s_tile = r_tile * sum_j(w_j).  An adversary who stores only
    sum_j(w_j) (4 bytes per 4096-byte tile) reproduces this for every slot.
    """
    assert buf.dtype == np.uint8 and buf.size % TILE_BYTES == 0
    words = buf.view("<u4").astype(np.uint64).reshape(-1, TILE_WORDS)
    n_tiles = words.shape[0]
    r_tile = fmix32(
        fmix32((slot_seed & M32) ^ np.arange(n_tiles, dtype=np.uint64))
    )
    return (r_tile * (words.sum(axis=1) & M32)) & M32
