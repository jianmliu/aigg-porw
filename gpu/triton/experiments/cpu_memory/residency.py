"""CPU-DRAM residency primitives for the PoRW memory experiment.

PoRW's physical argument is a bandwidth envelope: a device that truly holds the
weights resident can stream the covered bytes within a slot at its memory
bandwidth; one that fetches them from slow storage on demand cannot. On a GPU
that bandwidth is HBM; on a CPU it is DRAM. This module measures the DRAM side:

- lock the weight buffer resident in RAM (``mlock``, non-swappable) — the CPU
  analog of VRAM residency;
- stream a sketch over the whole buffer with bounded extra memory, so the timed
  rate reflects reading the *weights* from DRAM, not materializing a giant
  coefficient matrix;
- turn the measured rate into the PoRW envelope: how large a model can be
  covered within one slot.

The streaming sketch is bit-identical to :func:`porw_sketch.spec.sketch_tiles`;
it only bounds peak memory so the measurement is a real streaming rate.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import resource
import time
from dataclasses import dataclass

import numpy as np

from porw_sketch.spec import GOLDEN32, M32, TILE_BYTES, TILE_WORDS, fmix32

_libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)


def max_rss_bytes() -> int:
    """Peak resident set size of this process (Linux reports KiB)."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def mlock(buf: np.ndarray) -> bool:
    """Lock the buffer's pages resident (non-swappable). False if not permitted."""
    if buf.nbytes == 0:
        return True
    res = _libc.mlock(ctypes.c_void_p(buf.ctypes.data), ctypes.c_size_t(buf.nbytes))
    return res == 0


def munlock(buf: np.ndarray) -> bool:
    if buf.nbytes == 0:
        return True
    res = _libc.munlock(ctypes.c_void_p(buf.ctypes.data), ctypes.c_size_t(buf.nbytes))
    return res == 0


def sketch_stream(buf: np.ndarray, slot_seed: int, chunk_tiles: int = 4096) -> np.ndarray:
    """Per-tile sketch over a contiguous byte buffer, bounded extra memory.

    Streams the buffer in chunks of ``chunk_tiles`` tiles, recomputing the
    per-word coefficients per chunk (like the GPU kernel) instead of holding
    the whole coefficient matrix. Bit-identical to ``spec.sketch_tiles``.
    """
    if buf.dtype != np.uint8 or buf.size % TILE_BYTES != 0:
        raise ValueError("buf must be uint8 with length a multiple of TILE_BYTES")
    n_tiles = buf.size // TILE_BYTES
    out = np.empty(n_tiles, dtype=np.uint64)
    words_all = buf.view("<u4")  # zero-copy u32 view of the whole buffer
    j = np.arange(TILE_WORDS, dtype=np.uint64)
    jg = (j * GOLDEN32) & M32
    for start in range(0, n_tiles, chunk_tiles):
        stop = min(start + chunk_tiles, n_tiles)
        idx = np.arange(start, stop, dtype=np.uint64)
        r_tile = fmix32(fmix32((slot_seed & M32) ^ idx))
        coeffs = fmix32(r_tile[:, None] + jg) | 1  # (chunk, TILE_WORDS) u64
        w = words_all[start * TILE_WORDS : stop * TILE_WORDS].astype(np.uint64).reshape(-1, TILE_WORDS)
        out[start:stop] = (coeffs * w).sum(axis=1) & M32
    return out


@dataclass(frozen=True)
class BandwidthResult:
    bytes_streamed: int
    repeats: int
    seconds_median: float
    seconds_best: float
    gib_s_median: float
    gib_s_best: float
    baseline_read_gib_s: float


