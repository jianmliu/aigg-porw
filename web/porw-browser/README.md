# PoRW in the browser — zero-install fly-brain node

A browser tab as a **fly-brain instance**: it holds a released fly-brain model resident
in wasm memory, proves that residency with PoRW, runs the model's deterministic
inference, commits everything an execution dispute needs, signs claims with a
secp256k1 key (the reward key), answers audits, and can take distributed inference
tasks in a leaderless mesh. No install. Measured in headless Chromium; every
cryptographic output is checked against an independent implementation and the
aigg-spec conformance vectors, and the claim is verified on-chain.

## Modules

| file | role |
|---|---|
| `sketch_wasm.c` | scheme-v2 tile sketch, WASM **SIMD128** + scalar fallback; deterministic test-payload filler; bump allocator with mark/release |
| `commit_wasm.c` | **keccak256** (freestanding keccak-f[1600]); weights/partials leaves; Merkle root/proof; **cached trees** (O(log n) proofs); **block-parallel tree build**; slot-seed derivation — scheme `aigg:porw:sketch-tile-keccak:v1` |
| `spmv_wasm.c` | deterministic **integer fixed-point SpMV** (`aigg:exec:int-spmv-q16:v1`) over the packed synapse records in place; unsigned Q16, hard clamp |
| `dispute_wasm.c` | execution-dispute commitments: per-step activation leaves, CSR build (counting sort by post), CSR chunk leaves (64 records/leaf), rowStart leaves, CSR-ordered partial sums; row-parallel inference (`…_csr_range`, and `…_rows_direct` when records are published post-sorted) |
| `pool.js` / `pool_worker.js` | **shared-memory worker pool**: one resident copy in a shared `WebAssembly.Memory`, N instances of `porw-shared.wasm` (each with its own stack region) computing disjoint ranges in place; browser Workers (needs cross-origin isolation) or Node `worker_threads` |
| `porw.js` / `model.js` | wasm glue (Node + browser), payload header decode, tree/SpMV wrappers, tree-node access for bisection |
| `mep.js` | Model Execution Profiles — one per released brain (female FlyWire, male CNS, …): `mep_id = keccak(scheme ‖ model_id ‖ exec kind ‖ steps ‖ clamp)` |
| `claim.js` | EVM-packed claim encoding, secp256k1 signing / `ecrecover`-compatible recovery (noble) |
| `node.js` | `PorwNode`: multi-model residency, per-MEP signed claims (residency + execution digest), tile openings, dispute openings (activation / rowStart / CSR chunk / partial sums / tree nodes) |
| `verify.js` / `verifier.js` / `dispute.js` | **independent** verifier (noble keccak only, never the wasm): claim checks, sampled openings, sketch recomputation, redundant re-execution, and the execution dispute (step → neuron bisection → row check → synapse bisection → one-term check) |
| `swarm.js` | mesh coordination: stake-weighted **index sortition** (the contract rule), redundancy sets, backups, auditors, majority settlement |
| `index.html` + `worker.js` | audit-throughput PoC (per-worker slices, no shared memory) |
| `node_page.html` + `run_node_browser.mjs` | the full node loop in headless Chromium (optionally with the pool) and this process as the verifier |
| `synth.js` | JS payload synthesizer (same layout as the Python demo; records post-sorted by default) |
| `test_*.mjs`, `crosscheck.py`, `int_spmv.py` | tests and Python cross-checks |
| `../../contracts/evm/test/BrowserClaim.t.sol` | the node's claim verified **on-chain** (`mep_id`, claim hash, `ecrecover`) |

## Build, test, run

```sh
cd web/porw-browser
./build.sh          # sketch.wasm (own memory) + porw-shared.wasm (imported shared memory)
npm install
npm test            # test_wasm (keccak fixture, trees) · test_node (2 MEPs, fraud) · test_swarm · test_pool · test_dispute

# audit-throughput PoC
PW_CHROMIUM=/path/to/chrome node run_browser.mjs --mib 521 --workers 4
# full node loop at FlyWire scale; --workers N uses the shared-memory pool (server sends COOP/COEP)
PW_CHROMIUM=/path/to/chrome node run_node_browser.mjs --payload flywire-female-sorted.bin --steps 2 --samples 16 --rounds 3 --workers 4
```

