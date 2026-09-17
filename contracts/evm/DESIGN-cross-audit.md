# Redundancy / cross-audit settlement for browser fly-brain instances

**Status:** implemented (`src/mesh/`) and tested end to end against artifacts the browser
node produced (`test/Mesh.t.sol`, fixtures from `web/porw-browser/export_fixtures.mjs`);
the browser node and verifier primitives exist and are measured. Chain-neutral EVM; target deployments are the
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
| residency claim | `(schemeDigest, mepId, modelId, partialsRoot, uint64 coverageBytes, challenge, deviceId, execDigest, uint32 stimulusSeed)`; the raw keccak is the off-chain identifier, the on-chain signature is the **EIP-712** `Claim` digest (§3a), `ecrecover` | `claim.js`; `BrowserClaim.t.sol` |
| tile opening | `(tileIdx, tile[4096], s_tile, partialsIndex, partialsProof[], weightsProof[])` | `node.js` → `verifyTileFraudProofKeccak` |
| execution result | `execDigest = keccak(act_final as LE u32[])`; `execRoot = merkle([actRoot[1..steps]])` with `actRoot[s]` over leaves `keccak(LE32 i ‖ LE32 act_s[i])` (§5) | `spmv_wasm.c`, `dispute_wasm.c`, `node.js` |
| CSR commitments (per model) | `csrRoot` over chunk leaves `keccak(LE32 c ‖ 64 post-sorted records)`, `rowRoot` over `keccak(LE32 i ‖ LE32 rowStart[i])` (n+1 leaves), `synapseRoot = keccak(csrRoot ‖ rowRoot)` | `dispute_wasm.c`, `node.js`, `verify.js` |
| task id | `keccak(mepId ‖ uint32 stimulusSeed ‖ nonce32)` | `swarm.js` |
| assignment | index sortition over stake-weighted eligible votes (§4) | `swarm.js` `assignSortition` |

Scheme digest `keccak256("aigg:porw:sketch-tile-keccak:v1")` and exec kind
`keccak256("aigg:exec:int-spmv-q16:v1")` are pinned constants.

One MEP per released brain (female FlyWire adult brain, male CNS, …): same scheme,
different `model_id` and execution parameters ⇒ different `mep_id`. A node hosts any
subset; a claim binds exactly one MEP and cannot be rebound (tested).

**Publication convention.** A MEP's payload SHOULD list synapse records sorted by
post neuron (CSR order). Then `perm` is the identity, chunk leaves hash contiguous
bytes, and row-parallel inference streams sequentially — measured 672 → 67 ms per
step on 4 workers. Unsorted payloads still work (the node builds the permutation)
but every synapse read becomes a random access into the payload.

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

## 3a. Wallet signing (EIP-712) and session keys — implemented

Claims and results are typed data (`PorwEIP712.sol`, `web/porw-browser/eip712.js`): domain
`{name "PoRW Mesh", version "1", chainId, verifyingContract}` (the claim manager for
`Claim`, the task market for `Result`, the instance registry for `Delegation`), structs
`Claim(bytes32 schemeDigest,bytes32 mepId,bytes32 modelId,bytes32 partialsRoot,uint64
coverageBytes,bytes32 challenge,bytes32 deviceId,bytes32 execDigest,uint32 stimulusSeed)`,
`Result(bytes32 taskId,bytes32 execDigest,bytes32 execRoot)`,
`Delegation(address instance,address session,uint64 expiry)`. Signatures are low-s only.

A wallet prompts per signature, and a tab produces one claim per epoch and one result per
task, so the tab holds an **ephemeral session key** and the bonded wallet signs **one**
`Delegation` (`eth_signTypedData_v4`), which anyone submits as
`InstanceRegistry.delegateBySig` (or the wallet calls `setSessionKey`). Every signer is
resolved by `InstanceRegistry.resolve`: a bonded wallet is itself; a session key maps to
its instance until `expiry` (block number) or `revokeSessionKey`; a session key can be
neither a bonded wallet nor already taken. Claims are keyed and slashed by the instance,
results are attributed to the instance, and dispute moves may be sent from the session
key. The auditor verifies the delegation off-chain (the claim envelope carries it) and
keys `claimId` by the wallet.

Verified three ways: the node's hand-coded digests, a generic `hashTypedData` over the
`eth_signTypedData_v4` JSON (the wallet's view), and Solidity agree (`test_eip712.mjs`,
`BrowserClaim.t.sol`); the mesh tests deploy the contracts at the fixture domains'
addresses (`deployCodeTo`, chain id 31337) and run the whole settlement with session-key
signatures, including a revoked delegation and dispute moves through the session key;
`run_wallet_browser.mjs` drives a Chromium tab with an injected EIP-1193 wallet simulated
outside the page: exactly one wallet prompt (`Delegation`), then claims over the relay
signed by the session key, resolved by the auditor to the wallet.

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

