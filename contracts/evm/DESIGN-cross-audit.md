# Redundancy / cross-audit settlement for browser fly-brain instances

**Status:** implemented (`src/mesh/`) and tested end to end against artifacts the browser
node produced (`test/Mesh.t.sol`, fixtures from `web/porw-browser/export_fixtures.mjs`);
the browser node and verifier primitives exist and are measured. Chain-neutral EVM; target deployments are the
AI3 pilot (Auto EVM) and, as a separate ecosystem proposal, BNB Chain (BSC/opBNB with
Greenfield for weights). Nothing here changes a PoRW scheme id.

## 1. Why this design

A browser instance has no TEE. Its execution proof cannot come from hardware, so it comes
from three things the browser node already produces deterministically:

1. **Residency** — a PoRW claim over the model (`sketch-tile-keccak:v3`), audited by
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
| `mep_id` | `(bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 neurons, uint32 synapses, bytes32 synapseRoot)` — every field a function of the model bytes, so anyone derives the same id and registration is not a race; **no run parameters**, so one brain is one residency set | `mep.js`; `BrowserClaim.t.sol` |
| residency claim | `(schemeDigest, mepId, modelId, partialsRoot, uint64 coverageBytes, challenge)` — residency only; the raw keccak is the off-chain identifier, the on-chain signature is the **EIP-712** `Claim` digest (§3a), `ecrecover` | `claim.js`; `BrowserClaim.t.sol` |
| tile opening | `(tileIdx, tile[4096], s_tile, partialsIndex, partialsProof[], weightsProof[])` | `node.js` → `verifyTileFraudProofKeccak` |
| execution result | `execDigest = keccak(act_final as LE u32[])`; `execRoot = merkle([actRoot[1..steps]])` with `actRoot[s]` over leaves `keccak(LE32 i ‖ LE32 act_s[i])` (§5) | `spmv_wasm.c`, `dispute_wasm.c`, `node.js` |
| CSR commitments (per model) | `csrRoot` over chunk leaves `keccak(LE32 c ‖ 64 post-sorted records)`, `rowRoot` over `keccak(LE32 i ‖ LE32 rowStart[i])` (n+1 leaves), `synapseRoot = keccak(csrRoot ‖ rowRoot)` | `dispute_wasm.c`, `node.js`, `verify.js` |
| task id | `keccak(abi.encode(Task, nonce32))` — the whole task, so a squatter cannot take the id with different parameters | `swarm.js` |
| assignment | index sortition over stake-weighted eligible votes (§4) | `swarm.js` `assignSortition` |

Scheme digest `keccak256("aigg:porw:sketch-tile-keccak:v3")` and exec kind
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

- **`IMEPRegistry`** — `registerMEP(modelId, schemeDigest, execKind, neurons, synapses,
  synapseRoot, weightsDA)`. Step count and commit stride are **not** here: they are
  per-task (`ITaskMarket.Task`), read only by the dispute machinery. `weightsDA` is a content pointer for the
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
  stores a commitment to `partialsRoot`, `coverageBytes`; `challengeOpening(claimId,
  tileIdx)` with a deposit opens a window `OPENING_WINDOW`; the instance answers
  `respondOpening(...)`, verified by `PorwVerifier.verifyTileFraudProofKeccak`
  (Fraud ⇒ slash + pay challenger; NoFraud ⇒ challenger's deposit to instance;
  timeout ⇒ treated as fraud). The honest path is **off-chain**: beacon-selected
  auditors (§4) sample openings directly from the node and only escalate on-chain
  when a check fails, so per-epoch on-chain cost is one claim tx per (instance, MEP).
- **`ITaskMarket`** — `postTask(mepId, stimulusSeed, steps, commitStride, initStateRoot, fee, deadline, redundancy)`, with `1 ≤ commitStride ≤ steps` and every dispute round bounded by `MAX_ROOTS` (int-lif: `ceil(steps/commitStride)` and `commitStride`; int-spmv-q16: `steps`), so the honest party can always post;
  executors are the sortition set (§4); each submits `submitResult(taskId,
  execDigest, execRoot, sig)`. `settle(taskId)`: all `r` agree ⇒ pay from `fee` and
  the epoch budget, record the fact (`TaskSettled`); any disagreement ⇒
  `DisputeOpened` (§5). Stragglers past `TASK_TIMEOUT` are replaced by the next
  sortition index; the client can always verify the result itself by re-execution.
