"""Bit-exactness and API tests for the CPU SIMD sketch kernel.

The kernel must reproduce ``porw_sketch.spec.sketch_tiles`` exactly — on
contiguous buffers, coverage subsets, non-zero starting tile indices, any
thread count, and every locked conformance sketch case. Skips (does not
silently pass) when no C compiler is available.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from porw_sketch.spec import TILE_BYTES, M32, sketch_tiles, tile_coeffs
from experiments.cpu_memory import simd

pytestmark = pytest.mark.skipif(not simd.available(), reason="no C compiler for the SIMD kernel")

VECTOR = Path(__file__).resolve().parents[3] / "spec-cache" / "conformance" / "porw" / "sketch-tile-v2.json"


def _ref_at(seed: int, tile_idx: int, tile: np.ndarray) -> int:
    w = tile.view("<u4").astype(np.uint64)
    return int((tile_coeffs(seed, int(tile_idx)) * w).sum() & M32)


def test_backend_reports_a_known_path():
    assert simd.backend() in ("avx2", "scalar")


@pytest.mark.parametrize("seed", [0, 1, 0xDEADBEEF, 0xFFFFFFFF, 429935650])
@pytest.mark.parametrize("threads", [1, 3, 0])
def test_contiguous_bit_exact(seed, threads):
    rng = np.random.default_rng(seed & 0xFFFF)
    buf = rng.integers(0, 256, size=97 * TILE_BYTES, dtype=np.uint8)
    ref = sketch_tiles(seed, buf).astype(np.uint32)
    assert np.array_equal(simd.sketch_tiles_simd(buf, seed, threads=threads), ref)


def test_subset_and_offset_bit_exact():
    rng = np.random.default_rng(9)
    buf = rng.integers(0, 256, size=200 * TILE_BYTES, dtype=np.uint8)
    tiles = buf.reshape(200, TILE_BYTES)
    ids = np.sort(rng.choice(200, size=61, replace=False)).astype(np.int64)
    ref_ids = np.array([_ref_at(7, t, tiles[t]) for t in ids], dtype=np.uint32)
    assert np.array_equal(simd.sketch_tiles_simd(buf, 7, tile_ids=ids), ref_ids)
    sub = np.ascontiguousarray(buf[50 * TILE_BYTES : 120 * TILE_BYTES])
    ref_off = np.array([_ref_at(7, t, tiles[t]) for t in range(50, 120)], dtype=np.uint32)
    assert np.array_equal(simd.sketch_tiles_simd(sub, 7, first_tile_idx=50), ref_off)


def test_conformance_sketch_cases_bit_exact():
    v = json.loads(VECTOR.read_text(encoding="utf-8"))
    mask64 = (1 << 64) - 1
    n = v["reference_buffer"]["n_tiles"]
    buf = np.frombuffer(
        bytes(((((i * 2654435761) & mask64) >> 7) & 0xFF) for i in range(n * TILE_BYTES)),
        dtype=np.uint8,
    ).copy()
    assert v["sketches"], "vector has no sketch cases"
    for case in v["sketches"]:
        exp = np.array(case["per_tile"], dtype=np.uint32)
        assert np.array_equal(simd.sketch_tiles_simd(buf, int(case["slot_seed"])), exp)


def test_read_sum_matches_numpy():
    rng = np.random.default_rng(3)
    buf = rng.integers(0, 256, size=16 * TILE_BYTES, dtype=np.uint8)
    assert simd.read_sum(buf, threads=0) == int(buf.view("<u8").sum())
    assert simd.read_sum(buf, threads=1) == int(buf.view("<u8").sum())


def test_rejects_bad_inputs():
    buf = np.zeros(2 * TILE_BYTES, dtype=np.uint8)
    with pytest.raises(ValueError):
        simd.sketch_tiles_simd(np.zeros(100, dtype=np.uint8), 1)  # not tile-aligned
    with pytest.raises(ValueError):
        simd.sketch_tiles_simd(buf, 1 << 32)  # seed not u32
    with pytest.raises(ValueError):
        simd.sketch_tiles_simd(buf, 1, tile_ids=np.array([5], dtype=np.int64))  # out of range
