# PoRW CPU-DRAM residency experiment

The CPU analog of the native-GPU benchmark: hold the fruit-fly-brain weights
resident and **locked** in DRAM (`mlock`, non-swappable), measure the DRAM
streaming bandwidth that underpins the residency argument, and run the full
PoRW proof loop over the resident buffer.

Lives under `gpu/triton/` to reuse the pinned environment and the `porw_sketch`
package; it is **CPU-only** and needs no GPU, no CUDA, and no Triton — so it
runs anywhere the pinned CPython/NumPy environment installs, including this
kind of small cloud host.

## Why a CPU experiment

PoRW proves *residency* with a bandwidth envelope: a device that truly holds
the weights can stream the covered bytes within a slot at its memory bandwidth.
On a GPU that bandwidth is HBM; on a CPU it is DRAM. Together with the CPU-TEE
execution adapter (`../../demo/fly_brain/ROADMAP-tee-cpu.md`), this gives a
fully CPU-based verifiable stack — residency in DRAM, execution in a CPU TEE —
with no GPU in the loop.

## What it measures

- **Residency**: the model bytes mlocked resident in DRAM (non-swappable), with
  the process RSS delta.
- **DRAM read bandwidth** (the residency ceiling): the pure streaming-read rate
  over every resident byte. This is the physically meaningful number for the
  envelope — can the device read all covered bytes within a slot.
- **SIMD verifiable audit rate**: the bit-exact CPU SIMD sketch kernel
  (`simd/`, AVX2 + scalar fallback, multi-core). This is the rate at which the
  *verifiable* sketch covers the model — ~25–33 GiB/s on four cores, ~16–21 ms
  per full audit of the 521 MiB fly brain (about two-thirds of the aggregate
  read ceiling). The honest ceiling to compare it against
  is the **aggregate** multi-core streaming read, measured the same threaded
  way (a single core cannot pull the whole memory system's bandwidth).
- **Reference sketch rate**: the unoptimized NumPy sketch, compute/allocation-
  bound, ~0.08 GiB/s. Kept for scale and timed on a bounded prefix; never the
  residency bandwidth number.
- **Audit envelope**: coverage ÷ SIMD rate ≤ slot — can the verifiable sketch
  (not just a raw read) cover every byte within the slot.
- **Envelope**: bandwidth × slot ⇒ how large a model can be covered per slot.
- **Proof loop**: weights root (model id) + partials root, a committed opening,
  and honest/lying tile fraud verdicts.

The streaming sketch (`residency.sketch_stream`) is bit-identical to
`porw_sketch.spec.sketch_tiles`; it only bounds peak memory so the timed rate
reflects streaming the weights rather than materializing a coefficient matrix.

## Run

```sh
cd gpu/triton
# full FlyWire adult-brain scale (~521 MiB), 100 ms slot
.venv/bin/python -m experiments.cpu_memory.bench_cpu --slot-ms 100 --repeats 5

# small correctness run
.venv/bin/python -m experiments.cpu_memory.bench_cpu \
  --name smoke --neurons 5000 --synapses 50000 --repeats 3

# real checkpoint bytes instead of the synthetic stand-in
.venv/bin/python -m experiments.cpu_memory.bench_cpu --checkpoint path/to/weights.safetensors
```

A measured result at FlyWire scale is committed under
`benchmarks/cpu-mem/historical/` with a manifest separating the deterministic
fields (reproducible anywhere) from the host-specific bandwidth numbers.

## Scope

Proves residency, not inference execution (out of PoRW scope), and adds no
custody/staking/rewards. `mlock` may need a sufficient `RLIMIT_MEMLOCK`; the
report records whether the lock succeeded rather than failing the run.