- **`IExecutionDisputes`** — the interactive fraud proof (§5).
- **Epoch aggregation (implemented, `postEpochRoot` / `materializeClaim`)** — on
  chains where one claim tx per instance per epoch is too expensive (BSC), an
  **untrusted aggregator** (`web/porw-browser/aggregator.js`) collects the epoch's
  signed claims over the relay, verifies each, builds one Merkle tree (leaves
  `keccak(abi.encode(mepId, instance, partialsRoot, coverageBytes, keccak(sig)))`,
  sorted by instance) and posts one root per (MEP, epoch).
  An instance fetches its inclusion proof over the relay (`claim-proof-request`) and
  `materializeClaim`s only when it needs on-chain eligibility (it wants tasks that epoch)
  or is audited; the signature is verified at materialization, so a junk leaf cannot be
  materialized, and an omitted instance falls back to `submitClaim`. Materialized claims
  are stored exactly like direct ones (eligibility, opening challenges, slashing). Measured:
  `postEpochRoot` ≈ 70k gas, `materializeClaim` ≈ 230k (4 leaves). Passive instances cost
  nothing on-chain; per-epoch chain cost is one root per MEP plus one materialization per
  instance that competes for tasks. Settled tasks still roll into epoch facts consumed
  read-only by rewards/incentive vaults.

## 3a. Wallet signing (EIP-712) and session keys — implemented

