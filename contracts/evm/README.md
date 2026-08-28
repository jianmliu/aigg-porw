# porw-evm-bench

EVM feasibility benchmarks for the PoRW `aigg:porw:sketch-tile:v2` dispute
path — the measured evidence behind `docs/porw-evm-feasibility.md` (the
feasibility gate of the AI3 Verifiable Compute Market Pilot proposal §8.4).

- `src/Blake3.sol` — full BLAKE3 (hash mode, chunk tree) in clarity-first
  Solidity.
- `src/PorwVerifier.sol` — exact port of the scheme's dispute math: sketch
  recomputation, blake3 Merkle commitments (+ keccak variant for
  comparison), fraud-proof / opening / non-inclusion verification.
- `src/bench/PoRWBenchFixture.sol` — deterministic 4 KiB fraud-proof input
  builder shared by the gas tests and broadcast script.
- `test/Conformance.t.sol` — differential tests against the Rust
  reference via `../../spec-cache/conformance/porw/`
  (bit-identical or it is not the same scheme).
- `test/OpeningBoundaries.t.sol` — committed, interior, and both boundary
  opening forms, including ordering and adjacency rejection.
- `test/NegativeCases.t.sol` — malformed proof, counted-tree, and context
  binding rejection cases.
- `test/Gas.t.sol` — the gas measurements at realistic tree depths.
- `script/AnvilBench.s.sol` and `scripts/run-anvil-benchmark.sh` — a real,
  receipt-backed London transaction benchmark with two-run reproducibility
  checking; see `../../benchmarks/evm/README.md` for its strict scope.

```
forge test --match-contract ConformanceTest
forge test --match-contract GasBench -vv
scripts/run-anvil-benchmark.sh
```

The build is pinned to Solidity 0.8.33, the London EVM, optimizer runs 200,
and IR compilation. `lib/forge-std` is a Git submodule pinned to forge-std
v1.10.0 commit `8bbcf6e3f8f62f419e5429a0bd89331c85c37824`.

The imported pre-migration measurements are historical only; see
`../../benchmarks/evm/historical/subspace-8d856900/`. They were captured from
an environment whose effective compiler/EVM settings did not match the report
label and therefore are not evidence for the pinned London build.

This project is intentionally outside the Cargo workspace.
