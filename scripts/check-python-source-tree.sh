#!/usr/bin/env bash
# Enforce the documented single-canonical-implementation Python invariant.
set -euo pipefail

PORW_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PORW_REPO_ROOT="$(cd -- "$PORW_SCRIPT_DIR/.." && pwd -P)"
PORW_SOURCE_ROOT="${1:-$PORW_REPO_ROOT}"
PORW_DEFAULT_PYTHON="$PORW_REPO_ROOT/packages/python/.venv/bin/python"
if [[ ! -x "$PORW_DEFAULT_PYTHON" ]]; then
  PORW_DEFAULT_PYTHON=python3
fi
PORW_PYTHON_BIN="${PORW_SOURCE_TREE_PYTHON:-$PORW_DEFAULT_PYTHON}"

exec "$PORW_PYTHON_BIN" "$PORW_SCRIPT_DIR/check_python_source_tree.py" \
  "$PORW_SOURCE_ROOT"