Claims and results are typed data (`PorwEIP712.sol`, `web/porw-browser/eip712.js`): domain
`{name "PoRW Mesh", version "1", chainId, verifyingContract}` (the claim manager for
`Claim`, the task market for `Result`, the instance registry for `Delegation`), structs
`Claim(bytes32 schemeDigest,bytes32 mepId,bytes32 modelId,bytes32 partialsRoot,uint64
coverageBytes,bytes32 challenge)`,
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
  `initStateRoot`. Residency claims use the canonical set (`fmix32(i·G + seed) % 1000 == 0`).
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
  `initStateRoot = Task.initStateRoot`. Phases: `Step` (segment roots bound to `execRoot`)
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
  `IBeacon` so nothing chain-specific lives here. The standalone repo (`jianmliu/aigg-bnb`) is
  deployed on BSC testnet with the real FlyWire brain published on Greenfield testnet and its
  MEP registered (see that repo's README for the record).

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


## Standing gas of the aggregated claim path (2026-09)

Eligibility in epoch `e` needs an on-chain claim for `e-1`, per instance, per MEP, per epoch, so the honest path's
standing cost is `instances x brains x epochs`. Two changes take most of it away without touching the claim, its
signature or the verdicts:

- **A claim on-chain is one word.** `claimRecord[claimId] = keccak(partialsRoot, coverageBytes)` with the
  validity flag in bit 0; eligibility reads that word. The contents are emitted (`ClaimData`) instead of stored. A
  challenger passes them back to `challengeOpening(instance, mepId, epoch, partialsRoot, coverageBytes,
  tile)`, which checks them against the commitment and only then writes them down for `respondOpening` — so the
  storage a verdict needs is paid once, by the challenger, on the rare path, not by every claim. Data availability of
  the contents is the event log, not the aggregator. `MEPRegistry.claimBinding` returns the two fields a claim is
  signed over instead of copying the whole profile (with its dynamic `weightsDA`) out of storage.
- **One root per epoch, not per MEP.** The leaf is `keccak(abi.encode(mepId, instance, partialsRoot, coverageBytes,
  keccak(signature)))` and `postEpochRoot(epoch, root, count)` is keyed by `(epoch, aggregator)`. The root is
  as untrusted as before: a leaf for an unknown MEP, an unbonded instance or a bad signature cannot be materialized, and
  a leaf presented under another MEP does not hash to the tree. JS: `aggregator.js` `EpochTree`.

Measured (`test/MeshAggregated.t.sol`, execution gas): `materializeClaim` 208,999 -> **59,643**; `postEpochRoot`
71,894 per MEP -> **51,215 per epoch**. For 200 brains with two hosts each and 144 epochs a day that is ~17.4 G gas a day
-> ~3.4 G (materializations) and ~2.1 G -> ~7 M (roots). Still open: eligibility inherited from a base brain by its
derived individuals, and materialization only when selected — both remove the per-brain factor altogether.

**Claim validity window (the third lever).** `InstanceRegistry.setClaimManager(cm, k)` sets, once, how many epochs a valid
claim keeps its instance eligible (default 1, at most 64). The claim manager keeps `lastValidEpochPlus1[instance][mep]`,
one reused word updated at every recorded claim and zeroed by a residency fraud verdict, so `isEligible` is a single read
whatever `k` is: eligible in epoch `e` iff the most recent valid claim is for an epoch `>= e - k`. Staying eligible then
costs one materialization every `k` epochs: the standing cost divides by `k`. The word adds ~22k gas to an instance's first
materialization for a MEP and ~5k to later ones (`materializeClaim` measured cold: 82k the first time; ~65k after). What a
longer window gives up is how often residency is proven, not what is paid for: execution is enforced per task by redundancy
and disputes, so an instance that dropped the model inside its window times out on its task rather than getting a wrong
result paid. Two semantics changed with it and are deliberate: a claim for the current epoch counts (it is fresher than
one for the previous epoch), and a fraud verdict ends the instance's standing for the whole window, not for one epoch.

## Shape fixes before anything is deployed (2026-09) — scheme `sketch-tile-keccak:v3`

Removing `deviceId` changes the Claim's EIP-712 type, the aggregated leaf and the seed of every sketch, so it carries a
new scheme id. The digest is pinned on-chain in one place: `SCHEME_SKETCH_TILE_KECCAK_V3`, which `MEPRegistry.registerMEP`
requires of every profile. `mep_id` hashes the scheme digest, so every MEP id moves with it; model ids, synapse roots and
execution digests do not.

- **No `deviceId`.** It was self-declared, its only live function was to vary the sketch seed, and it proved nothing a
  claim does not already fix: there is one claim per `(instance, MEP, epoch)`. The seed is now
  `deriveSlotSeed(challenge, instance)` = the first four bytes (LE) of `keccak256(abi.encode(challenge, instance))`, where
  `instance` is the bonded wallet the claim *resolves* to (the signer, or the wallet that delegated the session key). The
  field is gone from `Claim`, the EIP-712 type, the aggregated leaf, the stored commitment, `ClaimData`,
  `challengeOpening` and the tile fraud proof's arguments. A field whose only lawful value follows from another field is
  dead weight, and keeping it behind a `require` would have preserved the wrong shape. N identities cost N scans.
  (The wasm kernel is unchanged: it hashes two 32-byte words, and the second is now the address left-padded.)
- **`InstanceRegistry.bondFor(instance, mepIds)`**, which `bond()` now calls. A payer can only increase someone's bond;
  exit and withdrawal stay the instance's own calls. It is what lets a mint fund its minter's stake in one transaction and a
  breeder endow a child's owner. Enrolling *another* instance into a MEP takes at least one `UNIT`, because enrolment
  grows the list every sortition walks and that should cost a real bond (which the enrolled instance keeps).
- **`Task.initStateRoot`** (was `inputCommit`). It is the state root agreed before step 1 and nothing else; the old name
  invited reading it as a commitment to an input. `TaskMarket.taskInitStateRoot` follows. `abi.encode(task, nonce)` does
  not depend on field names, so task ids are unchanged.

## Standing for a replicator (challenging a settled result)

`TaskMarket.challengeResult` lets somebody who was never sortitioned put up a deposit and a disagreeing result against
a SETTLED task, which opens the same bisection two disagreeing executors would have run; `onDisputeResolved` is one
function that branches on `challenger[taskId]`. Four rules keep "one honest replicator is enough" true:

- **The disputed executor is fixed at settle** (`settledRef`), not looked up in `executors()`. That roster is a live view
  and `requestExit` removes an instance from it at once, while the bond stays slashable for `EXIT_DELAY`.
- **An open dispute holds both parties' exits** (`InstanceRegistry.disputeHolds`, set by `openDispute`, released by the
  verdict). A dispute takes a dozen rounds; without the hold a liar that asked to exit when it settled could finalize before
  the verdict. `setChallengeParams` also requires `window <= EXIT_DELAY`, so a challenge always lands before the exit could.
