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

The runner checks the pinned Foundry build and Solidity settings, executes two
fresh local Anvil chains, compares every deterministic report field except the
transaction hashes and block timestamp, and atomically publishes evidence only
after both runs agree. It binds the report to the canonical conformance vector
by SHA-256 and requires the deployed runtime code to match the pinned compiler
artifact byte for byte. The public Anvil development key used by the Forge
script is never a production secret and must never fund a real account.

Auto EVM supports both Istanbul and London. This benchmark intentionally pins
London so EIP-2028 calldata pricing is explicit: `21000 + 4 * zero bytes + 16 *
non-zero bytes`. Deployment examples must use the target network's current
chain ID and must never reuse the obsolete Chronos chain ID `8700`.

The committed measurement is not a complete protocol transaction and must not
be quoted as end-to-end challenge, settlement, or application gas.
