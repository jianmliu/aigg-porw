# Redundancy / cross-audit settlement for browser fly-brain instances

**Status:** design + interfaces (`src/interfaces/PorwMesh.sol`); verifier primitives and
the browser node exist and are measured. Chain-neutral EVM; target deployments are the
AI3 pilot (Auto EVM) and, as a separate ecosystem proposal, BNB Chain (BSC/opBNB with
Greenfield for weights). Nothing here changes a PoRW scheme id.

## 1. Why this design

A browser instance has no TEE. Its execution proof cannot come from hardware, so it comes
from three things the browser node already produces deterministically:

1. **Residency** — a PoRW claim over the model (`sketch-tile-keccak:v1`), audited by
   sampled tile openings; the on-chain adjudicator is the existing
   `PorwVerifier.verifyTileFraudProofKeccak` (measured 1,106,534 gas).
2. **Deterministic execution** — integer fixed-point SpMV (`aigg:exec:int-spmv-q16:v1`):
   every engine and every node computes bit-identical activations, so a result is a
   32-byte digest others can recompute (proven: wasm == numpy int64; Chromium ==
   Node; wrong MEP ⇒ mismatch).
3. **Redundancy** — every task is executed by `r` independent, beacon-selected,
   bonded instances; agreement settles, disagreement opens an interactive fraud proof
   that ends in the contract recomputing **one synapse contribution**.

Residency is *eligibility*, not the rewarded resource: a 521 MiB model is not scarce and
the DRAM envelope is weak over a jittery network (see `web/porw-browser/README.md`).
The rewarded resource is **verified execution units**, from a fixed per-epoch budget per
MEP, stake-gated (opening a thousand tabs is free; a bond is not).

## 2. Artifacts (all implemented in `web/porw-browser/`, pinned by tests)

| artifact | encoding (keccak256 of `abi.encodePacked(...)`) | where |
|---|---|---|
| `model_id` | weights Merkle root (keccak leaves `LE64 tile ‖ tile`) | `commit_wasm.c`, fixture-locked |
| `mep_id` | `(bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 steps, uint32 clampQ16)` | `mep.js`; `BrowserClaim.t.sol` |
| residency claim | `(schemeDigest, mepId, modelId, partialsRoot, uint64 coverageBytes, challenge, deviceId, execDigest, uint32 stimulusSeed)`, secp256k1 signature, `ecrecover` | `claim.js`; `BrowserClaim.t.sol` |
| tile opening | `(tileIdx, tile[4096], s_tile, partialsIndex, partialsProof[], weightsProof[])` | `node.js` → `verifyTileFraudProofKeccak` |
| execution result | `execDigest = keccak(act_final as LE u32[])`, plus per-step activation roots `actRoot[s]` (§5) | `spmv_wasm.c`, `node.js` |
| task id | `keccak(mepId ‖ uint32 stimulusSeed ‖ nonce32)` | `swarm.js` |
| assignment | index sortition over stake-weighted eligible votes (§4) | `swarm.js` `assignSortition` |

Scheme digest `keccak256("aigg:porw:sketch-tile-keccak:v1")` and exec kind
`keccak256("aigg:exec:int-spmv-q16:v1")` are pinned constants.

One MEP per released brain (female FlyWire adult brain, male CNS, …): same scheme,
different `model_id` and execution parameters ⇒ different `mep_id`. A node hosts any
subset; a claim binds exactly one MEP and cannot be rebound (tested).

## 3. Contracts and state ownership

Modularized at trust/state boundaries (aigg-spec §2.1). Small modules may share a
deployable, but each owns its state.

- **`IMEPRegistry`** — `registerMEP(mepId, modelId, schemeDigest, execKind, steps,
  clampQ16, weightsDA, synapseRoot)`. `weightsDA` is a content pointer for the
  bytes (Greenfield object id / DSN piece / IPFS CID); `synapseRoot` is the Merkle
  root over synapse records **sorted by post-neuron** (CSR order) with per-neuron
  range boundaries — needed only by the execution fraud proof (§5). The registry is
  append-only; a MEP is immutable once registered.
