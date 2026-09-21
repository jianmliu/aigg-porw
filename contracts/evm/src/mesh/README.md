# Mesh settlement contracts

Implementation of `DESIGN-cross-audit.md`: redundancy / cross-audit settlement for
browser fly-brain instances. Interfaces in `../interfaces/PorwMesh.sol`.

| contract | owns |
|---|---|
| `MEPRegistry` | append-only Model Execution Profiles (`mep_id` computed on-chain; immutable) |
| `InstanceRegistry` | bonds (native asset), exit delay, slashing (settlement contracts only), stake-weighted eligible votes |
| `PoRWClaimManager` | epoch beacon, `ecrecover`'d residency claims, opening challenges adjudicated by `PorwVerifierKeccak`, deposits, timeouts |
| `TaskMarket` | tasks (single and batched), executors drawn in constant time when the task is posted and fixed from then on, signed results, settlement on the execution root or a dispute, payout |
| `ExecutionDisputes` | interactive execution fraud proof: roots → children rounds → row → single synapse term; timeouts |

Wiring (see `test/Mesh.t.sol` `setUp`): deploy `PorwVerifierKeccak`, `MEPRegistry`,
`InstanceRegistry`, `PoRWClaimManager`, `TaskMarket`, `ExecutionDisputes`; then
`instances.setClaimManager(cm)`, `instances.setSlasher(disputes, true)`,
`market.setDisputes(disputes)`.

Fixtures for the tests come from real browser-node runs:
`web/porw-browser/export_fixtures.mjs test/fixtures/mesh.json 100 1 42` (epoch blocks,
epoch, prevrandao — the claim is signed over the contract's derived challenge). It writes
the JSON for humans and the **typed Solidity libraries** the tests use
(`test/fixtures/MeshFixtures.sol`, `BrowserClaimFixture.sol`), so no `vm.readFile` /
`fs_permissions` is needed and the release-pinned `foundry.toml` stays untouched.

Pilot simplifications, stated: the beacon is `keccak(prevrandao, blockNumber)` recorded
once per epoch (production: PoT randomness / VRF); rows up to `MAX_IN_DEGREE`
are posted whole (larger rows would need sum bisection); full-coverage claims only.

### Optional base enrolment

Fresh deployments may call `InstanceRegistry.setMEPRegistry(address(meps))` once,
by its owner, before the first bond. Without this configuration all enrolment and
claim lookup keeps its legacy per-MEP behavior. Configuration cannot be changed
later, so a task's append-only roster cannot drift to a different registry.

`MEPRegistry.registerDerivedMEP(profile, baseMepId)` requires an existing root
profile with matching scheme, execution kind, neuron count and synapse count.
This supports in-place weight mutations; compacted layouts are not supported.
The registry checks layout compatibility, not scientific lineage or token rights.
The derived ID is `keccak256(keccak256("aigg:mep:base:v1") || rawProfileId ||
baseMepId)` with packed bytes32 fields. `registerDerivedMEPWithTerms(profile,
baseMepId, beneficiary, royaltyBps)` wraps this ID with the existing royalty hash.
`baseOf` is immutable and returns zero for standalone profiles.

In configured mode, `enrollmentMep` resolves registered derived profiles to their
base. Bond enrolment, membership, roster length, weight cap, eligibility and
sortition all use that base. Hosts claim the base once; its valid residency claim
qualifies future compatible derived registrations, and its fraud invalidation
removes their standing together. Unknown profiles revert. Tasks, results,
royalties and execution disputes still bind the exact derived MEP, and posted
task executor rosters remain snapshots. Shared eligibility does not implement
model delivery: hosts still need the exact derived model before executing it.
