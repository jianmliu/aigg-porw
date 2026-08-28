# EVM PoRW transaction benchmark

`anvil-london.json` is receipt-backed evidence for one successful
`PorwVerifier.verifyTileFraudProof` transaction using the shared 4 KiB
benchmark fixture. It is classified `proof_math_only`: the transaction measures
only the current dispute-path proof math.

It deliberately excludes future integration costs for:

- solution authentication;
- epoch-root membership;
- immutable verifier-pin lookup;
- challenge opening, deadline enforcement, and finalization; and
- deployment-specific bond and consequence settlement.

Generate the evidence from the repository root with:

```sh
contracts/evm/scripts/run-anvil-benchmark.sh
```

From a clean committed checkout, verify the committed evidence with fresh real
receipts without modifying the worktree:

```sh
contracts/evm/scripts/run-anvil-benchmark.sh --check-committed
```

CI also preserves the actual fresh report after that comparison, rather than
uploading a second copy of the committed baseline:

```sh
fresh_report="$PWD/benchmarks/evm/generated/anvil-london-ci.json"
contracts/evm/scripts/run-anvil-benchmark.sh \
  --check-committed \
  --fresh-output "$fresh_report"
```

`--fresh-output` is valid only with `--check-committed`, requires an absolute,
previously unused non-symlink path under the ignored
`benchmarks/evm/generated/` tree, and never overwrites
`anvil-london.json`. The runner publishes the fresh JSON atomically only after
two fresh runs agree, measurement inputs remain unchanged, and the deterministic
fields match the committed baseline. A failed run or comparison publishes no
fresh artifact.

The runner checks the pinned Foundry build and Solidity settings, executes two
fresh local Anvil chains, compares every deterministic report field except the
transaction hashes and block timestamp, and atomically publishes evidence only
after both runs agree. It binds the report to the canonical conformance vector
and exact canonical Fraud calldata by SHA-256, and requires the deployed runtime
code to match both the pinned compiler artifact and committed bytecode hash. A
sorted source manifest binds every measurement-relevant source/config file and
the forge-std gitlink. The runner refuses relevant files that differ from the
Git index and checks them again before publication; intentional edits must be
reviewed and staged first. The manifest intentionally contains no commit ID:
only exact content hashes and the forge-std gitlink participate, so it remains
identical before and after the commit that contains it. Each run asks Anvil to
bind an OS-selected localhost port and verifies the child PID, chain ID, and
Anvil client identity before accepting RPC readiness.

The public Anvil development key used by the Forge script is never a production
secret and must never fund a real account.

Auto EVM supports both Istanbul and London. This benchmark intentionally pins
London so EIP-2028 calldata pricing is explicit: `21000 + 4 * zero bytes + 16 *
non-zero bytes`. Deployment examples must use the target network's current
chain ID and must never reuse the obsolete Chronos chain ID `8700`.

The committed measurement is not a complete protocol transaction and must not
be quoted as end-to-end challenge, settlement, or application gas.
