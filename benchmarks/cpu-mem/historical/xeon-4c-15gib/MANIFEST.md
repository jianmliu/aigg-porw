# CPU-DRAM PoRW residency — measured result

A single host's run of `gpu/triton/experiments/cpu_memory/bench_cpu.py` at
FlyWire adult-brain scale. This is a **measured artifact**, not a drift-tested
fixture: the deterministic fields are reproducible anywhere, the bandwidth
fields are specific to this host and load and will differ elsewhere.

## Host

- CPU: Intel(R) Xeon(R) @ 2.80GHz, 4 vCPU
- RAM: 15 GiB, no swap
- Kernel: Linux 6.18 x86_64
- NumPy: 2.0.2 (scipy-openblas 0.3.27), CPython 3.12.13
- Command: `python -m experiments.cpu_memory.bench_cpu --slot-ms 100 --repeats 5 --json`

## Deterministic (reproducible on any host)

These come only from the model bytes and the scheme, so they must match
everywhere for the same payload:

- model: `flywire-adult-brain` synthetic, 139,255 neurons / 54,500,000 synapses
- payload: 133,329 tiles, 520.816 MiB
- `model_id` (weights root): `0x65682031739f6d9f67fd2b6d4d4438a97a11b76074b0041b90cbe4580eb92c32`
- slot_seed, weights_root, partials_root, opening/fraud verdicts: as in the JSON

## Measured (host-specific, non-deterministic)

- DRAM streaming-read bandwidth (residency ceiling): ~10.8–11.0 GiB/s
- reference NumPy sketch rate: ~0.08 GiB/s — this is the unoptimized reference
  implementation's compute rate, **not** a memory-bandwidth number; an
  optimized CPU SIMD kernel would be far higher
- envelope at a 100 ms slot: ~1.1 GiB streamable/slot, so the 521 MiB model
  clears the residency bandwidth envelope

## What this shows

The exact fly-brain model bytes were held resident (mlocked, non-swappable) in
DRAM and stream-audited under a fresh public challenge, with the full PoRW
proof loop (committed opening + honest/lying fraud verdicts) passing. It is the
CPU analog of the native-GPU benchmark; it proves residency, not inference
execution (that is the CPU-TEE adapter's job — see
`gpu/triton/demo/fly_brain/ROADMAP-tee-cpu.md`).
