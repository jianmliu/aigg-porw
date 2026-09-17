# Browser PoRW audit — measured result (headless Chromium)

A single host's run of `web/porw-browser/run_browser.mjs`: the scheme-v2 tile
sketch compiled to **WebAssembly SIMD128**, auditing a FlyWire-scale
(521 MiB, 133,376 tiles) resident buffer inside headless Chromium. Measured
artifact, not a drift-tested fixture: deterministic fields reproduce anywhere;
timings are specific to this host, browser build, and load.

## Host / browser

- CPU: Intel Xeon @ 2.80GHz, 4 vCPU, 15 GiB, **no GPU**
- Chromium 141.0.7390.37 (Playwright headless), Node 22
- kernel: `sketch_wasm.c` built with clang 18 (`-O3 -msimd128`), backend
  reported by the page: `simd128`

## Deterministic (reproducible anywhere)

- payload: `word[i] = fmix32(i*GOLDEN32 + seed)`, seed 7, slot_seed 2876441635
- sketch arrays (single-thread and 4-worker) are **bit-identical to the native
  AVX2 C kernel** (`crosscheck.py`, 133,376/133,376 values) — and to each
  other; their BLAKE3 digests are recorded in the JSON files.

## Measured (host/browser-specific)

| configuration | full audit of 521 MiB | rate |
|---|---|---|
| main thread, 1 kernel | **127.6 ms** | 3.99 GiB/s |
| 2 Web Workers | 75.2 ms | 6.77 GiB/s |
| 4 Web Workers | **43.6 ms** | 11.67 GiB/s |

Per-worker medians for the 4-worker run: 34/34/44/35 ms (the audit time is the
slowest worker). Deterministic payload fill on the main thread: ~377 ms (one-time
setup, not part of the audit). No SharedArrayBuffer / cross-origin isolation is
used: each worker owns and audits its own slice.

## What this shows

A zero-install browser tab on an ordinary 4-core computer can hold the fly-brain
model resident and complete a full, bit-exact PoRW audit in ~44 ms — inside a
100 ms slot with headroom. It does **not** by itself make residency a sound
mining basis (see `web/porw-browser/README.md`: DRAM-vs-SSD envelope, network
jitter, no TEE); it establishes that the *audit* side is feasible in-browser.

## Full node loop (added later): `flywire-521mib-node-loop.json`

`web/porw-browser/run_node_browser.mjs`: the page is the prover (resident 521 MiB
model, keccak-scheme commitments, signed claims, tile openings, integer SpMV
inference); this process is an independent verifier (noble-only checks, sampled
openings, redundant re-execution with its own kernel). Single-thread wasm on the
main thread (no workers yet in the node path).

| item | measured |
|---|---|
| fetch 546 MB payload over localhost | ~0.95 s |
| weights leaves + model id (133,329 keccaks over 4104 B), one-time | ~7.4 s |
| verifier's independent model id (pure-JS keccak, one-time) | ~23.7 s |
| per slot: sketch / partials commit / inference (54.5M syn × 2 steps) | ~135–175 / ~335–370 / ~430–650 ms ≈ **0.9–1.2 s** |
| 16 sampled openings served (cached Merkle trees, O(log n)) | **16–18 ms** (was 5.7 s rebuilding the tree per proof) |
| redundant re-execution in Node (same wasm) | ~0.8–0.9 s |
| claim signature recovery, sampled verdicts, MEP match | all pass, all `no_fraud` |

Per-slot cost is dominated by the keccak-scheme partials commitment and the
inference, not by the sketch; workers would parallelize the first two ≈ 4× on 4
cores. Deterministic fields (model id, MEP id, claim encoding) reproduce anywhere;
timings are this host/browser only.

## Node loop with dispute commitments and a shared-memory worker pool (added later)

Files: `flywire-521mib-node-loop-single-dispute.json` (1 thread), `…-unsorted-w4.json`
(4 workers, records in original order), `…-sorted-w4.json` (4 workers, records
published **sorted by post neuron**, block-parallel Merkle trees). Same 521 MiB /
139,255-neuron / 54.5M-synapse model, steps = 2, 16 sampled openings per round.
Per-slot work now includes the execution-dispute commitments (per-step activation
roots + execRoot); one-time load includes the CSR commitments (`csrRoot`, `rowRoot`).

| per slot (ms) | sketch | partials commit | inference | dispute commit | **total** | one-time load |
|---|---|---|---|---|---|---|
| 1 thread | 164 | 345 | 585 | 716 | **1811** | 18.6 s |
| 4 workers, unsorted (perm gathers) | 38 | 219 | 672 | 472 | **1401** | 8.3 s |
| 4 workers, post-sorted | 51 | 247 | 85 | 465 | **848** | 6.5 s |
| 4 workers, post-sorted, parallel trees | 51–59 | 112–148 | 67–75 | 236–266 | **484–540** | 5.7 s |

Findings: (1) CSR inference through a permutation is *slower* than the scatter
kernel even on 4 workers — every record access becomes a random read into the
545 MB payload; publishing records sorted by post neuron makes rows contiguous and
the parallel inference streams sequentially (672 → 67 ms). (2) After that the
single-threaded tree builds dominated; building aligned 2^m-leaf blocks on
workers and only the upper levels on the main thread halves the commit costs.
Openings stay ~16–19 ms for 16 tiles (cached trees). All pool-path outputs are
bit-identical to the single-thread path (`test_pool.mjs`); all rounds `no_fraud`,
re-execution digests match. Timings are this host/browser only.