- **`IInstanceRegistry` + bond** — `bond(mepIds[])` escrows the deployment's stake
  asset (AI3 on Auto EVM; BNB on BSC); `requestExit` → `finalizeExit` after
  `EXIT_DELAY`; `slash(instance, amount, beneficiary)` callable only by the claim
  manager / disputes. Eligibility for epoch `e` = bonded ∧ has an unchallenged (or
  successfully defended) residency claim for `e−1` on that MEP.
- **`IPoRWClaimManager`** — `submitClaim(claim, sig)` per (instance, MEP, epoch):
  stores `partialsRoot`, `coverageBytes`, `execDigest`; `challengeOpening(claimId,
  tileIdx)` with a deposit opens a window `OPENING_WINDOW`; the instance answers
  `respondOpening(...)`, verified by `PorwVerifier.verifyTileFraudProofKeccak`
  (Fraud ⇒ slash + pay challenger; NoFraud ⇒ challenger's deposit to instance;
  timeout ⇒ treated as fraud). The honest path is **off-chain**: beacon-selected
  auditors (§4) sample openings directly from the node and only escalate on-chain
  when a check fails, so per-epoch on-chain cost is one claim tx per (instance, MEP).
- **`ITaskMarket`** — `postTask(mepId, stimulusSeed, inputCommit, fee, deadline)`;
  executors are the sortition set (§4); each submits `submitResult(taskId,
  execDigest, execRoot, sig)`. `settle(taskId)`: all `r` agree ⇒ pay from `fee` and
  the epoch budget, record the fact (`TaskSettled`); any disagreement ⇒
  `DisputeOpened` (§5). Stragglers past `TASK_TIMEOUT` are replaced by the next
  sortition index; the client can always verify the result itself by re-execution.
- **`IExecutionDisputes`** — the interactive fraud proof (§5).
- **Epoch aggregation** — claims and settled tasks roll into `EpochPoRWRoot`-style
  facts (aggregator untrusted for correctness: it cannot forge signatures or survive
  challenges on a wrong root), consumed read-only by rewards/incentive vaults.

## 4. The mesh ("swarm") — coordination without a coordinator

Every user who loads a MEP is an instance that can take distributed tasks. The
coordination primitive is **not** swarm-intelligence optimization (PSO/ACO are
heuristics for search problems); it is *verifiable, leaderless assignment*:

```
votes      = each eligible instance repeated `weight` times (stake-weighted)
executor_j = votes[ keccak(beacon ‖ mepId ‖ taskId ‖ j) mod |votes| ],  j = 0,1,2,…
             skipping instances already chosen, until r distinct executors
backups    = the remaining eligible instances in the same order (used on timeout)
auditors   = same rule keyed on the claimHash, excluding the claimant
```

Properties: any party computes the same sets from public inputs (beacon, registry),
so audits and disputes are unambiguous; load spreads because different tasks pick
different indices; stake weighting is Sybil resistance; ineligible instances (failed
residency, unbonded) are never chosen. `beacon` is the epoch entropy (PoT
`BlockRandomness` on Auto EVM; `prevrandao`/a VRF-style beacon elsewhere) — never a
value the claimant controls. Implemented and tested in `swarm.js` (`assignSortition`,
`auditors`, `settle`); rendezvous hashing is kept as an off-chain alternative but the
contract and the mesh must share one rule.

Transport: browsers cannot listen. Tasks/results/openings travel over a gossip layer
(libp2p gossipsub with the WebRTC transport, or a relay); the chain is the source of
truth for registry, beacon, claims, results, and settlement. No instance is special.

## 5. Execution fraud proof (interactive bisection to one synapse)

On-chain re-execution of 54.5M synapse-steps is impossible; the dispute narrows a
disagreement to a single arithmetic term, then the contract checks that term.

Executors commit, with each result: `execRoot = merkle([actRoot[1..steps]])`, where
`actRoot[s]` is the Merkle root over per-neuron leaves `keccak(LE32 neuron ‖ LE32 act_s)`.
(Cost in the browser: `steps × n_neurons` keccaks ≈ a few hundred ms per task;
required so that a wrong step can be isolated without recomputing earlier ones.)

