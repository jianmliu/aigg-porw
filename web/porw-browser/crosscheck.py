"""Bit-exact cross-check of the browser's sketches against the native kernel.

Reproduces the browser's deterministic test payload exactly —
``word[i] = fmix32(i*GOLDEN32 + seed)`` — sketches it with the native C SIMD
kernel (itself locked to the NumPy reference and the conformance vectors), and
compares every value with what headless Chromium computed (``result.json``
from ``run_browser.mjs``). Any mismatch is a hard failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[2] / "gpu" / "triton"))

from porw_sketch.spec import GOLDEN32, M32, TILE_BYTES, fmix32
from experiments.cpu_memory import simd


def browser_pattern(n_words: int, seed: int) -> np.ndarray:
    i = np.arange(n_words, dtype=np.uint64)
    words = fmix32((i * GOLDEN32 + seed) & M32).astype("<u4")
    return words.view(np.uint8)


def main(path: str) -> int:
    r = json.loads(Path(path).read_text())
    n_tiles, seed, slot = int(r["nTiles"]), int(r["seed"]), int(r["slotSeed"])
    buf = np.ascontiguousarray(browser_pattern(n_tiles * TILE_BYTES // 4, seed))
    native = simd.sketch_tiles_simd(buf, slot)
    ok = True
    for key in ("sketchesSingle", "sketchesMulti"):
        if key not in r:
            continue
        got = np.asarray(r[key], dtype=np.uint32)
        same = got.shape == native.shape and bool(np.array_equal(got, native))
        print(f"{key:14} n={got.size:,}  bit-exact vs native [{simd.backend()}]: {same}")
        ok &= same
    print("browser backend:", r.get("backend"), "| chromium:", r.get("chromium"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else str(_HERE.parent / "result.json")))
