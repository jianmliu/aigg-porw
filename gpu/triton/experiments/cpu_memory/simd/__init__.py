"""ctypes loader for the CPU SIMD sketch kernel (``sketch_simd.c``).

Builds the shared object on demand with the system C compiler into a cache
directory beside this file (git-ignored), then loads it via ctypes. No new
Python dependencies. If no compiler is available the loader raises
:class:`SimdUnavailable` so callers can fall back to the NumPy reference and
say so explicitly — the kernel is never silently substituted by a slower path
in a benchmark.

Bit-exactness against ``porw_sketch.spec.sketch_tiles`` is enforced by
``tests/test_simd_sketch.py``.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

from porw_sketch.spec import TILE_BYTES

_HERE = Path(__file__).resolve().parent
_SRC = _HERE / "sketch_simd.c"
_CACHE = _HERE / ".build"

_CFLAGS = ["-O3", "-fPIC", "-shared", "-std=c11", "-pthread", "-Wall", "-Wextra"]


class SimdUnavailable(RuntimeError):
    pass


def _compiler() -> str | None:
    for c in (os.environ.get("CC"), "cc", "gcc", "clang"):
        if c and shutil.which(c):
            return c
    return None


def _so_path() -> Path:
    # key the artifact by source hash + flags so edits rebuild automatically
    h = hashlib.blake2b(_SRC.read_bytes() + " ".join(_CFLAGS).encode(), digest_size=8).hexdigest()
    return _CACHE / f"sketch_simd-{h}.so"


def _build() -> Path:
    so = _so_path()
    if so.exists():
        return so
    cc = _compiler()
    if cc is None:
        raise SimdUnavailable("no C compiler (cc/gcc/clang) found; set CC or install one")
    _CACHE.mkdir(parents=True, exist_ok=True)
    tmp = so.with_suffix(".so.tmp")
    cmd = [cc, *_CFLAGS, "-o", str(tmp), str(_SRC)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SimdUnavailable(f"kernel build failed:\n{' '.join(cmd)}\n{proc.stderr}")
    os.replace(tmp, so)
    return so


_lib = None


def _load():
    global _lib
    if _lib is not None:
        return _lib
    lib = ctypes.CDLL(str(_build()))
    lib.porw_simd_backend.restype = ctypes.c_int
    lib.porw_simd_backend.argtypes = []
    lib.porw_sketch_tiles.restype = ctypes.c_int
    lib.porw_sketch_tiles.argtypes = [
        ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int,
    ]
    lib.porw_sketch_tile_ids.restype = ctypes.c_int
    lib.porw_sketch_tile_ids.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int,
    ]
    lib.porw_read_sum.restype = ctypes.c_int
    lib.porw_read_sum.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_int, ctypes.c_void_p]
    _lib = lib
    return lib


def available() -> bool:
    try:
        _load()
        return True
    except SimdUnavailable:
        return False


def backend() -> str:
    """'avx2' or 'scalar' — which code path the running CPU dispatches to."""
    return "avx2" if _load().porw_simd_backend() == 1 else "scalar"


def sketch_tiles_simd(
    buf: np.ndarray,
    slot_seed: int,
    tile_ids: np.ndarray | None = None,
    first_tile_idx: int = 0,
    threads: int = 0,
) -> np.ndarray:
    """Per-tile u32 sketches over a uint8 buffer, computed by the C kernel.

    ``tile_ids`` (int64, strictly ascending) selects a coverage subset — each
    entry is both the buffer tile offset and the coefficient index. Without it,
    every tile of ``buf`` is sketched, with coefficient indices starting at
    ``first_tile_idx``. ``threads<=0`` uses all online CPUs.
    """
    if buf.dtype != np.uint8 or buf.ndim != 1 or not buf.flags.c_contiguous:
        raise ValueError("buf must be a contiguous 1-D uint8 array")
    if buf.size % TILE_BYTES != 0:
        raise ValueError("buf length must be a multiple of TILE_BYTES")
    if not (0 <= slot_seed < (1 << 32)):
        raise ValueError("slot_seed must be u32")
    lib = _load()
    n_all = buf.size // TILE_BYTES
    if tile_ids is None:
        out = np.empty(n_all, dtype=np.uint32)
        rc = lib.porw_sketch_tiles(
            buf.ctypes.data, n_all, int(first_tile_idx), int(slot_seed), out.ctypes.data, int(threads)
        )
    else:
        ids = np.ascontiguousarray(tile_ids, dtype=np.int64)
        if ids.ndim != 1:
            raise ValueError("tile_ids must be 1-D")
        if ids.size and (ids.min() < 0 or ids.max() >= n_all):
            raise ValueError("tile_ids out of range")
        out = np.empty(ids.size, dtype=np.uint32)
        rc = lib.porw_sketch_tile_ids(
            buf.ctypes.data, ids.ctypes.data, ids.size, int(slot_seed), out.ctypes.data, int(threads)
        )
    if rc != 0:
        raise RuntimeError(f"simd kernel returned {rc}")
    return out


def read_sum(buf: np.ndarray, threads: int = 0) -> int:
    """Threaded streaming read of the whole buffer (u64 sum) — the aggregate
    DRAM read-bandwidth probe that is apples-to-apples with the threaded
    sketch. ``threads<=0`` uses all online CPUs."""
    if buf.dtype != np.uint8 or buf.ndim != 1 or not buf.flags.c_contiguous:
        raise ValueError("buf must be a contiguous 1-D uint8 array")
    lib = _load()
    out = np.zeros(1, dtype=np.uint64)
    rc = lib.porw_read_sum(buf.ctypes.data, buf.size, int(threads), out.ctypes.data)
    if rc != 0:
        raise RuntimeError(f"read_sum returned {rc}")
    return int(out[0])