## What is verified

- **Scheme conformance**: wasm keccak256 == noble on all block sizes; scheme digest, slot
  seed, sketches, weights/partials leaves, roots and Merkle proofs — bit-identical to
  the cached aigg-spec keccak vector; cached and block-parallel trees == streaming
  trees (roots and every proof, odd sizes, partial last block).
- **Sketch kernel**: browser sketches bit-identical to the native AVX2 kernel.
- **Deterministic inference**: wasm integer SpMV == numpy int64; scatter kernel ==
  CSR-ordered rows == post-sorted direct rows (bit-identical); Chromium == Node; the
  wrong MEP's parameters do **not** match.
- **Pool path == single-thread path**: model id, partials root, execution digest and
  root, claim hash, openings — identical (sorted and unsorted payloads).
- **Node loop** (female + male MEPs): claims verify; cross-MEP rebinding rejected;
  malformed signatures rejected without crashing; sampled openings verify with the
  sketch recomputed; a lie in one committed tile → `fraud`; forged bytes →
  `invalid`; redundant re-execution matches.
- **Execution dispute** (`test_dispute.mjs`): `actRoots`/`execRoot`/`synapseRoot`
  reproduced by noble; first differing step found; neuron bisection over both
  parties' trees finds the lied neuron (13 rounds for 5k neurons); a lie in the
  activation is caught by the **row check** (claimed act ≠ min(last partial sum ≫ 16,
  clamp)); a lie carried consistently into the partial sums is caught at the exact
  **divergent synapse term** with the record (CSR chunk proof), row bounds
  (rowStart proofs) and input activation (previous-step root or stimulus rule);
  swapping roles still blames the liar; two honest executors never dispute.
- **On-chain**: `forge test` recomputes `mep_id` and the claim hash and `ecrecover`s
  the signer.
- **Mesh**: sortition deterministic, stake-weighted, excludes ineligible instances and
  the claimant; settlement flags a dissenter.

## Measured (4-core Xeon, no GPU, Chromium 141; `benchmarks/browser/`)

521 MiB model, 139,255 neurons / 54.5M synapses, steps = 2, per-slot work including
the dispute commitments:

| per slot (ms) | sketch | partials commit | inference | dispute commit | **total** | one-time load |
|---|---|---|---|---|---|---|
| 1 thread | 164 | 345 | 585 | 716 | **1811** | 18.6 s |
| 4 workers, unsorted | 38 | 219 | 672 | 472 | **1401** | 8.3 s |
| 4 workers, post-sorted | 51 | 247 | 85 | 465 | **848** | 6.5 s |
| 4 workers, post-sorted, parallel trees | ~55 | ~130 | ~70 | ~250 | **~480–540** | 5.7 s |

16 sampled openings: 16–19 ms (cached trees). Two findings worth keeping: a CSR
permutation makes every synapse read a random access into the 545 MB payload, so
**publish models with records sorted by post neuron** (rows contiguous, parallel
inference streams: 672 → 67 ms); and once inference is cheap the single-threaded
tree builds dominate, so build aligned 2^m-leaf blocks on workers.

## Design and honest limits

The settlement design that consumes these artifacts is
[`contracts/evm/DESIGN-cross-audit.md`](../../contracts/evm/DESIGN-cross-audit.md)
(interfaces in `contracts/evm/src/interfaces/PorwMesh.sol`).

- **No TEE in a browser.** Execution correctness comes from determinism +
  redundancy + cross-audit + the dispute protocol above, not hardware.
- **Residency is eligibility, not the rewarded resource** (a 521 MiB model is not
  scarce; the DRAM envelope is weak over a jittery network). The rewarded resource
  is verified, stake-gated execution units.
- **Contracts**: implemented in `contracts/evm/src/mesh/` and tested end to end on
  fixtures exported from this node (`export_fixtures.mjs` → `test/Mesh.t.sol`).
- **Not yet**: gossip transport (libp2p/WebRTC); wallet (EIP-712) signing; a
  deployment script and a live-chain run.
