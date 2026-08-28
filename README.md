# AIGG PoRW

This private research repository contains chain-neutral Proof of Resident Weights
(PoRW) implementations and benchmarks.

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

- [`crates/porw-core`](crates/porw-core/) — proof mathematics, reference logic,
  and conformance vectors.
- [`gpu/triton`](gpu/triton/) — Triton GPU implementation and benchmarks.
- [`contracts/evm`](contracts/evm/) — EVM verifier, conformance tests, and gas
  benchmarks.

`contracts/evm/lib/forge-std` is an untouched historical source baseline retained
for extraction and content-identity verification. Its presence is not an
endorsement of an ongoing vendoring policy. Task 7 will replace it with
forge-std v1.10.0 pinned at commit
`8bbcf6e3f8f62f419e5429a0bd89331c85c37824`.

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

## Status and licensing

This repository is private research software. Its interfaces and implementation
structure are not yet stable or production commitments.

Imported source history, attribution, and existing license files are preserved.
Each imported component and vendored dependency remains under its existing terms;
this repository-level documentation does not relicense imported material.
