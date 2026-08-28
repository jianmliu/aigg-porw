# Triton PoRW test environment

## Pinned environment

The test environment requires CPython `3.12.13` exactly; pytest rejects any
other patch release at startup.  Human-maintained direct constraints live in
[`requirements-test.in`](requirements-test.in):

- NumPy `2.0.2`
- pytest `8.4.2`
- BLAKE3 `1.0.9`
- PyTorch `2.8.0`
- Triton `3.4.0` on Linux x86_64

Installations use the platform-specific, fully transitive hash locks:

- [`requirements-test-darwin-arm64.lock`](requirements-test-darwin-arm64.lock)
- [`requirements-test-linux-x86_64.lock`](requirements-test-linux-x86_64.lock)

Every package is pinned and every accepted distribution has a hash. Triton
`3.4.0` is not an inferred compatibility choice: the published
`torch-2.8.0-cp312-cp312-manylinux_2_28_x86_64` wheel metadata requires exactly
`triton==3.4.0` on Linux x86_64. The Darwin arm64 lock omits Triton because no
compatible distribution is published for that platform; the Linux x86_64
lock includes it exactly.

Create the repository-scoped environment on the current development host with:

```sh
PORW_MANAGED_PYTHON=/Users/jianmingliu/Projects/.aigg-tools/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12
"$PORW_MANAGED_PYTHON" -m venv gpu/triton/.venv
gpu/triton/.venv/bin/python -m pip install --require-hashes \
  -r gpu/triton/requirements-test-darwin-arm64.lock
```

Do not install these packages into the system Python.  On a Linux x86_64 GPU
host or CI runner, create the same scoped environment with CPython `3.12.13`
and install with:

```sh
gpu/triton/.venv/bin/python -m pip install --require-hashes \
  -r gpu/triton/requirements-test-linux-x86_64.lock
```

Regenerate locks from `requirements-test.in` with
`uv pip compile --generate-hashes` for the named target platform. Do not
install from the `.in` file in verification or CI.

## Verified current host

The scoped environment was verified on macOS `26.5.2` (`25F84`), arm64:

```text
Python 3.12.13
NumPy 2.0.2
pytest 8.4.2
BLAKE3 1.0.9
PyTorch 2.8.0
torch.cuda.is_available() = False
torch.version.cuda = None
Triton = unavailable (no Darwin arm64 installation)
```

The pure NumPy sketch tests and the independent canonical-vector tests run on
this host.  Native CUDA tests are skipped without `TRITON_INTERPRET=1`.  With
`TRITON_INTERPRET=1`, the kernel tests select CPU tensors, but this host still
skips them because Triton cannot be installed.  This is environment-limited;
it is not a passing interpreter result.  Task 9 Linux x86_64 CI must run the
interpreter suite successfully before a research release.

## Commands

From the repository root:

```sh
# Pure CPU and canonical conformance plus correctly gated kernel tests
gpu/triton/.venv/bin/python -m pytest gpu/triton/tests -q -rs

# Mandatory interpreter command (environment-limited on Darwin arm64)
TRITON_INTERPRET=1 gpu/triton/.venv/bin/python -m pytest gpu/triton/tests/test_sketch.py -q -rs

# Native GPU correctness and benchmark; refuses implicit environments
PORW_PYTHON="$PWD/gpu/triton/.venv/bin/python" gpu/triton/run_gpu_bench.sh
```

The benchmark runner records new outputs only under
`benchmarks/gpu/generated/`, which is ignored by Git. It refuses a dirty source
worktree before creating an artifact or cache, uses an isolated temporary
Triton cache, and appends a terminal `success`/`failed` status plus exit code to
every artifact it creates. A failure after evidence collection starts leaves
the ignored partial artifact for diagnosis. Interpreter results are correctness
evidence only and must never be reported as throughput measurements.