- **A lost challenge does not close the task.** Otherwise an accomplice challenges first (or front-runs the honest
  replicator), throws the game, and the wrong digest is unchallengeable for the price of gas. After a lost challenge the
  dispute state is forgotten and the task is challengeable again; the clock does not run while a challenge is open; half
  of a forfeited deposit goes to a sink rather than to the defender (who may be the accomplice's partner); and each further
  challenge of the same task must deposit twice the last, so keeping a task "in dispute" forever gets exponentially dear
  while an honest challenger gets its larger deposit back.
- **The fan-out slash is per executor and permissionless** (`ExecutionDisputes.slashAgreeing`): anyone names an executor
  whose recorded result equals the repudiated one. It does not iterate a roster inside the resolution.

Still true and deliberate: the fee is not clawed back; a task that settled THROUGH a pre-settlement dispute is not
challengeable (that bisection showed the winner right only at the first step where the two diverged).

## MEP terms: a beneficiary's share of every settled fee (2026-09)

A downstream collection wants the owner of a brain to earn when that brain is used. Done downstream it is a router that
takes a cut and forwards to `postTask` — and a client that prefers not to pay posts to `TaskMarket` directly. So the
share is a protocol rule or it is a social one. It is now a protocol rule.

- **Where the terms live.** `MEPRegistry.registerMEPWithTerms(mep, beneficiary, royaltyBps)`; the id is
  `keccak256(abi.encodePacked(profileId, beneficiary, royaltyBps))`, the profile id being the one `registerMEP` derives.
  The terms *wrap* the profile id instead of joining its fields, so every royalty-free id is what it was (no scheme
  bump: a residency claim is signed over `claimBinding` = scheme and model, which the terms do not touch) — and they are
  *inside* the id for the reason every other field is. The registry's invariant is that registration is not a race.
  A beneficiary kept beside the id would have made it one: the profile is derivable by anybody who has the bytes, and
  the first to register it would have owned its income for good.
- **Where the money moves.** `TaskMarket._pay` sets `fee * bps / 10000` aside in `royalties[mepId]` before the
  executors split the rest; `withdrawRoyalty(mepId)` pays the beneficiary, and only when the beneficiary asks. Set aside
  rather than sent, so a beneficiary that refuses ether cannot stop a task from settling; beneficiary-only with the
  amount returned, so a forwarding contract (one paying a token's *current* owner) knows what arrived and for which MEP.
  A refund (no agreeing executor) pays no royalty. A successful challenge does not claw one back, as it does not claw
  back the fee.
- **What it cannot do.** Make the bytes scarce. The model is public and content-addressed; the same brain under no
  terms is one `registerMEP` away. Bonds, residency claims and sortition are per MEP, so that twin starts with no
  executors, and standing them up costs a bond each and a materialized claim per validity window each — while an
  executor's gain from serving the twin is only the royalty it no longer shares. The rule holds while the royalty is
  below that, and no longer. It is a price, and should be set like one.
- `paidExecutors[taskId]` records at settle how many executors were paid. Something outside the market that pays per
  executed task (a hosting endowment that tops up the fee) needs the head count and must not take it from
  `executors()`, which is a live roster.

Tests: `test/MepTerms.t.sol` (8), and `web/porw-browser/test_mep_terms.mjs`, which pins the same id literal from the JS
side (`mep.js: withTerms`).

## The silence set and batched tasks (2026-09)

A perturbation atlas (every cell type silenced, in a hundred individuals, under a dozen stimuli) is millions of runs.
Two things stood between that and this market, and a measurement came first.

**What one task costs** (`test/TaskGas.t.sol`, `forge test --match-contract TaskGas --isolate -vv`; figures as a receipt
would give them: execution + 21,000 + calldata):

| | postTask | submitResult (sum) | settle | total |
|---|---|---|---|---|
| redundancy 1 | 215,335 | 207,515 | 205,669 | 628,519 |
| redundancy 2 | 215,335 | 419,097 | 229,755 | 864,187 |
| redundancy 3 | 215,335 | 638,352 | 256,964 | 1,110,651 |
| redundancy 2, MEP with terms | 215,335 | 417,589 | 253,335 | 886,259 |
| redundancy 2, **30** instances enrolled instead of 3 | 215,335 | 1,415,005 | 727,710 | 2,358,050 |

The last row is a finding, not a parameter. `executors()` rebuilds the stake-weighted vote list from every instance
enrolled for the MEP, and `submitResult` and `settle` both call it: about **55,000 gas per enrolled instance per task**.
A brain hosted by a thousand nodes cannot be tasked at all. It is not changed here (the fix is a sortition that does
not scan: an incrementally maintained vote list, or sortition over bonded instances with an inclusion proof at
`submitResult`), but every number below is on top of it.

**The silence set** is flags bit2 of `state_0`. `state_0` already carries the stimulus set in bit0 and the task already
commits to it (`initStateRoot`), so silencing a cell type is one more bit in a state the chain already binds, and
nothing new on chain: `spike = 0, v = 0, refr = 0` whatever else is set (silence wins over the stimulus), and
`flags' = (flags & 5) | spike << 1` so that it persists. A state with bit2 clear evolves exactly as before and no
implementation could build one with it set, so every digest, vector and fixture stands and the exec kind is still
`int-lif:v1`. Four implementations are held to each other state by state (`web/porw-browser/test_lif_silence.mjs`:
the wasm kernel, `lif.js`, `int_lif.py`; `LifRowCheck.t.sol` pins the vectors where the bit decides the outcome).
As a model variant the same atlas would have been a MEP per (individual, cell type).

**A batch** (`TaskMarket.postBatch(task, runs, nonce)`, int-lif only) is a Task whose `initStateRoot` is the root over
`runLeaf(k, seed_k, initStateRoot_k)` and whose `stimulusSeed` is 0. A run is fully described by its seed and its
`state_0`, because the stimulus set and the silence set are both inside `state_0`. A batch result is still one
`(execDigest, execRoot)`: `execRoot` is the root over `runResultLeaf(k, execRoot_k)`, and `execDigest` is a function of
it, enforced at `submitResult`. So sortition, `submitResult`, `settle`, the fee, the royalty and a replicator's challenge
are all untouched, and the honest path of a batch costs what one task costs:

| | total gas | per run |
|---|---|---|
| one task, redundancy 2 | 864,187 | 864,187 |
| a batch of 1,000 runs, redundancy 2 | 860,709 | **860** |

A disagreement is bisected to the first run the parties differ on (`Phase.Run`: `postChildren`, the same rounds as the
neuron bisection over another tree), each party opens its result for that run together with the run's input against
the runs root (`openRun`), and from there it is that run's dispute, from `Phase.Step`, unchanged. `test/Batch.t.sol`
runs it end to end: run 613 of 1,000 is the int-lif fixtures' task, and the liar is convicted of one signed term of one
step of that run. Finding the run costs one party about 1.1M gas (ten rounds and the opening), once, on the dispute
path only.

Two decisions in it that are not obvious:

- **A run's result is its `execRoot` and nothing else.** A single task's result has two fields, and a party that
  submits the honest `execRoot` with a wrong `execDigest` creates a disagreement with no step to bisect to: the second
  party's `revealRoots` reverts `"no divergence"`, so whoever reveals first wins by timeout. That is a defect of the
  single-task path as it stands (the digest is not bound to the root), and it is not fixed here; the batch simply does
  not reproduce it. The last segment root already commits every neuron's spike count.
- **`open` and `bisect` are gone from `IExecutionDisputes`.** They were stubs that always reverted ("use market", "use
  postChildren") and nothing referenced them. `ExecutionDisputes` was 1,826 bytes under the EIP-170 limit before the
  Run phase and over it after; forge does not enforce the limit in tests, so `Batch.t.sol` now does. It is 194 bytes
  under. The next feature in this contract needs custom errors or a split.

Not done here: the browser node does not yet execute a batch (K runs, the two trees, the run openings), and the
relayer does not announce one. The contracts and the rule are first because everything else is written against them.

## The two defects the measurement found, fixed (2026-09)

**The sortition no longer scans.** `executors()` rebuilt the stake-weighted vote list from every instance enrolled for
the MEP, and the market called it from `submitResult` (once per executor) and from `settle`. Now:

- A draw is constant time (`InstanceRegistry.sortitionPick`). The sortition hash's low 128 bits pick an *enrolled*
  instance uniformly, below the enrolment count the task fixed when it was posted (the list is append-only, so later
  enrolments move nobody); its high 128 bits accept the instance with probability `weight / weightCap(mepId)`; and it
  must be eligible for the task's epoch. Over repeated draws that is proportional to weight among the eligible, which
  is what walking the vote list gave (`SortitionAndDigest.t.sol` draws 800 tasks over weights 1, 1, 2, 4 and an
  ineligible 4). `weightCap` is the largest weight anybody bonded with while naming the MEP; it only grows. With every
  instance at one UNIT it is 1 and every draw is accepted; a whale at `MAX_WEIGHT` makes others' draws up to sixteen
  times more numerous, which is bounded and costs the whale a real bond. An instance that tops up without naming the
  MEP is drawn at the cap's weight: never more than its stake, and naming the MEP once corrects it.
- The roster is drawn **once, at `postTask`, and stored**. `executors()` reads it. This also closes the older problem
  that the roster was a live view: an instance that asked to exit, or a claim that landed later, changed who the
  executors of an open task were. And a task nobody can execute is now refused at post ("no eligible instances")
  instead of being accepted and stranded. The cost moves to the client's `postTask` (the draws, and one stored address
  per executor), and leaves everything after it.

| redundancy 2 | before | after |
|---|---|---|
| 3 instances enrolled | 864,187 | 782,170 |
| 30 instances enrolled | 2,358,050 | **782,170** |
| a batch of 1,000 runs | 860,709 | 831,777 (831 per run) |

Eligibility is still read at post time from live state, and a brain with many enrolled instances that are no longer
eligible makes draws miss: at most `64 × redundancy` of them, after which the task runs with fewer executors, as before.
The JS mirror is `swarm.js: assignSortition`; the fixture exporter uses it to find the nonces `Mesh.t.sol` posts, so
that test, which asserts the chain drew A and B, is a test of the mirror against the chain.

**Agreement is on the root.** Two results used to agree only if digest *and* root agreed, but nothing on chain binds
the digest (int-lif: keccak over every neuron's spike count) to the root. A party could submit the honest root beside
another digest and open a dispute with no step to bisect to: the second `revealRoots` reverted `"no divergence"`, went
unrecorded, and whoever revealed **first** won by timeout. It worked for an executor against its honest peer, and for a
challenger against an honest settled executor, at the price of a deposit it got back. Now:

- `settle` opens a dispute only when roots differ; `challengeResult` requires a different root ("agrees" otherwise);
  `_pay` pays everyone on the settled root; `slashAgreeing` slashes for the root that was proven wrong, so a different
  digest beside it is no way out (it used to read as "another result").
- What a task endorses as its digest is `settledDigest[taskId]`: the digest a strict majority of the paid executors
  gave, or `bytes32(0)` when they split. `TaskSettled` carries the same value.
- What is left: an executor can contest a digest for free (the task then endorses none, and the client takes the digest
  from a re-execution). It gains nothing by it. Making the digest adjudicable needs either a digest that is a function
  of the root (as a batch's is) or a bisection of the digest's own computation; neither is done here.

## Batches in the browser node (2026-09)

The contracts could settle and dispute a batch; nothing could execute one. Now the node can.

- `web/porw-browser/batch.js` mirrors `PorwMeshHash` (run leaf, run-result leaf, batch digest, batch id) and the Run
  phase (`bisectRuns`, the pair a party posts for a node of its result tree). `batch_vectors.json` holds four literals
  that `test_batch.mjs` asserts from the JS side and `Batch.t.sol` from the Solidity side.
- `PorwNode.executeBatch(mepId, { steps, commitStride, runs })` runs each `{ stimulusSeed, stimulusIds?, silenceIds? }` as
  an ordinary committed run and keeps its seed, its `state_0` root, its `execRoot`, and its counts digest (which is for
  the dataset; it is not consensus). Every run of a batch is, bit for bit, the run the single-task path produces. Only
  the last run's state stays in the slot, so a dispute finds the run first (`batchNode`) and then reopens it
  (`batchOpenRun(mepId, k)`: `openRun`'s arguments, and the run re-executed and checked against the root that was
  committed for it). From there the int-lif dispute helpers answer for that run, unchanged.
- `NodeService` serves `batch-announce`. Runs of a dataset share a handful of id sets, so an announcement may name them
  once (`sets`) and let a run say `stimulusSet` / `silenceSet`. As for a single task, the node executes what it was told,
  compares the root of the runs it built with the announced `initStateRoot`, and refuses to sign a batch whose runs are
  not the task's. The reply carries every run's `execRoot`, `state_0` root and counts digest: those are the dataset's
  rows, and `verifyRunResult` checks any one of them against the settled `execRoot`.
- Two fixes that the batch needed and the single task was missing. The relay's envelope whitelist did not know
  `result-refused`, so the refusal added with the silence set was dropped by every relay; and a requester waiting for a
  `result` ignored it and waited out its timeout. Both message types are whitelisted now, and a refusal rejects the
  request with its reason.

What a batch costs an executor is its runs, one after another: a batch is sized against the task timeout, not against gas.
## The weight unit is a parameter of the kind (2026-09)

int-lif adds `I × W_UNIT` to the synaptic conductance, `I` being a sum of synapse COUNTS. `W_UNIT` = 0.275 mV (18022 in
Q16) was set on FlyWire's counts. MaleCNS was reconstructed with another synapse detector: over 222,457 homologous
connections it reports 1.55 to 1.62 times as many synapses as FlyWire, and its neurons receive about twice the input.
Under FlyWire's unit every male stimulus ignites the network — 25 thermosensory neurons and 2,639 olfactory ones end in
the same 19,000-neuron state — so no readout says anything about the stimulus. Scaling the counts in the payload would
fix the dynamics and break everything that reads a weight as a count: the individual sampler is calibrated on counts,
and `min_syn` is a count.

So the unit moves to where it already formally was: inside the kind digest. `execKind = keccak(KIND_ID, …, W_UNIT, …)`;
another unit is another digest — the same rule, the same `KIND_ID` string, another kind, and therefore another MEP for
the same bytes. What changed is that the implementations take it as a parameter instead of a constant:

- `lif_wasm.c`: the three step functions take `w_unit` as their LAST argument and 0 means the default, which is also what
  a caller that does not pass it gets. No existing call site changes; `test_lif_wunit.mjs` checks that passing nothing,
  0 or 18022 is one run. `lif.js: transition(…, wUnitQ16)`, `lifExecKind(wUnitQ16)`; `int_lif.py: run(…, w_unit)`.
  The node takes `wUnitQ16` at `loadModel` and derives the MEP's kind from it.
- On chain the rule needs the unit and only has the digest, so `MEPRegistry.declareLifKind(wUnit)` records
  `lifWeightUnit[digest] = wUnit`. Anybody may declare one and the digest is computed there, so a declaration can only
  say something true; FlyWire's unit is declared at construction. `TaskMarket` asks `lifWeightUnit(kind) != 0` where it
  compared against one compiled-in digest, and `ExecutionDisputes` reads the unit at `openDispute` and passes it to
  `LifRowCheck.transition`. A second connectome is tasked and disputed by the same contracts.

`ExecutionDisputes` went over EIP-170 again with this (by 110 bytes). It is now 1,033 under: the two term proofs
(`proveSynapseTerm`, `proveSynapseTermLif`) repeated the same openings — the synapse root, the row's bounds, the chunk,
the record at k* — and share them now (`_rowLen`, `_recordAt`). Revert reasons and behaviour are unchanged.

Not decided here: WHICH unit the male brain gets. That is a calibration (what makes the male brain's response to a
stimulus comparable to the female's), and it belongs with the data, not in the protocol.
