# Pinned London PoRW verifier benchmark

This benchmark was produced by `contracts/evm/test/Gas.t.sol` with the checked-in
Foundry configuration:

- Solidity: 0.8.33
- EVM: London
- optimizer: enabled, 200 runs
- IR pipeline: enabled
- forge-std: v1.10.0 at
  `8bbcf6e3f8f62f419e5429a0bd89331c85c37824`

The full-path case uses a 4 KiB tile, a depth-21 partials proof representing a
2,000,000-leaf coverage tree, and a depth-25 weights proof representing a
17,000,000-tile model tree. `abi.encodeCall` supplies the exact call payload.

| Metric | Result |
| --- | ---: |
| Calldata bytes | 6,084 |
| Zero calldata bytes | 347 |
| Non-zero calldata bytes | 5,737 |
| Intrinsic calldata gas (EIP-2028 byte costs) | 93,180 |
| In-process static-call execution gas | 8,263,594 |
| Estimated total (`21,000 + calldata + execution`) | 8,377,774 |
| `PorwVerifier` runtime size | 8,932 bytes |
| `PorwVerifier` initcode size | 8,959 bytes |
| EIP-170 runtime margin | 15,644 bytes |

The pre-migration Solidity 0.8.33/London build measured a 7,905-byte runtime.
The pinned verifier is 1,027 bytes larger (13.0%). The growth comes from the
security corrections required to match the canonical Rust v2 verifier:
count-aware duplicate-last Merkle validation, model-root/model-id binding,
authenticated model and coverage leaf counts, and explicit before-first and
after-last non-inclusion entry points. No payment, bond, deadline, reward, or
slashing logic was added.

The execution and total figures above are deterministic Foundry in-process
measurements, not transaction-receipt gas. The real Anvil transaction benchmark
is a separate follow-up gate; this report does not claim to replace it.
