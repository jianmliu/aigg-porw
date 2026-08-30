# aigg-porw Python package

Private research implementation of the canonical AIGG Proof of Retained
Weights sketch-tile v2 mathematics. The package currently exposes only the
pure NumPy reference scheme: its constants, Murmur3 finalizer, per-word tile
coefficients, and deterministic tile sketches.

The sketch is an algebraic consistency check. It does not by itself prove byte
equality, model residency, inference execution, Worker eligibility, capacity,
or financial entitlement.

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
