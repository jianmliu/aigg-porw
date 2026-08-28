# Triton PoRW test environment

## Pinned environment

The test environment uses CPython `3.12.13` and the direct dependencies pinned
in [`requirements-test.txt`](requirements-test.txt):

- NumPy `2.0.2`
- pytest `8.4.2`
- BLAKE3 `1.0.9`
- PyTorch `2.8.0`
- Triton `3.4.0` on Linux x86_64

Triton `3.4.0` is not an inferred compatibility choice: the published
`torch-2.8.0-cp312-cp312-manylinux_2_28_x86_64` wheel metadata requires exactly
`triton==3.4.0` on Linux x86_64.  The requirements marker omits Triton where
that wheel is unavailable, including Darwin arm64.

Create the repository-scoped environment on the current development host with:

```sh
PORW_MANAGED_PYTHON=/Users/jianmingliu/Projects/.aigg-tools/python/cpython-3.12.13-macos-aarch64-none/bin/python3.12
"$PORW_MANAGED_PYTHON" -m venv gpu/triton/.venv
gpu/triton/.venv/bin/python -m pip install -r gpu/triton/requirements-test.txt
```

Do not install these packages into the system Python.  On a Linux x86_64 GPU
host or CI runner, create the same scoped environment with CPython `3.12.13`;
the platform marker will install Triton `3.4.0` there.

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
`benchmarks/gpu/generated/`.  Interpreter results are correctness evidence
only and must never be reported as throughput measurements.
