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
- **Reference sketch rate**: the unoptimized NumPy sketch's compute rate. It is
  compute/allocation-bound, **not** a memory-bandwidth number; an optimized CPU
  SIMD kernel would be far higher. Reported separately so the two are never
  conflated.
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
