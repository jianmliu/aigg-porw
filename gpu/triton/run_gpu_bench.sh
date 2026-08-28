#!/usr/bin/env bash
# Run the PoRW Triton correctness suite and benchmark in this checkout only.
set -euo pipefail

PORW_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PORW_REPO_ROOT="$(cd -- "$PORW_SCRIPT_DIR/../.." && pwd -P)"
PORW_PYTHON_BIN="${PORW_PYTHON:-}"
PORW_OUTPUT_DIR="$PORW_REPO_ROOT/benchmarks/gpu/generated"
PORW_OUTPUT_FILE=""
PORW_TRITON_CACHE=""

porw_fail() {
  echo "error: $*" >&2
  exit 1
}

porw_verify_output_dir() {
  [[ ! -L "$PORW_OUTPUT_DIR" ]] || porw_fail \
    "benchmark output directory must not be a symlink: $PORW_OUTPUT_DIR"
  [[ ! -e "$PORW_OUTPUT_DIR" || -d "$PORW_OUTPUT_DIR" ]] || porw_fail \
    "benchmark output path is not a directory: $PORW_OUTPUT_DIR"

  PORW_OUTPUT_PARENT="$(cd -- "$(dirname -- "$PORW_OUTPUT_DIR")" && pwd -P)" \
    || porw_fail "cannot resolve benchmark output parent"
  case "$PORW_OUTPUT_PARENT/" in
    "$PORW_REPO_ROOT/"*) ;;
    *) porw_fail "benchmark output parent resolves outside the repository" ;;
  esac

  if [[ -d "$PORW_OUTPUT_DIR" ]]; then
    PORW_PHYSICAL_OUTPUT="$(cd -- "$PORW_OUTPUT_DIR" && pwd -P)" \
      || porw_fail "cannot resolve benchmark output directory"
    case "$PORW_PHYSICAL_OUTPUT/" in
      "$PORW_REPO_ROOT/"*) ;;
      *) porw_fail "benchmark output directory resolves outside the repository" ;;
    esac
  fi
}

porw_finish() {
  PORW_EXIT_CODE=$?
  trap - EXIT
  set +e
  if [[ -n "$PORW_OUTPUT_FILE" && -f "$PORW_OUTPUT_FILE" ]]; then
    if [[ "$PORW_EXIT_CODE" -eq 0 ]]; then
      PORW_TERMINAL_STATUS=success
    else
      PORW_TERMINAL_STATUS=failed
    fi
    {
      echo
      echo "=== terminal status ==="
      echo "status: $PORW_TERMINAL_STATUS"
      echo "exit_code: $PORW_EXIT_CODE"
    } >> "$PORW_OUTPUT_FILE"
  fi
  if [[ -n "$PORW_TRITON_CACHE" && -d "$PORW_TRITON_CACHE" ]]; then
    find "$PORW_TRITON_CACHE" -depth -delete
  fi
  exit "$PORW_EXIT_CODE"
}

trap porw_finish EXIT

[[ -n "$PORW_PYTHON_BIN" ]] || porw_fail \
  "set PORW_PYTHON to the explicit CPython 3.12.13 environment from gpu/triton/ENVIRONMENT.md"
[[ -x "$PORW_PYTHON_BIN" ]] || porw_fail \
  "PORW_PYTHON is not an executable file: $PORW_PYTHON_BIN"

PORW_GIT_ROOT="$(git -C "$PORW_REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" \
  || porw_fail "gpu/triton is not inside an aigg-porw Git checkout"
[[ "$(cd -- "$PORW_GIT_ROOT" && pwd -P)" == "$PORW_REPO_ROOT" ]] || porw_fail \
  "script path does not resolve to the current aigg-porw checkout root"

porw_verify_output_dir

PORW_DIRTY_STATUS="$(git -C "$PORW_REPO_ROOT" status --porcelain=v1 --untracked-files=normal)"
[[ -z "$PORW_DIRTY_STATUS" ]] || porw_fail \
  "refusing benchmark evidence from a dirty source worktree; commit or stash changes first"

[[ "${TRITON_INTERPRET:-0}" != "1" ]] || porw_fail \
  "native GPU benchmarks cannot run with TRITON_INTERPRET=1"
command -v nvidia-smi >/dev/null 2>&1 || porw_fail \
  "nvidia-smi is unavailable; no native NVIDIA GPU benchmark can run"
