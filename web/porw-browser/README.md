# PoRW in the browser — zero-install fly-brain node

A browser tab as a **fly-brain instance**: it holds a released fly-brain model resident
in wasm memory, proves that residency with PoRW, runs the model's deterministic
inference, signs claims with a secp256k1 key (the reward key), answers audits, and
can take distributed inference tasks in a leaderless mesh. No install. Measured in
headless Chromium; every cryptographic output is checked against an independent
implementation and the aigg-spec conformance vectors.

## Modules

| file | role |
|---|---|
| `sketch_wasm.c` | scheme-v2 tile sketch, WASM **SIMD128** (4 × u32 lanes) + scalar fallback; deterministic test-payload filler; bump allocator with mark/release |
| `commit_wasm.c` | **keccak256** (freestanding keccak-f[1600]); weights/partials leaves; Merkle root/proof; **cached Merkle tree** (build once, O(log n) proofs); slot-seed derivation — scheme `aigg:porw:sketch-tile-keccak:v1` |
| `spmv_wasm.c` | deterministic **integer fixed-point SpMV** (`aigg:exec:int-spmv-q16:v1`): reads the packed synapse records of the resident payload in place; unsigned Q16, hard clamp; bit-identical across engines |
| `porw.js` / `model.js` | wasm glue (Node + browser), payload header decode, tree/SpMV wrappers |
| `mep.js` | Model Execution Profiles — one per released brain (female FlyWire, male CNS, …): `mep_id = keccak(scheme ‖ model_id ‖ exec kind ‖ steps ‖ clamp)` |
| `claim.js` | EVM-packed claim encoding (`abi.encodePacked` layout), secp256k1 signing / `ecrecover`-compatible recovery (noble) |
| `node.js` | `PorwNode`: multi-model residency, per-MEP signed claims (residency + execution digest), tile openings from cached trees |
| `verify.js` / `verifier.js` | **independent** verifier (noble keccak only, never the wasm): claim checks, sampled openings, sketch recomputation → `no_fraud / fraud / invalid`, redundant re-execution |
| `swarm.js` | mesh coordination: stake-weighted **index sortition** (the contract rule), redundancy sets, backup queues, auditor sets, majority settlement |
| `index.html` + `worker.js` | audit-throughput PoC with Web Workers (per-worker slices, no SharedArrayBuffer) |
| `node_page.html` + `run_node_browser.mjs` | the full node loop in headless Chromium with this process as the verifier |
| `test_wasm.mjs` / `test_node.mjs` / `test_swarm.mjs` / `test_spmv.mjs` | tests (see below); `crosscheck.py` / `int_spmv.py` — Python cross-checks |
| `../../contracts/evm/test/BrowserClaim.t.sol` | the node's claim verified **on-chain**: `mep_id` and claim-hash encodings recomputed, `ecrecover` signer |

## Build, test, run

```sh
cd web/porw-browser
./build.sh                    # clang --target=wasm32 -O3 -msimd128 → sketch.wasm
npm install                   # playwright (drivers), @noble/hashes, @noble/secp256k1
npm test                      # test_wasm (keccak fixture) + test_node (loop, fraud) + test_swarm

# audit-throughput PoC (workers)
PW_CHROMIUM=/path/to/chrome node run_browser.mjs --mib 521 --workers 4
# full node loop at FlyWire scale (export a payload first, see int_spmv.py / demo payload.py)
PW_CHROMIUM=/path/to/chrome node run_node_browser.mjs --payload flywire-female.bin --steps 2 --samples 16 --rounds 3
# Python cross-checks: sketches vs native kernel; integer SpMV vs numpy int64
../../gpu/triton/.venv/bin/python crosscheck.py result.json
../../gpu/triton/.venv/bin/python int_spmv.py flywire-female 20000 200000 1 3 /tmp/x && node test_spmv.mjs /tmp/x
```

## What is verified

- **Scheme conformance**: wasm keccak256 == noble on all block sizes; scheme digest,
  slot seed, sketches, weights/partials leaves and roots, Merkle proofs — all
  bit-identical to `spec-cache/conformance/porw/sketch-tile-keccak-v1.json`
  (cached from aigg-spec, provenance in `…SOURCE.md`); tampered leaves rejected;
  duplicate-last trees verified at every index; cached trees == streaming trees.
- **Sketch kernel**: browser sketches bit-identical to the native AVX2 kernel
  (`crosscheck.py`, 133,376 values, single-thread and multi-worker).
- **Deterministic inference**: wasm integer SpMV bit-identical to the numpy int64
  reference (digest, sum, non-zero count); Chromium == Node; re-executing with the
  wrong MEP's parameters does **not** match.
- **Node loop** (two MEPs, female + male): MEP ids match the verifier's independent
  derivation; claims verify (scheme, MEP, model, challenge, hash, signature); a
  claim is rejected against another MEP; tampered/malformed signatures rejected
  (never a crash); sampled openings verify with the sketch recomputed from the
  opened bytes; a **lie in one committed tile → `fraud`**, an honest tile →
  `no_fraud`, forged bytes → `invalid`; redundant re-execution matches.
- **On-chain**: `forge test` recomputes `mep_id` and the claim hash from the
  fields and `ecrecover`s the signer (61k gas incl. JSON parsing).
- **Mesh**: sortition is deterministic, stake-weighted, excludes ineligible
  instances and the claimant (for auditors), spreads load across tasks;
  settlement detects a dissenter and flags a fraud-proof round.

## Measured (4-core Xeon, no GPU, Chromium 141; `benchmarks/browser/`)

| | |
|---|---|
| residency audit of 521 MiB (sketch only) | 127.6 ms single thread; **43.6 ms with 4 workers** |
| one-time model load: weights leaves + model id | ~7.4 s (single wasm thread) |
| per slot, single thread: sketch + partials commit + inference (54.5M syn × 2) | ~140 + ~350 + ~450–650 ms ≈ **0.9–1.2 s** |
| 16 sampled openings served | **16–18 ms** (cached trees) |
| redundant re-execution (Node) | ~0.8–0.9 s |

The per-slot cost is dominated by the keccak partials commitment and the inference,
not the sketch; workers would parallelize the first two ≈ 4×.

## Design and honest limits

The settlement design that consumes these artifacts — redundancy, beacon sortition,
cross-audit, and the interactive execution fraud proof down to one synapse — is in
[`contracts/evm/DESIGN-cross-audit.md`](../../contracts/evm/DESIGN-cross-audit.md)
with interfaces in `contracts/evm/src/interfaces/PorwMesh.sol`.

- **No TEE in a browser.** Execution correctness comes from determinism +
  redundancy + cross-audit + fraud proofs, not hardware.
- **Residency is eligibility, not the rewarded resource.** A 521 MiB model is not
  scarce and the DRAM envelope is weak against SSDs over a jittery network; the
  rewarded resource is verified, stake-gated execution units.
- **Not yet in the node**: workers for leaves/sketch in the node path; per-step
  activation roots and the CSR `synapseRoot` needed by the execution dispute;
  gossip transport (libp2p/WebRTC); wallet (EIP-712) signing; contract wiring.
