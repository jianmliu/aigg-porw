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
    # unoptimized NumPy reference sketch (compute/allocation-bound)
    seconds_median: float
    seconds_best: float
    gib_s_median: float
    gib_s_best: float
    # single-threaded streaming read (one core's pull)
    baseline_read_gib_s: float
    # aggregate streaming read across all cores (the honest memory ceiling for
    # a threaded kernel); equals baseline when the SIMD library is unavailable
    read_gib_s_aggregate: float = 0.0
    # CPU SIMD sketch kernel (bit-exact, threaded); None when unavailable
    simd_backend: str | None = None
    simd_threads: int = 0
    simd_seconds_median: float | None = None
    simd_gib_s_median: float | None = None
    simd_gib_s_best: float | None = None


def measure_dram_bandwidth(
    buf: np.ndarray, slot_seed: int, repeats: int = 5, chunk_tiles: int = 4096
) -> BandwidthResult:
    """Time the sketch over the resident buffer three ways.

    - the unoptimized NumPy reference (rate is scale-invariant, so it is timed
      once on at most a 64 MiB tile-aligned prefix to keep large runs quick);
    - the CPU SIMD kernel (bit-exact, threaded) over the whole buffer, timed
      ``repeats`` times — this is the verifiable audit rate;
    - a streaming-read baseline, single-threaded (one core) and aggregate
      (all cores), which is the honest memory ceiling for a threaded kernel.
    """
    gib = buf.nbytes / (1 << 30)

    # reference: bounded prefix, single timing
    ref_bytes = min(buf.nbytes, (64 << 20) // TILE_BYTES * TILE_BYTES)
    ref_view = np.ascontiguousarray(buf[:ref_bytes])
    sketch_stream(ref_view, slot_seed, chunk_tiles)  # warm
    t0 = time.perf_counter()
    sketch_stream(ref_view, slot_seed, chunk_tiles)
    ref_s = time.perf_counter() - t0
    ref_gib_s = (ref_bytes / (1 << 30)) / ref_s if ref_s > 0 else 0.0
    # express as time-equivalent over the full buffer for the seconds fields
    ref_full_s = gib / ref_gib_s if ref_gib_s > 0 else 0.0

    # single-core streaming read
    u64 = buf.view("<u8")
    b0 = time.perf_counter()
    _ = int(u64.sum())
    base_s = time.perf_counter() - b0
    base_gib_s = gib / base_s if base_s > 0 else 0.0

    simd_backend = None
    simd_threads = 0
    simd_med = simd_best = None
    agg_gib_s = base_gib_s
    try:
        from . import simd as _simd

        if _simd.available():
            import os

            simd_backend = _simd.backend()
            simd_threads = os.cpu_count() or 1
            _simd.sketch_tiles_simd(buf, slot_seed)  # warm
            ts = []
            for _ in range(repeats):
                t0 = time.perf_counter()
                _simd.sketch_tiles_simd(buf, slot_seed)
                ts.append(time.perf_counter() - t0)
            ts.sort()
            simd_med, simd_best = ts[len(ts) // 2], ts[0]
            # aggregate read: same threading as the kernel
            _simd.read_sum(buf)  # warm
            rs = []
            for _ in range(max(3, repeats)):
                t0 = time.perf_counter()
                _simd.read_sum(buf)
                rs.append(time.perf_counter() - t0)
            rs.sort()
            agg_s = rs[len(rs) // 2]
            agg_gib_s = gib / agg_s if agg_s > 0 else base_gib_s
    except Exception:
        simd_backend = None

    return BandwidthResult(
        bytes_streamed=int(buf.nbytes),
        repeats=repeats,
        seconds_median=round(ref_full_s, 6),
        seconds_best=round(ref_full_s, 6),
        gib_s_median=round(ref_gib_s, 3),
        gib_s_best=round(ref_gib_s, 3),
        baseline_read_gib_s=round(base_gib_s, 3),
        read_gib_s_aggregate=round(agg_gib_s, 3),
        simd_backend=simd_backend,
        simd_threads=simd_threads,
        simd_seconds_median=round(simd_med, 6) if simd_med is not None else None,
        simd_gib_s_median=round(gib / simd_med, 3) if simd_med else None,
        simd_gib_s_best=round(gib / simd_best, 3) if simd_best else None,
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