def measure_dram_bandwidth(
    buf: np.ndarray, slot_seed: int, repeats: int = 5, chunk_tiles: int = 4096
) -> BandwidthResult:
    """Time the streaming sketch over the resident buffer, plus a pure-read
    baseline (summing the raw bytes as u64) for context."""
    sketch_stream(buf, slot_seed, chunk_tiles)  # warm caches / allocations
    times = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        sketch_stream(buf, slot_seed, chunk_tiles)
        times.append(time.perf_counter() - t0)
    times.sort()
    med = times[len(times) // 2]
    best = times[0]
    gib = buf.nbytes / (1 << 30)

    u64 = buf.view("<u8")
    b0 = time.perf_counter()
    _ = int(u64.sum())
    base_s = time.perf_counter() - b0

    return BandwidthResult(
        bytes_streamed=int(buf.nbytes),
        repeats=repeats,
        seconds_median=round(med, 6),
        seconds_best=round(best, 6),
        gib_s_median=round(gib / med, 3),
        gib_s_best=round(gib / best, 3),
        baseline_read_gib_s=round(gib / base_s, 3) if base_s > 0 else 0.0,
    )


# A modest "ordinary computer" baseline: what a typical laptop/desktop with no
# GPU offers. The fly brain must clear this with headroom to make the claim
# "an ordinary computer can host, prove, and run it".
COMMODITY_RAM_BYTES = 8 * (1 << 30)
COMMODITY_MIN_CORES = 2
# Leave most of RAM for the OS and the application: budget half of it for the
# resident model.
COMMODITY_MODEL_BUDGET_FRACTION = 0.5


def commodity_feasibility(model_bytes: int) -> dict:
    """Can an ordinary, GPU-less computer host and prove this model?

    Reports the host's actual resources and, separately, whether the model
    clears a fixed commodity baseline (8 GiB RAM, 2 cores, no GPU). It also
    reports whether an *unprivileged* user could mlock the model under the
    current RLIMIT_MEMLOCK — on most laptops that limit is small (8 MiB or
    less), so mlock will NOT be available to ordinary users. Residency does
    not depend on mlock: it is proven by the bandwidth envelope + audit; mlock
    is only an extra non-swappability hardening when available.
    """
    import os

    mem_total = mem_avail = None
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = int(line.split()[1]) * 1024
    except OSError:
        pass
    cores = os.cpu_count() or 1
    soft, _hard = resource.getrlimit(resource.RLIMIT_MEMLOCK)
    unprivileged_mlock_ok = soft == resource.RLIM_INFINITY or model_bytes <= soft
    has_gpu = False
    try:
        import torch  # noqa: F401

        has_gpu = bool(__import__("torch").cuda.is_available())
    except Exception:
        has_gpu = False

    budget = int(COMMODITY_RAM_BYTES * COMMODITY_MODEL_BUDGET_FRACTION)
    fits_commodity_ram = model_bytes <= budget
    fits_this_host = mem_avail is None or model_bytes <= mem_avail * 0.8

    return {
        "commodity_baseline": {
            "ram_gib": COMMODITY_RAM_BYTES / (1 << 30),
            "min_cores": COMMODITY_MIN_CORES,
            "gpu_required": False,
            "model_budget_gib": round(budget / (1 << 30), 2),
        },
        "host": {
            "mem_total_gib": round(mem_total / (1 << 30), 2) if mem_total else None,
            "mem_available_gib": round(mem_avail / (1 << 30), 2) if mem_avail else None,
            "cores": cores,
            "gpu_present": has_gpu,
            "rlimit_memlock_bytes": None if soft == resource.RLIM_INFINITY else int(soft),
        },
        "model_bytes": int(model_bytes),
        "model_fraction_of_commodity_budget": round(model_bytes / budget, 4),
        "fits_commodity_ram": fits_commodity_ram,
        "fits_this_host_ram": fits_this_host,
        "unprivileged_mlock_possible": unprivileged_mlock_ok,
        "residency_requires_mlock": False,
        "runs_on_commodity_pc": bool(fits_commodity_ram and cores >= COMMODITY_MIN_CORES),
    }


def envelope(coverage_bytes: int, bandwidth_gib_s: float, slot_ms: float) -> dict:
    """PoRW bandwidth envelope: can the covered bytes be streamed within a slot?

    ``bandwidth_bytes_per_slot = bandwidth * slot_duration``; a resident device
    clears it, a device fetching from slow storage does not.
    """
    bytes_per_slot = bandwidth_gib_s * (1 << 30) * (slot_ms / 1000.0)
    return {
        "slot_ms": slot_ms,
        "bandwidth_gib_s": bandwidth_gib_s,
        "bytes_per_slot": int(bytes_per_slot),
        "coverage_bytes": int(coverage_bytes),
        "coverage_fits_slot": coverage_bytes <= bytes_per_slot,
        "max_model_mib_per_slot": round(bytes_per_slot / (1 << 20), 1),
    }
