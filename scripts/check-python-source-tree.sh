#!/usr/bin/env bash
# Enforce the documented explicit PoRW AST binding invariant.
set -euo pipefail

PORW_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PORW_REPO_ROOT="$(cd -- "$PORW_SCRIPT_DIR/.." && pwd -P)"
PORW_SOURCE_ROOT="${1:-$PORW_REPO_ROOT}"
PORW_DEFAULT_PYTHON="$PORW_REPO_ROOT/packages/python/.venv/bin/python"
if [[ ! -x "$PORW_DEFAULT_PYTHON" ]]; then
  PORW_DEFAULT_PYTHON=python3
fi
PORW_PYTHON_BIN="${PORW_SOURCE_TREE_PYTHON:-$PORW_DEFAULT_PYTHON}"
PORW_CHECKER_PATH="$PORW_SCRIPT_DIR/check_python_source_tree.py"
if [[ ! -f "$PORW_CHECKER_PATH" || -L "$PORW_CHECKER_PATH" ]]; then
  echo "python source-tree gate: checker must be a regular non-symlink file: $PORW_CHECKER_PATH" >&2
  exit 1
fi
PORW_CHECKER_REAL_DIR="$(cd -- "$(dirname -- "$PORW_CHECKER_PATH")" && pwd -P)"
PORW_CHECKER_REAL="$PORW_CHECKER_REAL_DIR/$(basename -- "$PORW_CHECKER_PATH")"

unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE
export PYTHONNOUSERSITE=1

exec "$PORW_PYTHON_BIN" -B -I "$PORW_CHECKER_REAL" \
  "$PORW_SOURCE_ROOT"
