# AIGG PoRW

This private repository contains the next research release candidate for
chain-neutral Proof of Resident Weights (PoRW) implementations and benchmarks.
Its intended Git tag is `v0.2.0-research.1`; that tag is unpublished. It is
research software, not a production-capable reward or inference system.

The release is locked to scheme `aigg:porw:sketch-tile:v2`, private normative
spec tag `porw-sketch-tile-v2.0.0-private.4` at commit
`4e4a9390008948c1912be9a8eb0653ea1e03cd64`, canonical vector SHA-256
`fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7`, and
provenance SHA-256
`fbb301486fb47da28fbfdad96a062abb3ad88615e0e3a1044ff0e0dbd3d1fc50`.

## Repository boundary

This repository owns:

- chain-neutral proof mathematics and reference logic;
- GPU implementations and experiments;
- verifier and conformance adapters; and
- benchmarks for those implementations.

This repository does **not** own:

- inference-task execution proof;
- consensus selection;
- token custody;
- staking;
- reward allocation; or
- slashing policy.

Normative protocol ownership remains in the private `aigg-spec` repository at
[`porw-sketch-tile-v2.0.0-private.4`](https://github.com/jianmliu/aigg-spec/tree/porw-sketch-tile-v2.0.0-private.4).
This repository is implementation-oriented; where it conflicts with that tagged
specification, the specification is authoritative.

## Imported components

- [`crates/porw-core`](crates/porw-core/) — proof mathematics and reference
  logic. The read-only conformance cache is under [`spec-cache`](spec-cache/).
- [`packages/python`](packages/python/) — installable `aigg-porw` research
  package. Its PEP 440 distribution version is `0.2.0.dev1+research`, its
  NumPy dependency is `numpy>=2.0,<3`, and its intended unpublished Git tag is
  `v0.2.0-research.1`.
- [`gpu/triton`](gpu/triton/) — Triton GPU implementation and benchmarks.
- [`contracts/evm`](contracts/evm/) — EVM verifier, conformance tests, and gas
  benchmarks.

The root Rust workspace also contains the unpublished
`conformance/rust-runner`, which checks the cached canonical vector without
adding repository-only responsibilities to the public core crate.

`contracts/evm/lib/forge-std` is a Git submodule pinned to forge-std v1.10.0 at
commit `8bbcf6e3f8f62f419e5429a0bd89331c85c37824`. The imported mutable copy remains
recoverable from the preserved EVM split history but is not part of the active
tree.

## Extraction provenance

All components were extracted with history preserved from immutable source
baseline `8d8569004c2322aabe26cd59c12bbfe7dc4de1a1`.

| Source prefix | Target prefix | Immutable baseline | Split tip |
| --- | --- | --- | --- |
| `crates/subspace-proof-of-residency` | `crates/porw-core` | `8d8569004c2322aabe26cd59c12bbfe7dc4de1a1` | `f4caa5160a168a0a1c38d822df473bbec2bb638c` |
| `porw-poc` | `gpu/triton` | `8d8569004c2322aabe26cd59c12bbfe7dc4de1a1` | `46ba416dbbb60cc433ed97aeabe3749ab9badffe` |
| `porw-evm-bench` | `contracts/evm` | `8d8569004c2322aabe26cd59c12bbfe7dc4de1a1` | `b0586e5088f811ee3a4f4164092e4b25f67061cb` |

Query imported file history from each reachable split tip with paths relative to
the split root:

```sh
git log f4caa5160a168a0a1c38d822df473bbec2bb638c -- src/lib.rs
git log 46ba416dbbb60cc433ed97aeabe3749ab9badffe -- porw_sketch/spec.py
git log b0586e5088f811ee3a4f4164092e4b25f67061cb -- src/PorwVerifier.sol
```

Running `git log --follow` only against a relocated target path is insufficient:
Git records the prefix relocation as a subtree merge, not a file rename for
`--follow` to traverse. The split-tip commands above query the preserved history
directly.

## Reproducible gates

The local gates use the pinned Rust toolchain in `rust-toolchain.toml`, locked
Cargo dependencies, CPython 3.12.13 with a platform-specific hash lock, Solidity
0.8.33, London, optimizer 200, `via_ir`, Foundry 1.7.1, and forge-std v1.10.0.

```sh
(cd packages/python && uv sync --frozen --extra dev)
(cd packages/python && uv run --frozen ruff check .)
(cd packages/python && uv run --frozen ruff format --check .)
(cd packages/python && uv run --frozen mypy src tests scripts)
(cd packages/python && uv run --frozen pytest -q)
(cd packages/python && UV_OFFLINE=1 uv build --offline --no-build-isolation)
./scripts/test-python-source-tree.sh
./scripts/check-python-source-tree.sh

cargo test --workspace --locked
cargo test -p aigg-porw-core --locked
cargo test -p aigg-porw-core --features scale --locked
cargo check -p aigg-porw-core --no-default-features --locked

gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_sketch.py \
  gpu/triton/tests/test_conformance.py \
  gpu/triton/tests/test_kernel_validation.py \
  gpu/triton/tests/test_benchmark_honesty.py -q -rs

(cd contracts/evm && forge clean && forge test -vv)
contracts/evm/scripts/run-anvil-benchmark.sh --check-committed
```

On Darwin arm64, Triton is unavailable and the local Python run cannot satisfy
the mandatory interpreter gate; the current host-applicable run reports 11
Darwin skips, which are limitations rather than passing release evidence. The
release requires the Linux x86-64 CI run
with `TRITON_INTERPRET=1`, exact hash-locked dependencies, all named kernel tests
collected, and zero skips. CI also proves tests leave `spec-cache` unchanged and
fresh real-Anvil receipts have no unexplained deterministic drift from the
committed benchmark.

See [`RELEASE.md`](RELEASE.md) for the release procedure, [`SECURITY.md`](SECURITY.md)
for mandatory production gates, and [`compatibility.json`](compatibility.json)
for machine-readable status.

## Consumer compatibility

Subspace is `not_integrated`; commit
`8d8569004c2322aabe26cd59c12bbfe7dc4de1a1` is an extraction baseline, not a
passing consumer integration. `ai3-inference` is also `not_integrated`.
Production economics are disabled. No current test turns proof of resident
capacity into proof that a user inference request was executed.

## Verification-result meaning

`NO_FRAUD` is one challenge verdict. It is not proof of inference execution,
universal residency, Worker eligibility, capacity, economic entitlement, or
financial entitlement. A `PorwVerificationResult` is an ephemeral,
non-credential local diagnostic: consumers must verify authenticated context
and evidence locally and use the result only in that same in-process control
flow. A received, stored, or reconstructed result is not evidence.

## Status and licensing

This repository is private research software. Its interfaces and implementation
structure are not stable or production commitments. Production rewards,
custody, slashing, and eligibility effects are disabled.

Imported source history, attribution, and existing license files are preserved.
Each imported component and vendored dependency remains under its existing terms;
this repository-level documentation does not relicense imported material.
