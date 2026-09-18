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
| `lif_wasm.c` / `lif.js` / `int_lif.py` | **`aigg:exec:int-lif:v1`**: deterministic integer leaky integrate-and-fire on the **real FlyWire brain** (payload v2 from `demo/fly_brain/flywire_export.py`; Shiu et al. 2024 parameters in fixed point); scatter, CSR-range and post-sorted row kernels, signed partial sums, 16-byte state leaves; JS transition rule + exec-kind digest; numpy reference |
| `dispute_wasm.c` | execution-dispute commitments: per-step activation leaves, CSR build (counting sort by post), CSR chunk leaves (64 records/leaf), rowStart leaves, CSR-ordered partial sums; row-parallel inference (`…_csr_range`, and `…_rows_direct` when records are published post-sorted) |
| `pool.js` / `pool_worker.js` | **shared-memory worker pool**: one resident copy in a shared `WebAssembly.Memory`, N instances of `porw-shared.wasm` (each with its own stack region) computing disjoint ranges in place; browser Workers (needs cross-origin isolation) or Node `worker_threads` |
| `porw.js` / `model.js` | wasm glue (Node + browser), payload header decode, tree/SpMV wrappers, tree-node access for bisection |
| `mep.js` | Model Execution Profiles — one per released brain (female FlyWire, male CNS, …): `mep_id = keccak(scheme ‖ model_id ‖ exec kind ‖ steps ‖ clamp-or-stride)` |
| `claim.js` | EVM-packed claim encoding, secp256k1 signing / `ecrecover`-compatible recovery (noble) |
| `eip712.js` | **EIP-712** typed data (`Claim`, `Result`, `Delegation`): hand-coded digests, `eth_signTypedData_v4` JSON + a generic `hashTypedData` (the wallet's view), local / injected (EIP-1193) wallets, session-key delegation |
| `run_wallet_browser.mjs` | a Chromium tab with an injected wallet (simulated outside the page): one `Delegation` prompt, then session-key-signed claims over the relay |
| `node.js` | `PorwNode`: multi-model residency, per-MEP signed claims (residency + execution digest), tile openings, dispute openings (activation / rowStart / CSR chunk / partial sums / tree nodes); LIF path with segment roots every `commitStride` steps, checkpoint + replay for openings |
| `verify.js` / `verifier.js` / `dispute.js` | **independent** verifier (noble keccak only, never the wasm): claim checks, sampled openings, sketch recomputation, redundant re-execution, and the execution dispute (step → neuron bisection → row check → synapse bisection → one-term check) |
| `swarm.js` | mesh coordination: stake-weighted **index sortition** (the contract rule), redundancy sets, backups, auditors, majority settlement |
| `envelope.js` / `relay.js` / `relay_client.js` | **stage-1 transport**: signed message envelopes (reward key), a stateless WebSocket relay (`ws`), an isomorphic multi-relay client (fan-out, verify, dedupe, request/response on inbox topics). The hub pings its peers and reaps the silent ones; the client redials with backoff and replays its subscriptions — a relay connection is idle across whole epochs, and anything deployed in front of one will cut it. `startRelay({ server, path })` shares an existing http server instead of taking a port of its own. |
| `aggregator.js` | **aggregated claims** (BSC posture): an untrusted aggregator batches the epoch's verified claims into one Merkle root (`postEpochRoot`) and serves inclusion proofs over the relay; instances `materializeClaim` only when they need eligibility |
| `node.js` `challenge({ commit })` | a residency claim skips the per-step state commitments an execution dispute needs: the Claim carries `partialsRoot` and `execDigest` and no `execRoot`, and `respondOpening` adjudicates a tile against `partialsRoot` alone. On the real brain that is 72% of a claim (6.9 s -> 1.9 s); task execution still asks for them |
| `node_service.js` / `auditor.js` | the instance announcing claims and serving audits/tasks over relays (+ the on-chain fallback opening); the auditor sampling openings through relays and escalating to `challengeOpening` calldata |
| `run_relay_browser.mjs` | a Chromium tab as a relay-served instance: audit + task from this process |
| `index.html` + `worker.js` | audit-throughput PoC (per-worker slices, no shared memory) |
| `node_page.html` + `run_node_browser.mjs` | the full node loop in headless Chromium (optionally with the pool) and this process as the verifier |
| `synth.js` | JS payload synthesizers (v1 as the Python demo; v2 with signed counts for the LIF tests) |
| `bench_lif_node.mjs` / `model_id.mjs` | full-brain LIF measurement (single thread, pool, research mode); model / MEP ids of a payload file |
| `export_fixtures.mjs` / `export_lif_fixtures.mjs` | typed Solidity fixtures for the on-chain tests from real node runs (SpMV mesh; LIF mesh with a state liar and an input-sum liar) |
| `test_*.mjs`, `crosscheck.py`, `int_spmv.py` | tests and Python cross-checks |
| `../../contracts/evm/test/BrowserClaim.t.sol` | the node's claim verified **on-chain** (`mep_id`, claim hash, `ecrecover`) |

## Build, test, run

```sh
cd web/porw-browser
./build.sh          # sketch.wasm (own memory) + porw-shared.wasm (imported shared memory)
npm install
npm test            # test_wasm · test_node · test_swarm · test_pool · test_dispute · test_lif · test_eip712 · test_relay · test_relay_keepalive · test_aggregator
PW_CHROMIUM=/path/to/chrome node run_wallet_browser.mjs     # injected wallet: one Delegation prompt, session-key claims
PW_CHROMIUM=/path/to/chrome node run_relay_browser.mjs      # the tab announces, serves audits and a task over two relays
# the real brain: export it (see demo/fly_brain/README.md), then
node test_lif.mjs flywire-783-min5.bin ../../spec-cache/conformance/exec/int-lif-v1/flywire-fafb-v783-min5.int-lif-v1.seed7-500steps.numpy.json
node bench_lif_node.mjs flywire-783-min5.bin 100 4 out.json
PW_CHROMIUM=/path/to/chrome node run_node_browser.mjs --payload flywire-783-min5.bin --steps 100 --workers 4   # v2 payload -> int-lif

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
- **Integer LIF on the real brain** (`test_lif.mjs`): wasm scatter == wasm post-sorted
  rows == numpy for 500 steps of the FlyWire v783 export (bit-identical state
  trajectories, 1,927 spikes / 620 active neurons at 50 ms from 151 stimulated); JS
  `transition` == kernel for sampled neurons; `initStateRoot` derivable from the
  stimulus id list alone; segment roots replayed from checkpoints match; a lie in the
  state is caught by the LIF row check, a consistent lie in the signed partial sums at
  the single synapse term; segment refinement finds the step and rejects an unbound
  chain; the exec-kind digest and the transition rule match `LifRowCheck.sol`
  (`forge test --match-contract LifRowCheckTest`, vectors covering every branch).
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

**Real FlyWire brain, integer LIF** (139,255 neurons, 2.70M signed records ≥ 5 synapses,
28 MB, `benchmarks/lif/`): Node 22, this host — inference 9.4 ms/step single thread,
2.9 ms/step on the 4-worker pool; one committed state root 362 ms single / 116 ms pool;
with stride 10 a 100-step claim (10 ms of brain time) takes 5.0 s single / **1.6 s** pool;
research mode (no commitments) 9.0 ms/step ⇒ ~90 s per second of brain time per tab.

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
- **LIF caveats**: the rule is a fixed-point *port* of Shiu et al. 2024, not their
  Brian2 code — forward-Euler membrane update, hash-driven stimulus instead of true
  Poisson, floor shifts (a neuron can rest at −1 LSB), no synaptic delays. Results
  are reproducible and disputable, not a biological calibration; calibrating against
  the published model is research work on top of this substrate.
- **EIP-712 + session keys** (`test_eip712.mjs`, `BrowserClaim.t.sol`, `Mesh.t.sol`): node
  digests == generic typed-data hashing == Solidity; claims/results signed by a delegated
  session key resolve to the bonded wallet on-chain and off-chain; wrong domain / chain,
  expired or revoked delegation rejected; a wallet prompts once (Delegation) in Chromium.
- **Aggregated claims** (`test_aggregator.mjs`, `MeshAggregated.t.sol`): the aggregator
  accepts valid claims keyed by wallet and rejects a stale-challenge one; two aggregators
  build the same root; an instance's proof verifies exactly as the contract does; on-chain,
  materialized claims give eligibility (a task settles into a dispute), a junk leaf cannot
  be materialized, and a materialized residency liar is slashed through an opening challenge.
- **Keepalive and reconnect** (`test_relay_keepalive.mjs`): a cut connection is redialled and its
  subscriptions replayed so envelopes flow again, a peer that stops answering pings is reaped without
  disturbing the live ones, and `close()` really stops the loop.
- **Relay transport** (`test_relay.mjs`): envelopes verify / reject tampering, spoofing,
  staleness; the auditor receives each claim once across relays; 16 openings audited
  through the relay; a residency liar caught and escalated with the exact
  `respondOpening` struct; a censoring relay tolerated next to an honest one; all
  relays censoring → `challengeOpening` escalation, and the instance's own on-chain
  opening verifies; a task announced over the relay returns a result whose signature
  recovers the instance over `TaskMarket.resultHash`. `run_relay_browser.mjs` repeats
  the audit and the task with a Chromium tab as the instance.
- **On-chain LIF dispute**: `ExecutionDisputes` dispatches on the MEP's exec kind
  (Refine phase for segment roots, `postRowLif`, `proveSynapseTermLif`), tested end to
  end on artifacts from this node (`export_lif_fixtures.mjs` → `test/MeshLif.t.sol`).
- **Transport**: stage-1 bonded relays (`RelayRegistry.sol`); relays affect liveness
  only, and silence is answered on-chain. Stage 2 (libp2p gossipsub over WebRTC) reuses
  the same envelopes.
- **Not yet**: a deployment script and a live-chain run; libp2p transport.
