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
    (package / "scheme.py").write_text(
        "def fmix32(value):\n    return value\n"
        "def tile_coeffs(seed, index):\n    return (seed, index)\n"
    )
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
        "class_merkle.py": "class VerifyCountedMerkle:\n    pass\n",
        "lambda_fraud.py": "verify_tile_fraud = lambda *args: True\n",
        "legacy_alias.py": "def _fraud_verdict(**kwargs):\n    return 'Fraud'\n",
        "commitment.py": "def _weights_leaf(index, tile):\n    return b''\n",
        "import_alias.py": (
            "from local_proof import verify_counted_merkle as disguised_check\n"
        ),
        "relative_canonical.py": "from .aigg_porw import fmix32\n",
        "unresolved_canonical.py": (
            "from aigg_porw.shadow import verify_tile_fraud\n"
        ),
        "rebound_alias.py": (
            "from aigg_porw import verify_tile_fraud\n"
            "disguised_check = verify_tile_fraud\n"
        ),
        "annotated_callable.py": "weights_leaf: object = lambda *args: b''\n",
        "factory_callable.py": "weights_leaf = make_verifier()\n",
        "closure_alias.py": (
            "from aigg_porw import verify_tile_fraud\n"
            "disguised_check = lambda *args: verify_tile_fraud(*args)\n"
        ),
        "container_alias.py": (
            "from aigg_porw import verify_tile_fraud\n"
            "disguised_checks = (verify_tile_fraud,)\n"
        ),
        "globals_write.py": "globals()['verify_tile_fraud'] = lambda *args: True\n",
        "locals_write.py": "locals()['weights_leaf'] = lambda *args: b''\n",
        "attribute_write.py": "registry.verify_tile_fraud = lambda *args: True\n",
        "decorator_registry.py": (
            "@registry('verify_tile_fraud')\n"
            "def disguised_check(*args):\n"
            "    return True\n"
        ),
        "literal_registry.py": (
            "def fake(*args):\n"
            "    return True\n"
            "REGISTRY = {'verify_tile_fraud': fake}\n"
        ),
        "call_registry.py": (
            "def fake(*args):\n"
            "    return True\n"
            "registry.register('verify_tile_fraud', fake)\n"
        ),
        "dynamic_exec.py": "exec(compile(source, '<dynamic>', 'exec'))\n",
        "dynamic_eval.py": "value = eval(source)\n",
        "dynamic_compile.py": "code = compile(source, '<dynamic>', 'exec')\n",
    }
    for index, (name, source) in enumerate(mutations.items()):
        mutated = base / f"mutation-{index}"
        fixture(mutated)
        governed_directory = (
            "gpu/triton/tests" if name.startswith("dynamic_") else "gpu/tests"
        )
        candidate = mutated / governed_directory / name
        candidate.parent.mkdir(parents=True)
        candidate.write_text(source)
        result = run(mutated)
        if result.returncode == 0 or "binding invariant violated" not in result.stderr:
            raise SystemExit(f"mutation {name} escaped the source-tree gate")

    harmless = base / "harmless-literal"
    fixture(harmless)
    harmless_candidate = harmless / "gpu/tests/fixture.py"
    harmless_candidate.parent.mkdir(parents=True)
    harmless_candidate.write_text("weights_leaf: str = 'locked-vector fixture'\n")
    result = run(harmless)
    if result.returncode != 0:
        raise SystemExit(f"harmless literal fixture was rejected:\n{result.stderr}")

    symlinked = base / "symlinked-package"
    fixture(symlinked)
    real_init = symlinked / "real-init.py"
    real_init.write_text("def fmix32(value):\n    return value\n")
    package_init = symlinked / "packages/python/src/aigg_porw/__init__.py"
    package_init.unlink()
    package_init.symlink_to(real_init)
    result = run(symlinked)
    if result.returncode == 0 or "symlink" not in result.stderr:
        raise SystemExit("symlinked canonical package source did not fail closed")

    symlinked_directory = base / "symlinked-directory"
    external_package = base / "external-package"
    fixture(symlinked_directory)
    shutil_source = symlinked_directory / "packages/python/src/aigg_porw"
    external_package.mkdir()
    (external_package / "__init__.py").write_text(
        "def fmix32(value):\n    return value\n"
    )
    for child in shutil_source.iterdir():
        child.unlink()
    shutil_source.rmdir()
    shutil_source.symlink_to(external_package, target_is_directory=True)
    result = run(symlinked_directory)
    if result.returncode == 0 or "symlink" not in result.stderr:
        raise SystemExit("symlinked canonical package directory did not fail closed")

print("python source-tree gate self-tests: passed")
PY

exec "$PORW_CHECKER" "$PORW_REPO_ROOT"
