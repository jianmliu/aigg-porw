# Why the fly brain runs on an ordinary computer

The CPU track exists to lower the hardware bar: the goal is that an ordinary,
GPU-less computer can **host** a model resident in memory, **prove** that
residency, and **run** the model. The fruit-fly brain is the right first target
because — unlike an LLM — it does not depend on a GPU. This note states why,
and what the measured data says.

## The structural reason: sparse connectome ⇒ SpMV ⇒ memory-bound

An LLM layer is a dense matrix multiply (GEMM). Dense GEMM has high arithmetic
intensity (tens to hundreds of flops per byte), so it is compute-bound and
wants GPU tensor cores; that is why LLM inference is tied to GPUs.

A connectome is a **sparse graph**: ~139k neurons, ~54.5M synapses, average
degree in the hundreds. Propagating activation through it is a **sparse
matrix-vector product (SpMV)**: for each synapse, gather one activation,
multiply by one weight, scatter-add into one target. Per synapse that streams
roughly 32 bytes of working set for 2 flops — an arithmetic intensity of about
**0.06 flop/byte**, one to two orders of magnitude below any CPU's roofline
knee. SpMV is therefore **memory-bandwidth-bound, not compute-bound**. Tensor
cores do not help it; DRAM bandwidth does, and every ordinary computer has DRAM.

So the fly brain is CPU-friendly for a structural reason, not a tuning trick:
its inference is the kind of computation a GPU is *not* especially good at.

## The size reason: it fits with room to spare

The FlyWire-scale payload is ~521 MiB. Against a modest commodity baseline —
8 GiB RAM, 2 cores, no GPU, with half of RAM budgeted for the resident model —
that is **12.7% of the model budget**. It fits on a several-years-old laptop.
(A frontier LLM, by contrast, does not fit in an ordinary computer's RAM at all.)

## Measured (this host: 4-core Xeon, 15 GiB, no GPU)

From `pure_cpu_e2e.py` at full FlyWire scale:

| | value | meaning |
|---|---|---|
| resident model | 520.8 MiB, 133,329 tiles | fits an 8 GiB PC easily |
| DRAM streaming read | ~11 GiB/s single core; ~31–42 GiB/s aggregate (4 cores) | residency bandwidth ceiling |
| SIMD verifiable sketch | ~9 GiB/s (1 thr) / ~25–33 GiB/s (4 thr), ~16–21 ms per full audit | bit-exact; ~×100–×400 over reference |
| audit envelope, 100 ms slot | ~2.5–2.9 GiB/slot | the verifiable sketch clears it ~5× |
| residency envelope, 100 ms slot | ~1.1 GiB/slot | the model clears it |
| connectome propagation | 139,255 neurons, 108M synapses/s | 2 steps in ~1.0 s on 4 cores |
| SpMV effective bandwidth | ~3.2 GiB/s | memory-bound, as predicted |
| arithmetic intensity | 0.0625 flop/byte | far below the roofline knee |
| PoRW proof loop | opening ✓, honest → NoFraud, lying → Fraud | residency proven |
| TEE execution binding | binds ✓, rebind to other model rejected ✓ | (mock adapter) |

## Two honesty points for real laptops

1. **Residency does not require `mlock`.** On this host mlock succeeded only
   because the process is root; an ordinary user's `RLIMIT_MEMLOCK` is ~8 MiB
   or less, so `mlock` of a 521 MiB model will **fail** on a normal laptop. That
   is fine: residency is proven by the bandwidth envelope + sampled-byte audits,
   not by mlock. mlock is an optional extra non-swappability hardening; the
   report records whether it was available and never gates on it.
2. **The reference sketch is slow; the SIMD kernel is not.** The NumPy sketch
   (~0.08 GiB/s) is an unoptimized reference, compute/allocation-bound, and is
   *not* the residency bandwidth number. The bit-exact CPU SIMD kernel
   (`experiments/cpu_memory/simd/`) runs the same scheme at ~9 GiB/s on one core
   and ~25–33 GiB/s on four — a full verifiable audit of the 521 MiB model in
   **~16–21 ms**. The honest memory ceiling for that threaded kernel is the
   *aggregate* multi-core streaming-read rate (~31–42 GiB/s here), measured the
   same threaded way; the sketch reaches about two-thirds of it.

## What this does and does not claim

- Claims: an ordinary GPU-less computer can hold the fly-brain model resident,
  prove that residency with PoRW, and run a memory-bound connectome propagation
  over it — all measured here.
- Does not claim: that the connectome propagation is a trained behavioral
  inference (it is a signal-propagation stand-in over a connectome-scaled
  synthetic payload; drop in the real FlyWire export to run it over the real
  connectome), or that a mock TEE proof means anything about real hardware (see
  `ROADMAP-tee-cpu.md`).

The takeaway for the project: **the "ordinary computer" reach is real for
sparse, memory-bound models like the fly brain**, and PoRW's residency proof
carries over unchanged because it was never tied to a GPU in the first place.
