#!/usr/bin/env bash
# Mutation-test the Python source-tree gate, then check this checkout.
set -euo pipefail

PORW_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PORW_REPO_ROOT="$(cd -- "$PORW_SCRIPT_DIR/.." && pwd -P)"
PORW_CHECKER="$PORW_SCRIPT_DIR/check-python-source-tree.sh"
PORW_DEFAULT_PYTHON="$PORW_REPO_ROOT/packages/python/.venv/bin/python"
if [[ ! -x "$PORW_DEFAULT_PYTHON" ]]; then
  PORW_DEFAULT_PYTHON=python3
fi
PORW_PYTHON_BIN="${PORW_SOURCE_TREE_PYTHON:-$PORW_DEFAULT_PYTHON}"

"$PORW_PYTHON_BIN" - "$PORW_CHECKER" <<'PY'
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

checker = Path(sys.argv[1]).resolve()


def fixture(root: Path, *, version: str = "0.2.0.dev1+research") -> None:
    package = root / "packages/python/src/aigg_porw"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("def fmix32(value):\n    return value\n")
    (root / "packages/python/pyproject.toml").write_text(
        "[project]\nname = 'aigg-porw'\n" f"version = '{version}'\n"
    )


def run(root: Path) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ, PORW_SOURCE_TREE_PYTHON=sys.executable)
    return subprocess.run(
        [str(checker), str(root)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )


with tempfile.TemporaryDirectory(prefix="aigg-porw-source-gate-") as temporary:
    base = Path(temporary)

    clean = base / "clean"
    fixture(clean)
    compatibility = clean / "gpu/triton/porw_sketch/spec.py"
    compatibility.parent.mkdir(parents=True)
    compatibility.write_text(
        "from aigg_porw.scheme import (\n"
        "    fmix32 as fmix32, tile_coeffs as tile_coeffs,\n"
        ")\n"
    )
    result = run(clean)
    if result.returncode != 0:
        raise SystemExit(f"clean compatibility re-export was rejected:\n{result.stderr}")

    missing = base / "missing"
    missing.mkdir()
    result = run(missing)
    if result.returncode == 0 or "checkout package is missing" not in result.stderr:
        raise SystemExit("missing canonical checkout did not fail closed")

    mismatch = base / "mismatch"
    fixture(mismatch, version="0.2.0.dev2+research")
    result = run(mismatch)
    if result.returncode == 0 or "version mismatch" not in result.stderr:
        raise SystemExit("canonical package version mismatch did not fail closed")

    mutations = {
        "formatted_fmix.py": "def _f_m_i_x_3_2(value):\n    return value\n",
        "async_merkle.py": "async def verify_counted_merkle(*args):\n    return True\n",
        "lambda_fraud.py": "verify_tile_fraud = lambda *args: True\n",
        "legacy_alias.py": "def _fraud_verdict(**kwargs):\n    return 'Fraud'\n",
        "commitment.py": "def _weights_leaf(index, tile):\n    return b''\n",
        "import_alias.py": (
            "from local_proof import verify_counted_merkle as disguised_check\n"
        ),
    }
    for index, (name, source) in enumerate(mutations.items()):
        mutated = base / f"mutation-{index}"
        fixture(mutated)
        candidate = mutated / "gpu/tests" / name
        candidate.parent.mkdir(parents=True)
        candidate.write_text(source)
        result = run(mutated)
        if result.returncode == 0 or "duplicate PoRW" not in result.stderr:
            raise SystemExit(f"mutation {name} escaped the source-tree gate")

print("python source-tree gate self-tests: passed")
PY

exec "$PORW_CHECKER" "$PORW_REPO_ROOT"
