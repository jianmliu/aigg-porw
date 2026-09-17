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

- DRAM streaming-read bandwidth (residency ceiling): ~11 GiB/s on a single
  core; **~31–42 GiB/s aggregate** across all four cores, measured with the
  same threading as the kernel (the honest ceiling for a threaded sketch)
- **SIMD verifiable sketch** (bit-exact, AVX2, 4 threads): ~25–28 GiB/s —
  roughly two-thirds of the aggregate read ceiling — i.e. a full verifiable
  audit of the 521 MiB model in **~18–21 ms**. Run-to-run spread is a shared
  cloud VM's normal variance, not a scheme property.
- reference NumPy sketch rate: ~0.08–0.10 GiB/s — the unoptimized reference
  implementation's compute rate, **not** a memory-bandwidth number; kept for
  scale and timed on a bounded prefix
- bandwidth envelope at a 100 ms slot: ~3 GiB streamable/slot; **audit
  envelope** (verifiable sketch, not just a raw read): ~2.5–2.9 GiB/slot — the
  521 MiB model clears both with ~5× headroom

## What this shows

The exact fly-brain model bytes were held resident (mlocked, non-swappable) in
DRAM and stream-audited under a fresh public challenge, with the full PoRW
proof loop (committed opening + honest/lying fraud verdicts) passing. It is the
CPU analog of the native-GPU benchmark; it proves residency, not inference
execution (that is the CPU-TEE adapter's job — see
`gpu/triton/demo/fly_brain/ROADMAP-tee-cpu.md`).
