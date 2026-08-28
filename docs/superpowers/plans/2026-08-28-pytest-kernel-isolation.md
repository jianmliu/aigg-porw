# Pytest Kernel Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent fake-Triton host-validation tests from contaminating the canonical `porw_sketch.kernels` import, so the complete Triton test suite and unchanged GPU benchmark runner pass in one process on an A100.

**Architecture:** Execute `gpu/triton/porw_sketch/kernels.py` for host-only validation under the private module name `porw_sketch._kernels_validation_stub`. Keep fake Triton and the private module scoped to pytest's `monkeypatch`, while leaving `porw_sketch.kernels` untouched for native or interpreter tests.

**Tech Stack:** CPython 3.12.13, pytest 8.4.2, PyTorch 2.8.0, Triton 3.4.0, NVIDIA A100.

---

### Task 1: Add the isolation regression test

**Files:**
- Modify: `gpu/triton/tests/test_kernel_validation.py`
- Test: `gpu/triton/tests/test_kernel_validation.py`

- [ ] **Step 1: Define the private module name beside the existing test constants**

Add immediately after `KERNELS_PATH`:

```python
STUB_MODULE_NAME = "porw_sketch._kernels_validation_stub"
```

- [ ] **Step 2: Write the failing regression test**

Add immediately after the `kernel_module` fixture:

```python
def test_kernel_module_stub_does_not_replace_canonical_import(kernel_module):
    import porw_sketch

    assert kernel_module.__name__ == STUB_MODULE_NAME
    assert sys.modules.get("porw_sketch.kernels") is not kernel_module
    assert getattr(porw_sketch, "kernels", None) is not kernel_module
```

- [ ] **Step 3: Run the regression test and verify RED**

Run:

```bash
gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_kernel_validation.py::test_kernel_module_stub_does_not_replace_canonical_import \
  -q -p no:cacheprovider
```

Expected: FAIL because the current fixture returns a module named
`porw_sketch.kernels`, not `porw_sketch._kernels_validation_stub`.

### Task 2: Load the fake-Triton copy under an isolated module name

**Files:**
- Modify: `gpu/triton/tests/test_kernel_validation.py:4-49`
- Test: `gpu/triton/tests/test_kernel_validation.py`

- [ ] **Step 1: Replace the general importlib import with its utility module**

Replace:

```python
import importlib
```

with:

```python
import importlib.util
```

- [ ] **Step 2: Replace the `kernel_module` fixture with private module loading**

Use this exact fixture:

```python
@pytest.fixture
def kernel_module(monkeypatch):
    """Load host wrappers with fake Triton without touching canonical imports."""
    fake_language = ModuleType("triton.language")
    fake_language.constexpr = object()
    fake_triton = ModuleType("triton")
    fake_triton.jit = lambda function: function
    fake_triton.cdiv = lambda value, divisor: (value + divisor - 1) // divisor
    fake_triton.language = fake_language
    monkeypatch.setitem(sys.modules, "triton", fake_triton)
    monkeypatch.setitem(sys.modules, "triton.language", fake_language)

    module_spec = importlib.util.spec_from_file_location(
        STUB_MODULE_NAME,
        KERNELS_PATH,
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"cannot load isolated kernel module from {KERNELS_PATH}")
    module = importlib.util.module_from_spec(module_spec)
    monkeypatch.setitem(sys.modules, STUB_MODULE_NAME, module)
    module_spec.loader.exec_module(module)
    return module
```

Do not add any fallback to `importlib.import_module("porw_sketch.kernels")`.

- [ ] **Step 3: Run the new test and verify GREEN**

Run:

```bash
gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_kernel_validation.py::test_kernel_module_stub_does_not_replace_canonical_import \
  -q -p no:cacheprovider
```

Expected: `1 passed`.

- [ ] **Step 4: Run the complete host-validation file**

Run:

```bash
gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_kernel_validation.py \
  -q -p no:cacheprovider -rs
```

Expected: all tests pass with zero failures and errors.

- [ ] **Step 5: Check formatting and source cleanliness**

Run:

```bash
git diff --check
git status --short
```

