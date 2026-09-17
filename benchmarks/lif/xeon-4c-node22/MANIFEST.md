# Integer LIF on the real FlyWire brain — measured (Node 22, 4-core Xeon, no GPU)

`web/porw-browser/bench_lif_node.mjs` on the FlyWire FAFB v783 export
(`flywire-fafb-v783-min5`: 139,255 neurons, 2,700,513 post-sorted signed records,
28 MB; `model_id` in `spec-cache/conformance/exec/int-lif-v1/`). Measured artifact:
deterministic fields (model/MEP ids, execDigest, execRoot, initStateRoot, spike
counts) reproduce anywhere; timings are specific to this host and load.

## Host

- Intel Xeon @ 2.80GHz, 4 vCPU, 15 GiB, no GPU; Node 22.22; kernels built with clang 18
  (`-O3 -msimd128`), pool = 4 `worker_threads` over one shared `WebAssembly.Memory`.

## Deterministic

- canonical stimulus set (seed 7): 151 neurons; 100 steps (10 ms): pool == single
  (execDigest, execRoot identical); 1000 steps: 6,321 spikes, 1,156 active neurons.

## Measured

| configuration | inference / step | committed state root | 100-step claim, every step committed | 100-step claim, stride 10 |
|---|---|---|---|---|
| single thread | 9.4–10.7 ms | 363 ms | 37.8 s | **5.0 s** |
| pool × 4 | 2.9–4.0 ms | 116 ms | 12.2 s | **1.6 s** |

Research mode (no commitments, single thread): 9.0 ms/step ⇒ ~90 s per second of
brain time per tab. One-time load (weights leaves, model id, CSR commitments):
1.2 s single / 0.4 s pool.

## Reading

Inference on the real brain is cheap (2.7M records/step); the commitment (139k keccak
leaves + tree) dominates, which is why the LIF kind commits **segment roots** every
`commitStride` steps and refines to per-step roots only in a dispute. A committed
state root costs ~12× an inference step on the pool.