Transport: browsers cannot listen. **Stage 1 (implemented)**: bonded WebSocket relays
(`RelayRegistry.sol`; `web/porw-browser/relay.js`) — stateless pub/sub rooms per MEP
(claims, task announcements) and per instance inbox (audit requests/responses, tasks/
results). Every message is a signed envelope (`envelope.js`: `keccak("porw-msg" ‖ type ‖
mepId ‖ ts ‖ keccak(canonical payload))` signed by the reward key), so relays are never
trusted for correctness; receivers verify and de-duplicate, and an instance fans out to
≥ 2 relays so one honest relay suffices. A relay can only drop or delay (liveness), and
silence is what the contracts punish, so the fallbacks stay on-chain: an unresponsive
instance gets a deposit-backed `challengeOpening` and answers with `respondOpening`
itself (the node produces that exact struct); dispute moves are direct transactions.
Tested (`test_relay.mjs`, `run_relay_browser.mjs` with a Chromium tab as the instance):
audits and tasks through two relays with a third censoring relay, forged/tampered/
spoofed envelopes dropped at the relay and at the client, all-censoring relays →
escalation + on-chain fallback. **Stage 2**: the same envelopes over libp2p gossipsub
(WebRTC + circuit relay) when instance counts make operated relays a bottleneck; the
chain remains the source of truth for registry, beacon, claims, results, settlement. No
instance is special.

## 5. Execution fraud proof (interactive bisection to one synapse)

On-chain re-execution of 54.5M synapse-steps is impossible; the dispute narrows a
disagreement to a single arithmetic term, then the contract checks that term.

Executors commit, with each result: `execRoot = merkle([actRoot[1..steps]])`, where
`actRoot[s]` is the Merkle root over per-neuron leaves `keccak(LE32 neuron ‖ LE32 act_s)`.
Measured cost in the browser: ~250 ms per slot for two steps on 4 workers (leaves in
parallel, block-parallel trees); required so that a wrong step can be isolated
without recomputing earlier ones. Step 0 is the stimulus, a pure function of
`stimulusSeed` — no tree. **Implemented and tested** (`dispute_wasm.c`, `dispute.js`,
`test_dispute.mjs`), including the row check below.

Given two executors A, B with different `execDigest`:

1. **Step**: compare `actRoot[s]` for s = 1..steps (steps is small; no bisection
   needed) → first differing step `s*`. Both agree on `actRoot[s*−1]` (or the
   stimulus, which is a pure function of `stimulusSeed`).
2. **Neuron**: bisect over the neuron index space of `actRoot[s*]` (≤ 18 rounds for
   139k neurons; or the challenger names the differing neuron `i*` directly with
   both openings) → a neuron whose `act_{s*}[i*]` differs.
3. **Row check, then synapse**: each party opens its claimed `act_{s*}[i*]` and its
   running partial sums over `i*`'s incoming range `[rowStart[i*], rowStart[i*+1])`
   (bounds opened with two `rowRoot` proofs). A party whose claimed activation is not
   `min(lastPartialSum >> 16, clamp)` loses immediately (a lie in the activation
   alone). Otherwise bisect the partial sums (≤ ~9 rounds for an average in-degree
   ≈ 390; bounded by `MAX_IN_DEGREE`) → the first position `k*` where the parties'
   running sums diverge.
4. **Check**: the contract verifies the CSR chunk containing `k*` (proof in `csrRoot`;
   64 records per chunk, so the opening is ≈ 644 B + ~20 × 32 B), reads record `k*`
   (its `post` must be `i*`), opens the input activation `act_{s*−1}[pre_{k*}]` (proof in
   the *agreed* `actRoot[s*−1]`, or the stimulus rule when `s* = 1`), recomputes
   `term = w · act` in u64 and requires `partialAfter == partialBefore + term` for each
   party; exactly one fails and is slashed. The winner and the challenger are paid
   from the slashed bond.

Every round is one transaction carrying two or three Merkle proofs (≈ 18 × 32 B
each); estimated 100–200k gas per round; measured 13 bisection rounds for a 5k-neuron
model (≈ 18 for 139k), plus ≤ ~9 for the synapse range, plus the final check. Rare by
construction (only on disagreement among bonded parties).

## 5b. Implementation and measured gas (`src/mesh/`, `test/Mesh.t.sol`)

