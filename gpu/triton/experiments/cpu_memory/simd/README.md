# CPU SIMD sketch kernel

A bit-exact, multi-core CPU implementation of the scheme-v2 tile sketch, so the
*verifiable* audit runs at memory bandwidth on an ordinary computer instead of
at the unoptimized NumPy reference's ~0.08 GiB/s.

- `sketch_simd.c` — one binary, two code paths chosen at runtime: **AVX2**
  (8 × u32 lanes; the ordinary-computer baseline) and a portable **scalar**
  fallback. Tiles are independent, so the driver splits them across pthreads
  to pull the whole memory system's bandwidth. Also exports a threaded
  streaming-read probe (`porw_read_sum`) as the apples-to-apples memory
  ceiling for the threaded kernel.
- `__init__.py` — builds the shared object on demand with the system C
  compiler into a git-ignored cache keyed by source hash, loads it via ctypes.
  No new Python dependencies. If no compiler is present it raises
  `SimdUnavailable`; callers fall back to the NumPy reference **and say so** —
  a benchmark never silently swaps in a slower path.

## Exactness

All arithmetic is u32 wrapping, so the AVX2 lanes compute exactly what the
scalar path and the NumPy reference compute. `tests/test_simd_sketch.py`
enforces bit-exactness on contiguous buffers, coverage subsets, non-zero
starting tile indices, every thread count, and every locked conformance sketch
case in `spec-cache/conformance/porw/sketch-tile-v2.json`.

## Measured (4-core Xeon, no GPU, FlyWire-scale 520.8 MiB model)

| | rate | time per full audit |
|---|---|---|
| NumPy reference | ~0.08 GiB/s | ~6.5 s |
| SIMD, 1 thread | ~9 GiB/s | ~56 ms |
| SIMD, 4 threads | ~25–33 GiB/s | **~16–21 ms** |

That is roughly ×100 (one thread) to ×300–400 (four threads) over the
reference, with no change to the scheme. The 4-thread rate exceeds a *single
core's* streaming read (~11 GiB/s) — which is the point: the kernel is
memory-bound and scales with cores, so the honest ceiling to compare against
is the *aggregate* multi-core read rate, measured the same threaded way:
~31–42 GiB/s on this host, of which the sketch reaches about two-thirds (the
remaining gap is the per-word fmix32 arithmetic). Run-to-run spread is a
shared cloud VM's normal variance.

## Why it matters for the ordinary-computer goal

With the reference sketch, hosting the fly brain on a laptop was fine but
*auditing* it took seconds. With the SIMD kernel a full verifiable audit of the
521 MiB model takes tens of milliseconds — well inside a 100 ms slot with
headroom — so residency, audit, and (memory-bound) inference all fit an
ordinary computer's budget.