nvidia-smi -L >/dev/null 2>&1 || porw_fail \
  "nvidia-smi cannot see an NVIDIA GPU"

"$PORW_PYTHON_BIN" - <<'PY' || porw_fail \
  "PORW_PYTHON does not match the pinned native-GPU test environment"
import sys

if sys.version_info[:3] != (3, 12, 13):
    raise SystemExit(f"CPython 3.12.13 required, found {sys.version.split()[0]}")

try:
    import blake3
    import numpy
    import pytest
    import torch
    import triton
except ImportError as error:
    raise SystemExit(f"missing pinned dependency: {error}") from error

required = {
    "NumPy": (numpy.__version__, "2.0.2"),
    "pytest": (pytest.__version__, "8.4.2"),
    "BLAKE3": (blake3.__version__, "1.0.9"),
    "PyTorch": (torch.__version__.split("+")[0], "2.8.0"),
    "Triton": (triton.__version__, "3.4.0"),
}
for name, (actual, expected) in required.items():
    if actual != expected:
        raise SystemExit(f"{name} {expected} required, found {actual}")
if not torch.cuda.is_available():
    raise SystemExit("PyTorch reports CUDA unavailable")
if torch.version.cuda is None:
    raise SystemExit("PyTorch has no CUDA runtime")
print(f"preflight: Python {sys.version.split()[0]}, CUDA device {torch.cuda.get_device_name(0)}")
PY

PORW_COMMIT="$(git -C "$PORW_REPO_ROOT" rev-parse HEAD)"
PORW_UTC_STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$PORW_OUTPUT_DIR"
porw_verify_output_dir
PORW_OUTPUT_FILE="$(mktemp "$PORW_OUTPUT_DIR/gpu-bench-$PORW_UTC_STAMP-XXXXXXXX")"
PORW_TRITON_CACHE="$(mktemp -d "${TMPDIR:-/tmp}/aigg-porw-triton-cache.XXXXXXXX")"

export PYTHONDONTWRITEBYTECODE=1
export TRITON_CACHE_DIR="$PORW_TRITON_CACHE"
{
  echo "=== provenance ==="
  echo "repository: $PORW_REPO_ROOT"
  echo "commit: $PORW_COMMIT"
  echo "dirty: no"
  echo "utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "hostname: $(hostname)"

  echo
  echo "=== GPU ==="
  nvidia-smi --query-gpu=name,uuid,driver_version,memory.total,memory.free,clocks.max.memory,clocks.max.graphics,power.limit,power.default_limit --format=csv

  echo
  echo "=== software ==="
  "$PORW_PYTHON_BIN" - <<'PY'
import platform
import sys

import blake3
import numpy
import pytest
import torch
import triton

print("Python:", sys.version.replace("\n", " "))
print("platform:", platform.platform())
print("NumPy:", numpy.__version__)
print("pytest:", pytest.__version__)
print("BLAKE3:", blake3.__version__)
print("PyTorch:", torch.__version__)
print("Triton:", triton.__version__)
print("CUDA runtime (PyTorch):", torch.version.cuda)
print("cuDNN:", torch.backends.cudnn.version())
PY

  echo
  echo "=== benchmark parameters ==="
  echo "slot_seed: 1"
  echo "warmup_iterations_per_measurement: 10"
  echo "reported_samples_per_metric_per_configuration: 1 arithmetic mean"
  echo "config_1: E=8 N=1024 K=2048 M=4 top_k=2 timed_iterations=50"
  echo "config_2: E=8 N=1024 K=2048 M=64 top_k=2 timed_iterations=50"
  echo "config_3: E=64 N=512 K=2048 M=64 top_k=8 timed_iterations=50"
  echo "config_4: E=64 N=4096 K=2048 M=16 top_k=8 timed_iterations=20"

  echo
  echo "=== correctness (native GPU backend) ==="
  if "$PORW_PYTHON_BIN" -m pytest \
    "$PORW_SCRIPT_DIR/tests" -q -p no:cacheprovider; then
    echo "correctness_result: passed"
  else
    echo "correctness_result: failed"
    exit 1
  fi

  echo
  echo "=== benchmark output ==="
  "$PORW_PYTHON_BIN" "$PORW_SCRIPT_DIR/bench_gpu.py"
} 2>&1 | tee "$PORW_OUTPUT_FILE"

echo "wrote $PORW_OUTPUT_FILE"
