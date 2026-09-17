# Mesh settlement contracts

Implementation of `DESIGN-cross-audit.md`: redundancy / cross-audit settlement for
browser fly-brain instances. Interfaces in `../interfaces/PorwMesh.sol`.

| contract | owns |
|---|---|
| `MEPRegistry` | append-only Model Execution Profiles (`mep_id` computed on-chain; immutable) |
| `InstanceRegistry` | bonds (native asset), exit delay, slashing (settlement contracts only), stake-weighted eligible votes |
| `PoRWClaimManager` | epoch beacon, `ecrecover`'d residency claims, opening challenges adjudicated by `PorwVerifierKeccak`, deposits, timeouts |
| `TaskMarket` | tasks, index sortition of executors, signed results, unanimous settlement or dispute, payout |
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
once per epoch (production: PoT randomness / VRF); `eligibleVotes` and `executors`
iterate the instance list (bounded pilot populations); rows up to `MAX_IN_DEGREE`
are posted whole (larger rows would need sum bisection); full-coverage claims only.
