# PoRW in the browser — zero-install fly-brain node

A browser tab as a **fly-brain instance**: it holds a released fly-brain model resident
in wasm memory, proves that residency with PoRW (a claim is the sketch and its
commitment — nothing else), runs the model's deterministic inference for a task and
commits everything an execution dispute needs, signs claims with a secp256k1 key (the
reward key), answers audits, and can take distributed inference tasks in a leaderless
mesh. No install. Measured in headless Chromium; every
cryptographic output is checked against an independent implementation and the
aigg-spec conformance vectors, and the claim is verified on-chain.

## Modules

| file | role |
|---|---|
| `sketch_wasm.c` | scheme-v2 tile sketch, WASM **SIMD128** + scalar fallback; deterministic test-payload filler; bump allocator with mark/release |
| `commit_wasm.c` | **keccak256** (freestanding keccak-f[1600]); weights/partials leaves; Merkle root/proof; **cached trees** (O(log n) proofs); **block-parallel tree build**; slot-seed derivation — scheme `aigg:porw:sketch-tile-keccak:v2` |
| `spmv_wasm.c` | deterministic **integer fixed-point SpMV** (`aigg:exec:int-spmv-q16:v1`) over the packed synapse records in place; unsigned Q16, hard clamp |
| `lif_wasm.c` / `lif.js` / `int_lif.py` | **`aigg:exec:int-lif:v1`**: deterministic integer leaky integrate-and-fire on the **real FlyWire brain** (payload v2 from `demo/fly_brain/flywire_export.py`; Shiu et al. 2024 parameters in fixed point); scatter, CSR-range and post-sorted row kernels, signed partial sums, 16-byte state leaves; JS transition rule + exec-kind digest; numpy reference |
| `dispute_wasm.c` | execution-dispute commitments: per-step activation leaves, CSR build (counting sort by post), CSR chunk leaves (64 records/leaf), rowStart leaves, CSR-ordered partial sums; row-parallel inference (`…_csr_range`, and `…_rows_direct` when records are published post-sorted) |
| `pool.js` / `pool_worker.js` | **shared-memory worker pool**: one resident copy in a shared `WebAssembly.Memory`, N instances of `porw-shared.wasm` (each with its own stack region) computing disjoint ranges in place; browser Workers (needs cross-origin isolation) or Node `worker_threads` |
| `porw.js` / `model.js` | wasm glue (Node + browser), payload header decode, tree/SpMV wrappers, tree-node access for bisection |
| `mem.js` | what one hosted brain costs a tab in wasm memory, as a closed form of (tiles, neurons, synapses, maxSteps, exec) — `bench_memory.mjs` measures the real allocator against it |
| `mep.js` | Model Execution Profiles — one per released brain (female FlyWire, male CNS, …): `mep_id = keccak(scheme ‖ model_id ‖ exec kind ‖ neurons ‖ synapses ‖ synapse_root)`. No run parameters: steps and the commit stride ride on the task |
| `claim.js` | EVM-packed claim encoding, secp256k1 signing / `ecrecover`-compatible recovery (noble) |
| `eip712.js` | **EIP-712** typed data (`Claim`, `Result`, `Delegation`): hand-coded digests, `eth_signTypedData_v4` JSON + a generic `hashTypedData` (the wallet's view), local / injected (EIP-1193) wallets, session-key delegation |
| `run_wallet_browser.mjs` | a Chromium tab with an injected wallet (simulated outside the page): one `Delegation` prompt, then session-key-signed claims over the relay |
| `node.js` | `PorwNode`: multi-model residency, per-MEP signed claims (residency + execution digest), tile openings, dispute openings (activation / rowStart / CSR chunk / partial sums / tree nodes); LIF path with segment roots every `commitStride` steps, checkpoint + replay for openings |
| `verify.js` / `verifier.js` / `dispute.js` | **independent** verifier (noble keccak only, never the wasm): claim checks, sampled openings, sketch recomputation, redundant re-execution, and the execution dispute (step → neuron bisection → row check → synapse bisection → one-term check) |
| `swarm.js` | mesh coordination: stake-weighted **index sortition** (the contract rule), redundancy sets, backups, auditors, majority settlement |
| `envelope.js` / `relay.js` / `relay_client.js` | **stage-1 transport**: signed message envelopes (reward key), a stateless WebSocket relay (`ws`), an isomorphic multi-relay client (fan-out, verify, dedupe, request/response on inbox topics). The hub pings its peers and reaps the silent ones; the client redials with backoff and replays its subscriptions — a relay connection is idle across whole epochs, and anything deployed in front of one will cut it. `startRelay({ server, path })` shares an existing http server instead of taking a port of its own. |
| `aggregator.js` | **aggregated claims** (BSC posture): an untrusted aggregator batches the epoch's verified claims into one Merkle root (`postEpochRoot`) and serves inclusion proofs over the relay; instances `materializeClaim` only when they need eligibility |
| `node.js` `residency()` / `execute()` | two jobs, split. `residency()` sketches the resident tiles and signs the claim — no inference at all, because none of it was ever adjudicated: `respondOpening` decides a challenged tile against `partialsRoot` and the model root. `execute({ steps, commitStride, commit })` runs a task and builds the state commitments a dispute needs (72% of the work on the real brain) |
| `node_service.js` / `auditor.js` | the instance announcing claims and serving audits/tasks over relays (+ the on-chain fallback opening); the auditor sampling openings through relays and escalating to `challengeOpening` calldata |
| `run_relay_browser.mjs` | a Chromium tab as a relay-served instance: audit + task from this process |
| `index.html` + `worker.js` | audit-throughput PoC (per-worker slices, no shared memory) |
| `node_page.html` + `run_node_browser.mjs` | the full node loop in headless Chromium (optionally with the pool) and this process as the verifier |
| `synth.js` | JS payload synthesizers (v1 as the Python demo; v2 with signed counts for the LIF tests) |
| `delta.js` / `sample.js` / `test_delta.mjs` | **delta payloads**: v1 = explicit edit list, v2 = procedural (seed + noise model → a synthetic individual, deterministic integer sampler bit-identical in JS and Python), v3 = same-base cross (two parent deltas + seed → a child with real inheritance), in a compact or an **in-place** layout (records keep the base's positions, so one record of a child re-derives from one record of its parents); all: a fine-tune, ablation or synthetic individual of a released brain as a sorted edit list (set / insert / delete records) bound to the base's `model_id`; `applyDelta` rebuilds the target payload byte for byte, so its `model_id` / MEP are those of a directly published payload; `PorwNode.loadDelta(base, delta)`; Python twin `demo/fly_brain/flywire_delta.py` |
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

## Delta payloads (FLYDELTAv1)

A brain that differs from a released one in a few records — an ablation, a fine-tune, a sampled individual —
is published as a delta instead of a second 28 MB payload:

```
MAGIC "FLYDELTAv1\0\0" | base model_id (32 B) | u64 neurons | u32 ops | u16 name_len | name
| u16 base_da_len | base_da (the base's pointer, may be empty) | ops: u32 pre | u32 post | i16 w   (sorted by (post, pre), unique)
```

`w != 0` sets the record (insert or replace), `w == 0` deletes it (the base must have it); neurons and root ids are
unchanged. `applyDelta(base, delta)` writes exactly what `flywire_export.py` writes (header with the delta's name,
records sorted by `(post, pre)`, 4 KiB padding), so the applied bytes' `model_id` is the ordinary weights Merkle root
and the MEP is registered on it as usual; the delta's own identity is `keccak(delta bytes)`. A node holding the base
loads a delta model with `loadDelta` (base id checked against the header). Measured on the real brain: a 467-record
edit is a 4.7 KB delta, diff 0.6 s, apply 0.5 s. What the format does **not** do: it is not a second commitment
scheme (the mesh still verifies the applied payload's `model_id`), and v1 cannot add or remove neurons.

### FLYDELTAv2: procedural individuals

Resampling every record of a brain according to an inter-individual noise model changes almost every record, so an
explicit delta would be as large as the payload. v2 carries the recipe instead:

```
MAGIC "FLYDELTAv2\0\0" | base model_id (32 B) | u64 neurons | u64 seed | u16 min_syn | u32 mean_ratio_q16 | u16 r_rows
| rows: u32 c_from | u16 r_q8 | u32 ops | u16 name_len | name | u16 base_da_len | base_da | ops (10 B each, v1 semantics; deletes lenient)
```

For every base record with count `c = |w|`: `U = hash64(seed, pre, post)` (two fmix32 chains, so a record's draw does
not depend on record order), mean `m = c · mean_ratio / 65536`, shape `r = r_q8(c) / 256` (the last row with
`c_from ≤ c`), and `c'` = the smallest `k` with `CDF_NB(k; m, r) > U / 2^64`. The CDF is tabulated once per distinct `c`
in Q256 fixed point (`ln` / `exp` by fixed-length series in Q60, the pmf recurrence in exact integer ratios, entries
floored to Q64), so the sampler is a definition, not an approximation: JS (`sample.js`, BigInt) and Python
(`flywire_delta.py`) produce byte-identical payloads. Records with `c' < min_syn` are dropped, the sign is kept
(Dale), the explicit ops run after sampling, and the result is written as for v1 — so the individual's `model_id` is
an ordinary payload commitment. The default `r` table is fitted to FlyWire's left/right mirror connections
(two sampled individuals differ like the two hemispheres do: SD ln ratio 1.0 at 5–9 synapses, 0.65 at 20–49, 0.37 at
100+; a 5–9-synapse connection is missing from the other individual's ≥5 graph 82% of the time). Measured on the real
brain: a 2.7 M-record individual applies in 0.9 s (JS) / 1.5 s (Python) from a 140-byte delta; sampling from the
≥1-synapse export (15.1 M records) lets an individual also gain connections the published fly lacks.

### FLYDELTAv3: same-base cross

The child of two individuals of the **same base** (a hybrid of two different connectomes is not expressible: a delta
indexes one base's neuron table). Parents are procedural deltas named by `keccak(delta bytes)`; 32 zero bytes name the
published base itself.

```
MAGIC "FLYDELTAv3\0\0" | base model_id | u64 neurons | parent A id (32 B) | parent B id (32 B) | u64 seed | u8 granularity | u8 0
| u16 min_syn | u32 mut_rate_q32 | u32 mean_ratio_q16 | u16 r_rows | rows | u32 ops | u16 name_len | name | u16 da_len | da | ops
```

Inheritance acts on **genotypes** — the count of every base record *before* the `min_syn` threshold — and the payload
is the phenotype. Per inheritance unit (`0` record, `1` pre neuron: all outputs of a neuron together, `2` post neuron:
all inputs together) one hash bit picks parent A or B; then each record mutates with probability `mut_rate` into a
fresh v2 draw around the **base** count. Because founders, picks and mutations all have the founder distribution, the
population is stationary: a descendant of any depth is marginally distributed like a founder (record counts and
unrelated distances do not drift), and relatedness shows up only as shared picks. Measured on the real brain
(≥1-synapse base, mutation 1/8, distance = mean |ln((x+1)/(y+1))| over the published records): parent–child 0.36,
siblings 0.40, grandparent–grandchild 0.52, unrelated 0.64 = founder–founder 0.64. Parents must carry no explicit ops
(their genotype would not be base-indexed); ancestors are supplied by id (`applyDelta(base, delta, { resolve })`,
`flywire_delta.py apply --parents ...`) and memoised, so applying costs one pass per distinct ancestor. A 231-byte
grandchild with three ancestors applies in 1.9 s (JS); JS and Python agree byte for byte. The seed-domain constants
(pick / mutate / draw) are XORed into both words of the seed.

`hash64` was tightened with this version: both seed words now reach the high word of the uniform (previously seeds
differing only in the high 32 bits produced almost the same individual) and the low word hashes the swapped key. v2
payloads made with the earlier hash are not reproducible; none had been registered.

### In-place layout (`FLYDELTAv3`, layout byte = 1)

`proposals/flydelta-inplace` asks that a wrong declared `model_id` be provable, which needs a child's bytes to be a
local function of its parents' bytes. With layout 1 the payload is the base's bytes with another name (of the base's
byte length: `fitName`) and other weights: every record stays at the base's offset and a record the individual lacks
has weight 0. Inheritance then acts on the payload weights themselves — picking commutes with thresholding and a
mutation is a fresh draw around the base count, so the compact and in-place materializations of one recipe express
exactly the same connections — and `inheritRecord` / `expectedRecord(delta, base, parentA, parentB, j)` re-derive
record `j` from record `j` of the base and of the parents' payloads alone. In-place lineages are closed: parents are
the base (zero id) or in-place crosses with `min_syn` ≤ the child's; nothing carries explicit ops. A founder is a
base × base cross with `mut_rate_q32 = 0xFFFFFFFF` ("every record mutates"): the `v2` individual's distribution, under
other draws.

Measured on the real brain, ≥ 2-synapse base (7,595,967 records, 77 MB), `min_syn 5`, `mean_ratio 0.92`: a founder
expresses 2,689,164 records (the real fly's ≥ 5 graph has 2,700,513), 64.6% of the payload is zeros; founders, a child
and a grandchild are byte-identical between JS and Python (1–2 s to apply); 200,000 sampled records of each re-derive
from the Python-made parent payloads with 0 mismatches. Zero weights are inert: an in-place individual and its compact
twin give the **same `execDigest`**, at 2.3× the execution time (10.1 s vs 4.3 s for 2,000 steps) and 283 vs 208 MB of
wasm memory. Not implemented yet: the on-chain verifier for the one-record proof, and in-place `v1` edits.

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

Under scheme `sketch-tile-keccak:v2` only the first two columns are a residency claim;
the other two are a task's work. The totals below are therefore a claim **plus** a task
run, which is what this table measured before the two were separated.

| per slot (ms) | sketch | partials commit | inference | dispute commit | **total** | one-time load |
|---|---|---|---|---|---|---|
| 1 thread | 164 | 345 | 585 | 716 | **1811** | 18.6 s |
| 4 workers, unsorted | 38 | 219 | 672 | 472 | **1401** | 8.3 s |
| 4 workers, post-sorted | 51 | 247 | 85 | 465 | **848** | 6.5 s |
| 4 workers, post-sorted, parallel trees | ~55 | ~130 | ~70 | ~250 | **~480–540** | 5.7 s |

**Real FlyWire brain, integer LIF** (139,255 neurons, 2.70M signed records ≥ 5 synapses,
28 MB, `benchmarks/lif/`): Node 22, this host — inference 9.4 ms/step single thread,
2.9 ms/step on the 4-worker pool; one committed state root 362 ms single / 116 ms pool;
with stride 10 a 100-step *task* (10 ms of brain time) takes 5.0 s single / **1.6 s** pool,
of which the residency claim is 34 ms single;
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