Expected: only `gpu/triton/tests/test_kernel_validation.py` is modified in
addition to already committed design and plan documents; `git diff --check`
prints nothing.

### Task 3: Verify order independence in one pytest process

**Files:**
- Test: `gpu/triton/tests/test_sketch.py`
- Test: `gpu/triton/tests/test_conformance.py`
- Test: `gpu/triton/tests/test_kernel_validation.py`
- Test: `gpu/triton/tests/test_benchmark_honesty.py`

- [ ] **Step 1: Run the suite in the original failing order**

On the pinned Linux x86_64 A100 environment, run:

```bash
CUDA_VISIBLE_DEVICES=1 gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_conformance.py \
  gpu/triton/tests/test_kernel_validation.py \
  gpu/triton/tests/test_benchmark_honesty.py \
  gpu/triton/tests/test_sketch.py \
  -q -p no:cacheprovider -rs
```

Expected: all 158 tests pass in one process with zero failures, errors, or
skips. The count is the previous 157 tests plus the new regression test.

- [ ] **Step 2: Run the same files in reverse order**

Run:

```bash
CUDA_VISIBLE_DEVICES=1 gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_sketch.py \
  gpu/triton/tests/test_benchmark_honesty.py \
  gpu/triton/tests/test_kernel_validation.py \
  gpu/triton/tests/test_conformance.py \
  -q -p no:cacheprovider -rs
```

Expected: all 158 tests pass again. This proves the fix does not depend on
collection order or on native `porw_sketch.kernels` having been imported first.

### Task 4: Run the unchanged A100 evidence pipeline

**Files:**
- Verify: `gpu/triton/run_gpu_bench.sh`
- Generated evidence: `benchmarks/gpu/generated/gpu-bench-*` (ignored by Git)

- [ ] **Step 1: Confirm the source worktree is clean**

Commit the isolation change before running the evidence script:

```bash
git add gpu/triton/tests/test_kernel_validation.py
git commit -m "test: isolate fake Triton kernel module"
git status --porcelain=v1
```

Expected: commit succeeds and `git status --porcelain=v1` prints nothing.

- [ ] **Step 2: Run the benchmark runner without changing its test command**

On the A100 checkout, run:

```bash
CUDA_VISIBLE_DEVICES=1 \
PORW_PYTHON="$PWD/gpu/triton/.venv/bin/python" \
gpu/triton/run_gpu_bench.sh
```

Expected:

- preflight identifies CPython 3.12.13 and an A100;
- the combined correctness suite reports 158 passed with zero failures,
  errors, or skips;
- all four benchmark configurations complete; and
- the generated artifact ends with:

```text
=== terminal status ===
status: success
exit_code: 0
```

- [ ] **Step 3: Verify the generated artifact and repository state**

Run:

```bash
RESULT_FILE=$(ls -1t benchmarks/gpu/generated/gpu-bench-* | head -1)
tail -5 "$RESULT_FILE"
git status --porcelain=v1
```

Expected: the artifact has terminal `success`, and the repository remains clean
because generated evidence is ignored.

### Task 5: Review the completed change

**Files:**
- Review: `gpu/triton/tests/test_kernel_validation.py`
- Review: `docs/superpowers/specs/2026-08-28-pytest-kernel-isolation-design.md`

- [ ] **Step 1: Record the review range**

Run:

```bash
BASE_SHA=de4db4480cc6d80e594dea07974d712b4d8a7cec
HEAD_SHA=$(git rev-parse HEAD)
git diff --stat "$BASE_SHA..$HEAD_SHA"
git diff --check "$BASE_SHA..$HEAD_SHA"
```

Expected: the diff contains only the approved documentation and pytest
isolation change; `git diff --check` prints nothing.

- [ ] **Step 2: Request code review**

Provide the reviewer with:

```text
Description: Isolate fake-Triton host validation from canonical kernel imports.
Requirements: 2026-08-28-pytest-kernel-isolation-design.md
Base: de4db4480cc6d80e594dea07974d712b4d8a7cec
Head: the current branch HEAD
```

Resolve every Critical or Important finding, then rerun Tasks 3 and 4 before
reporting completion.
