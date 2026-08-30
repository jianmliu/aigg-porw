# aigg-porw Python package

Private research implementation of the canonical AIGG Proof of Retained
Weights sketch-tile v2 mathematics. The package exposes the pure NumPy
reference scheme, counted-Merkle commitment checks, and context-bound
tile-fraud verification.

The sketch is an algebraic consistency check. It does not by itself prove byte
equality, model residency, inference execution, Worker eligibility, capacity,
or financial entitlement.

## Verification-result boundary

`PorwVerificationResult` is an ephemeral diagnostic value, not a credential,
receipt, attestation, or capability. It cannot be constructed, copied,
serialized, or deserialized through the public API. A consumer—including the
GCT demo—must accept authenticated `PorwContext` plus `TileFraudProof`, call
`verify_tile_fraud(context, proof)` locally, and use that returned value only
in the same in-process control flow. Results received from a caller, storage,
or a network must never be accepted or reconstructed.

These Python object restrictions prevent ordinary API misuse; they do not
protect against hostile code executing inside the same interpreter. Never
treat Python object identity, class membership, or a verification result as
cryptographic attestation. The verifier's result never creates financial
entitlement.

## Reproducible local build

Use Python 3.12 and the checked-in `uv.lock`. The dev extra includes the exact
Hatchling backend declared by `pyproject.toml`, allowing the repository build
to run from the locked environment without build isolation:

```sh
uv sync --frozen --extra dev
UV_OFFLINE=1 uv build --no-build-isolation
```

## Version mapping

The Python distribution uses the valid PEP 440 version
`0.2.0.dev1+research`. The intended corresponding Git tag is
`v0.2.0-research.1`; a Git tag is not created or published by this package
task.

## License status

See `LICENSE-NOTICE.md`. Neither this package metadata nor access to the
private repository creates a blanket license grant for repository-authored
material.