`MEPRegistry`, `InstanceRegistry` (bond / exit delay / slash / stake-weighted eligible
votes), `PoRWClaimManager` (epoch beacon, `ecrecover`'d claims, opening challenges
adjudicated by `PorwVerifierKeccak.verifyTileFraudProofKeccakCounted`, deposits,
timeouts), `TaskMarket` (index sortition, signed results, unanimous settlement or
dispute, payout after resolution) and `ExecutionDisputes` (reveal roots → children
rounds bound by `keccak(l‖r) == node` → row post → single-term check; timeouts).
The released `PorwVerifier` bytecode is untouched: the keccak counted path lives in
`PorwVerifierKeccak`, which inherits it.

Tests run the whole flow on fixtures exported from real node runs: MEP registration,
bonding, the fixture-derived beacon/challenge, claims by three instances, NoFraud /
Fraud / Invalid / timeout openings (slash and payouts asserted), sortition of the
eligible pair, signed results, and three dispute endings — the divergent **term**
(B slashed, A paid slash + fee), the **row check**, and **timeout**. Per-function gas
(forge `--gas-report`, 4k-neuron fixture; larger models only add ~1 bisection round
per doubling):

| call | gas |
|---|---|
| `submitClaim` | ~240k |
| `challengeOpening` / `respondOpening` (incl. keccak tile fraud proof) / `claimExpiredChallenge` | ~96k / ~870k / ~68k |
| `postTask` / `submitResult` / `settle` (→ dispute) | ~190k / ~181k / ~341k |
| `revealRoots` (2 steps) | ~130–234k |
| `postChildren` (one bisection round, per party) | ~38–115k |
| `postRow` (in-degree 14) | ~176k |
| `proveSynapseTerm` | ~290k |
| `timeout` | ~27–205k |

A full dispute for a 139k-neuron model is ≈ 18 children rounds × 2 parties plus the
row and term calls — on the order of 4–5M gas total, paid by the loser's slash.

## 5c. Second execution kind: `aigg:exec:int-lif:v1` (real FlyWire brain, integer LIF)

The SpMV kind is a propagation stand-in. Research use needs a validated neuron model on
the real connectome, so a second execution kind is implemented end to end
(`web/porw-browser/lif_wasm.c`, `lif.js`, `int_lif.py`, `src/mesh/LifRowCheck.sol`):