Given two executors A, B with different `execDigest`:

1. **Step**: compare `actRoot[s]` for s = 1..steps (steps is small; no bisection
   needed) → first differing step `s*`. Both agree on `actRoot[s*−1]` (or the
   stimulus, which is a pure function of `stimulusSeed`).
2. **Neuron**: bisect over the neuron index space of `actRoot[s*]` (≤ 18 rounds for
   139k neurons; or the challenger names the differing neuron `i*` directly with
   both openings) → a neuron whose `act_{s*}[i*]` differs.
3. **Synapse**: `act_{s*}[i*] = min(acc >> 16, clamp)`, `acc = Σ_{k∈in(i*)} w_k · act_{s*−1}[pre_k]`
   over `i*`'s incoming synapses (contiguous in the CSR-ordered `synapseRoot`; the
   range boundaries are opened with two proofs). Bisect the partial sums over the
   range (≤ ~9 rounds for an average in-degree ≈ 390; bounded by `MAX_IN_DEGREE`)
   → one synapse `k*` where the parties' running sums diverge.
4. **Check**: the contract verifies one synapse record (proof in `synapseRoot`) and one
   input activation `act_{s*−1}[pre_{k*}]` (proof in `actRoot[s*−1]`), recomputes
   `w · act` and the single-step partial-sum update in u64, and rules. The loser is
   slashed; the winner and the challenger are paid from the slashed bond.

Every round is one transaction carrying two or three Merkle proofs (≈ 18 × 32 B
each); estimated 100–200k gas per round, ≤ ~30 rounds worst case. Rare by
construction (only on disagreement among bonded parties).

## 6. Economics (deployment choices, token-neutral)

- Per-epoch, per-MEP fixed budget; "raw volume is not a reward multiplier" (AI3 pilot
  posture). Payment per **settled task unit**, split across the `r` agreeing executors.
- Residency claim ⇒ eligibility only; no reward for residency itself.
- Slashing: proven residency lie (tile fraud, or opening timeout) and proven execution
  lie (dispute loss). Challenger bounty from the slashed bond; false challenges lose
  their deposit.
- Stake asset and settlement chain are deployment choices: AI3 on Auto EVM for the
  pilot; BNB bond + BSC/opBNB settlement + Greenfield weights for a BNB deployment
  (proposed separately in aigg-spec, not a change to the AI3 pilot).

## 7. Measured inputs to the design (browser, 4-core, no GPU)

| item | measured |
|---|---|
| tile fraud proof on-chain (keccak scheme) | 1,106,534 gas (2.1% of a 52M block; ~0.8% of BSC's 140M) |
| ecrecover of a claim | ~3.2k gas; claim hash + recovery test passes (`BrowserClaim.t.sol`) |
| residency audit in-browser, 521 MiB | 44 ms with 4 workers; ~140 ms single thread |
| per-slot node work, single thread | sketch ~140 ms + partials commit ~335 ms + inference (54.5M syn × 2 steps) ~0.4–0.55 s ≈ 0.9–1.0 s |
| one-time model load | weights leaves + model id ≈ 7.4 s (single wasm thread) |
| redundant re-execution (Node, same wasm) | ≈ 0.8 s |

Workers parallelize sketch, weights leaves, and partials leaves (≈ 4× on 4 cores).

## 8. Honest limits

- No hardware root of trust: correctness rests on at least one honest, bonded
  executor or auditor per task/claim and on the bisection being followed through.
  Collusion of all `r` executors on a task is not detected by settlement — only by an
  independent re-execution (the client, or an auditor); the design keeps re-execution
  cheap (≈ 1 s) precisely so that anyone can check.
- Browser residency is weak as a scarcity signal; it is used as eligibility only.
- The interactive dispute needs the CSR `synapseRoot` and per-step `actRoot`s to be
  committed; both are straightforward but not yet implemented in the browser node.
