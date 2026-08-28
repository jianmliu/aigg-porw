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

The components were extracted with history preserved from source commit
`8d8569004c2322aabe26cd59c12bbfe7dc4de1a1`.

## Status and licensing

This repository is private research software. Its interfaces and implementation
structure are not yet stable or production commitments.

Imported source history, attribution, and existing license files are preserved.
Each imported component and vendored dependency remains under its existing terms;
this repository-level documentation does not relicense imported material.