- **Model bytes**: payload v2 from `demo/fly_brain/flywire_export.py` — the public
  FlyWire FAFB v783 release (Zenodo 10676866): 139,255 proofread neurons, 2,700,513
  post-sorted synapse records with ≥ 5 synapses, weight = signed synapse count (sign =
  presynaptic neurotransmitter, GABA/glutamate inhibitory, Dale's law), neuron record
  = FlyWire root id. 28 MB; `model_id` in `spec-cache/conformance/exec/int-lif-v1/`.
- **Rule**: a fixed-point port of the whole-brain LIF of Shiu et al. 2024 (dt 0.1 ms,
  τ_m 20 ms, τ_syn 5 ms, threshold 7 mV, refractory 2.2 ms, 0.275 mV/synapse, 150 Hz
  Poisson-like drive of stimulated neurons — here a hash-driven deterministic
  process). State per neuron: `(v i32, g i32, refr u16, flags u16, count u32)`;
  everything is integer with floor shifts and int32 saturation, so wasm == numpy ==
  JS == Solidity bit for bit (500 steps of the real brain checked against numpy;
  the on-chain rule checked on transition vectors covering every branch).
- **MEP encoding unchanged**: `execKind = keccak("aigg:exec:int-lif:v1" ‖ 6 × uint32
  params)` pins the parameter set; the fifth `mep_id` field is the **commit stride**
  instead of a clamp.
- **Task input**: a stimulus set (sorted neuron ids) ⇒ `state_0` (flags only) ⇒
  `initStateRoot`, which anyone derives from the ids and the task carries as
  `inputCommit`. Residency claims use the canonical set (`fmix32(i·G + seed) % 1000 == 0`).
- **Commitments**: state roots every `stride` steps and at the last step (segment
  roots); `execRoot = merkle(segmentRoots)`; `execDigest = keccak(LE32 n ‖ spike counts)`.
  Per-step trees are *not* committed: on dispute the parties reveal the per-step roots
  of the first differing segment, each chain bound by its last root equalling the
  committed segment root and its first predecessor being the agreed previous segment
  root (`dispute.js: refineSegment`). Measured on the real brain (4-core, Node, pool ×4):
  4 ms/step inference, ~116 ms per committed state root; stride 10 ⇒ ~1.6 s per
  100-step (10 ms brain-time) claim; research mode without commitments 9 ms/step
  single-thread (≈ 90 s per second of brain time per tab).
- **Dispute**: segment → step (refinement) → neuron (state-tree bisection) → **row
  check** `state_s[i] == transition(state_{s-1}[i], lastPartialSum, i, s, seed)` →
  **single term** `w_k · spiked_{s-1}[pre_k]` with signed partial sums; the previous
  state openings verify against the agreed previous-step root.
- **On-chain dispatch (implemented, `test/MeshLif.t.sol` on fixtures from real node runs
  via `export_lif_fixtures.mjs`)**: `ExecutionDisputes.openDispute` reads `MEP.execKind`;
  for the LIF kind it takes `stride = MEP.clampQ16`, `segments = ⌈steps/stride⌉` and
  `initStateRoot = Task.inputCommit`. Phases: `Step` (segment roots bound to `execRoot`)
  → **`Refine`** (`postStepRoots`: the per-step roots of the first differing segment;
  the chain must end at the party's committed segment root, the previous segment root
  or `initStateRoot` is agreed; a chain of the wrong length or end is rejected as
  `unbound chain`) → `Neuron` (unchanged `postChildren` over state trees) → `Synapse`
  (`postRowLif`: claimed state bound to the leaf via `LifRowCheck.stateLeaf`, signed
  `int64` sums) → `proveSynapseTermLif`: the neuron's own previous state opened against
  the agreed root (row check = `LifRowCheck.transition`), then the first divergent
  position, the CSR chunk (record weight read as `int16`), the input neuron's previous
  state (its spike flag) and `term = w · spiked`. The SpMV functions revert with
  `phase` in LIF mode and vice versa; `timeout` covers the Refine phase. Measured gas:
  `postStepRoots` 275k (10 roots), `postChildren` 75k, `postRowLif` 109k (in-degree
  34), `proveSynapseTermLif` 183k. Tests: input-sum liar caught at the signed term,
  state liar caught by the row check, borrowed/short chains rejected, Refine timeout.

## 6. Economics (deployment choices, token-neutral)

- Per-epoch, per-MEP fixed budget; "raw volume is not a reward multiplier" (AI3 pilot
  posture). Payment per **settled task unit**, split across the `r` agreeing executors.
- Residency claim ⇒ eligibility only; no reward for residency itself.
- Slashing: proven residency lie (tile fraud, or opening timeout) and proven execution
  lie (dispute loss). Challenger bounty from the slashed bond; false challenges lose
  their deposit.
- Stake asset and settlement chain are deployment choices: AI3 on Auto EVM for the
  pilot; BNB bond + BSC/opBNB settlement + Greenfield weights for a BNB deployment.
  The BNB deployment is its own repository, staged in `proposals/aigg-bnb/` (design,
  commit-reveal `IBeacon` for PoSA chains, Greenfield pointer + verified fetch,
  deployment script, `split.sh` to cut the standalone repo); `PoRWClaimManager` takes an
  `IBeacon` so nothing chain-specific lives here.

## 7. Measured inputs to the design (browser, 4-core, no GPU)

| item | measured |
|---|---|
| tile fraud proof on-chain (keccak scheme) | 1,106,534 gas (2.1% of a 52M block; ~0.8% of BSC's 140M) |
| ecrecover of a claim | ~3.2k gas; claim hash + recovery test passes (`BrowserClaim.t.sol`) |
| residency audit in-browser, 521 MiB | 44 ms with 4 workers; ~140 ms single thread |
| per-slot node work incl. dispute commitments, 4 workers, post-sorted, parallel trees | sketch ~55 + partials commit ~130 + inference ~70 + dispute commit ~250 ≈ **0.5 s** (single thread: 1.8 s) |
| one-time model load (weights leaves, model id, CSR commitments) | 5.7 s (4 workers); 18.6 s single thread |
| 16 sampled tile openings | 16–19 ms (cached trees) |
| redundant re-execution (Node, same wasm) | ≈ 0.65–0.8 s |

## 8. Honest limits

- No hardware root of trust: correctness rests on at least one honest, bonded
  executor or auditor per task/claim and on the bisection being followed through.
  Collusion of all `r` executors on a task is not detected by settlement — only by an
  independent re-execution (the client, or an auditor); the design keeps re-execution
  cheap (≈ 1 s) precisely so that anyone can check.
- Browser residency is weak as a scarcity signal; it is used as eligibility only.
- The interactive dispute's commitments (`actRoot[s]`, `execRoot`, `csrRoot`,
  `rowRoot`, `synapseRoot`) and the verifier-side protocol are implemented and tested
  off-chain; the on-chain contracts are the next step.
