# aigg-porw-core

Chain-neutral reference proof mathematics for the research-only
`aigg:porw:sketch-tile:v2` scheme.

This package was renamed from the imported `subspace-proof-of-residency`
baseline. Its default feature is `std`; SCALE support is an opt-in `scale`
adapter feature. The package rename and feature extraction do not change the
SCALE field bytes of the v2 data structures. Package-qualified `TypeInfo` paths
may differ because the Rust package name changed.

Repository-only vector and spec-lock checks live in the unpublished
`aigg-porw-conformance-runner` workspace package. This crate's tests are
self-contained, including when every published feature is enabled.

The linear `u32` sketch is an algebraic consistency check, not a
collision-resistant commitment or proof of byte equality, residency, or
inference execution. Cryptographic Merkle openings authenticate sampled bytes
against a commitment, subject to deployment admission and challenge
assumptions. Identity, signatures, deadlines, consensus, and economic effects
remain deployment adapters.

License: 0BSD. See `LICENSE-0BSD`.
