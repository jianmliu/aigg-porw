# BNB Chain deployment design

Status: design + reference contracts; not deployed. Numbers marked *assumed* are inputs to
the cost model, not measurements; measured gas comes from `aigg-porw` (`benchmarks/evm/`,
`contracts/evm/DESIGN-cross-audit.md` §5b/§5c).

## 1. What is BNB-specific and what is not

| layer | neutral (aigg-porw) | BNB deployment (this repo) |
|---|---|---|
| model bytes | `FLYBRAINv2` payload, `model_id` = keccak weights root, MEP registry | **Greenfield** object as `weightsDA`; download + verify before load |
| bond / rewards | `InstanceRegistry` in the native asset; per-epoch budgets | bond, deposits, slash and fees in **BNB**; parameter table §4 |
| settlement | claims, opening challenges, tasks, disputes (EIP-712, session keys) | **opBNB** (default) or BSC; deployment script + addresses |
| randomness | `PoRWClaimManager` takes an `IBeacon` (prevrandao fallback for the pilot) | **`CommitRevealBeacon`** among bonded instances (§3); VRF adapter as an alternative |
| transport | relays + signed envelopes; `RelayRegistry` | relays bonded in BNB; suggested operators |
| wallets | EIP-712 `Claim`/`Result`/`Delegation` | MetaMask / Binance Wallet / WalletConnect via `eth_signTypedData_v4`; chain ids 56 / 204 (mainnets), 97 / 5611 (testnets) |

## 2. Greenfield as the model store

- A released brain is one Greenfield object (public read) plus a manifest object
  (`*.manifest.json` from `flywire_export.py`: neuron/synapse counts, sha256, sources).
- `MEP.weightsDA = "gnfd://<bucket>/<object>"` (UTF-8 bytes; `GreenfieldDA.sol` validates the
  form). Anyone can fetch the object from any storage provider (SP) that serves the bucket.
- **Integrity is `model_id`, not the SP.** `js/greenfield.js` streams the object, recomputes
  the keccak weights leaves and root, and refuses to load a payload whose root differs from
  the MEP's `model_id`. A malicious or stale SP therefore can only deny service.
- Publication convention carries over: synapse records sorted by post neuron (the node's
  parallel path depends on it).
- Cost: a 28 MB object; Greenfield charges storage per size and read quota per bucket —
  publishers set a read quota large enough for instance bootstraps (each instance downloads
  once; 1,000 instances ≈ 28 GB of egress per release).

## 3. Epoch beacon on a PoSA chain

`block.prevrandao` on BSC / opBNB is the PoSA "difficulty" (a small constant), so the pilot
beacon `keccak(prevrandao ‖ blockNumber)` is predictable and partly grindable by the block
producer. The claim manager here takes an `IBeacon`:

- **`CommitRevealBeacon`** (`contracts/src/CommitRevealBeacon.sol`): bonded participants
  (instances or relays) commit `keccak(secret ‖ sender)` during the first `COMMIT_BLOCKS` of an
  epoch and reveal during the next `REVEAL_BLOCKS`; `beaconFor(e) = keccak(all revealed
  secrets ‖ e)` once the reveal window closes; a committer who does not reveal is slashed
  (its deposit goes to the pool) and its commitment is excluded. With ≥ 1 honest revealer the
  beacon is unpredictable to everyone before the reveal window; the last revealer can bias by
  withholding at the cost of its deposit (standard RANDAO trade-off, bounded by the deposit).
- **VRF**: where a VRF service is available on the target chain, an adapter contract that
  implements `IBeacon` from the VRF response is the stronger option; it is not included here
  to avoid a vendor dependency in the reference.
- The beacon is fixed before the epoch's claims are accepted (the claim manager only rolls an
  epoch whose beacon is ready), so no claimant can influence its own challenge or auditors.

## 4. Parameters (proposed; all constructor arguments)

| parameter | proposal | rationale |
|---|---|---|
| chain | opBNB (chain id 204; testnet 5611) | sub-second blocks, ~100M gas/block, cents per dispute round; BSC as fallback for liquidity |
| `EPOCH_BLOCKS` | ≈ 10 minutes of blocks | one claim per (instance, MEP, epoch); browser slots are ~1–2 s, epochs are minutes |
| `UNIT` (bond per sortition vote) | 0.05 BNB | Sybil cost per vote; `MAX_WEIGHT` = 16 keeps whales at 16 votes |
| `SLASH_AMOUNT` | 0.5 BNB | 10 votes' worth; exceeds any single task fee |
| `OPENING_DEPOSIT` | 0.01 BNB | false challenges cost something; an honest response wins the deposit |
| `OPENING_WINDOW` | ≈ 2 minutes of blocks | an instance behind a censoring relay must be able to answer on-chain itself |
| `ROUND_BLOCKS` (dispute) | ≈ 5 minutes of blocks | wallet / session key latency + one tree bisection round |
| `TASK_TIMEOUT` | ≈ 10 minutes of blocks | replaces stragglers by the next sortition index |
| `RelayRegistry` bond | 1 BNB | operator identity; ≥ 2 relays per instance |
| beacon `COMMIT/REVEAL_BLOCKS` | ≈ 2 / 2 minutes; committer deposit 0.1 BNB | RANDAO-style, deposit-bounded bias |

## 5. Cost model (measured gas × assumed prices)

Measured in aigg-porw (anvil, keccak scheme): tile fraud proof ≈ 1.11M gas; `submitClaim`
≈ 240k; `respondOpening` ≈ 870k; SpMV dispute: `postChildren` 38–115k, `postRow` ≈ 176k,
`proveSynapseTerm` ≈ 290k; LIF dispute: `postStepRoots` ≈ 275k, `postChildren` ≈ 75k,
`postRowLif` ≈ 109k, `proveSynapseTermLif` ≈ 183k.

| action | gas | opBNB (*assumed* 0.001 gwei, BNB = $600) | BSC (*assumed* 1 gwei) |
|---|---|---|---|
| one residency claim per epoch | 240k | $0.00014 | $0.14 |
| respond to an on-chain opening challenge | 870k | $0.0005 | $0.52 |
| full LIF dispute (18 bisection rounds × 2 parties + rows + term) | ≈ 3.5M | $0.002 | $2.1 |
| 10,000 instances × 1 claim per 10-minute epoch | 2.4G gas / epoch | $1.4 / epoch | $1,440 / epoch |

Reading: on opBNB the honest path (one claim per instance per epoch) is negligible even at
10k instances; on BSC it is not, which is why claims should stay per-epoch (not per-slot)
and why the honest audit path is off-chain (relays) with on-chain escalation only.

## 6. Risks and limits specific to BNB

- **Beacon bias** is deposit-bounded, not eliminated (§3). A VRF adapter removes it.
- **SP availability**: Greenfield read quota exhaustion or an SP outage delays bootstraps;
  mirror the payload (any HTTP/IPFS copy verifies the same `model_id`).
- **Relay operators**: liveness only; the on-chain fallbacks remain (`respondOpening`,
  disputes as direct transactions), see aigg-porw design §4.
- Everything in aigg-porw's "honest limits" applies unchanged (no hardware root of trust;
  collusion of all executors of a task is caught only by independent re-execution).
