# Pytest Kernel Isolation Design

**Status:** Proposed

**Date:** 2026-08-28

## Problem

`gpu/triton/tests/test_kernel_validation.py` imports `porw_sketch.kernels`
against a minimal fake Triton module so host-side validation can run where
Triton is unavailable. Pytest restores `sys.modules` after the fixture, but
Python retains the imported submodule on the `porw_sketch` package object.
Later native-GPU tests can therefore receive plain Python functions instead of
Triton `JITFunction` objects. Their `kernel[grid](...)` launches fail with
`TypeError: 'function' object is not subscriptable`.

The failure is order-dependent: the native suite passes in isolation, while the
combined suite fails when the stub-based validation tests run first.

## Decision

Load the stub-backed copy of `kernels.py` under the private module name
`porw_sketch._kernels_validation_stub`. Do not import, register, replace, or
attach the stub as canonical `porw_sketch.kernels`.

The fixture will use `importlib.util.spec_from_file_location` to execute the
existing source file with:

- `__package__` set by its package-qualified private module name, so relative
  imports continue to resolve normally;
- fake `triton` and `triton.language` entries scoped by `monkeypatch`; and
- the private module entry scoped by `monkeypatch` for dataclass and import
  compatibility.

This preserves one source of wrapper behavior while isolating the environment
substitution used by host-validation tests.

## Regression Test

Add a test that consumes the stub fixture and asserts:

1. the loaded module is named `porw_sketch._kernels_validation_stub`;
2. it is not registered as `sys.modules["porw_sketch.kernels"]`; and
3. it is not attached to the `porw_sketch` package as the canonical `kernels`
   attribute.

The test must fail against the current fixture before the implementation is
changed. Existing host-wrapper tests remain unchanged and continue exercising
the isolated module.

## Boundaries

This change does not modify:

- Triton kernel code or arithmetic;
- PoRW scheme semantics or conformance vectors;
- benchmark configurations or measurement scope;
- dependency versions; or
- interpreter/native backend selection in `test_sketch.py`.

Changing test order or merely splitting the benchmark runner into multiple
pytest processes is explicitly out of scope because it would leave the full
suite order-dependent.

## Verification

Verification proceeds in four gates:

1. Run the new regression test before implementation and observe the expected
   isolation failure.
2. Run `test_kernel_validation.py` and confirm all host-validation cases pass.
3. Run the complete named Triton suite in one pytest process and confirm zero
   failures, errors, or skips on the supported A100 environment.
4. Run `gpu/triton/run_gpu_bench.sh` unchanged on an A100 and require a generated
   artifact with `status: success` and `exit_code: 0`.

The expected native result is that all 157 currently collected tests pass in
one process before the benchmark executes. Performance values are reported only
from the successful artifact; the isolation fix itself makes no performance
claim.

## Failure Handling

If the private module cannot be constructed, the fixture fails immediately
rather than falling back to canonical import state. If the combined A100 suite
still observes ordinary functions at a kernel launch boundary, the artifact is
failed and no benchmark values are accepted.

