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
import zipfile
import zipimport
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
    (package / "verification.py").write_text(
        "def verify_tile_fraud(*args):\n    return True\n"
    )
    (root / "packages/python/pyproject.toml").write_text(
        "[project]\nname = 'aigg-porw'\n" f"version = '{version}'\n"
    )


def run(
    root: Path,
    *,
    extra_environment: dict[str, str] | None = None,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ, PORW_SOURCE_TREE_PYTHON=sys.executable)
    if extra_environment is not None:
        environment.update(extra_environment)
    return subprocess.run(
        [str(checker), str(root)],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=cwd,
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

    archive_source = (
        "def verify_tile_fraud(*args):\n"
        "    return True\n"
    )
    for index, suffix in enumerate((".zip", ".WHL", ".Egg", ".pyZ")):
        archived = base / f"archive-{index}"
        fixture(archived)
        candidate = archived / f"gpu/triton/nested/protected{suffix}"
        candidate.parent.mkdir(parents=True)
        with zipfile.ZipFile(candidate, "w") as bundle:
            bundle.writestr("porw_attack.py", archive_source)
        if zipimport.zipimporter(str(candidate)).get_code("porw_attack") is None:
            raise SystemExit(f"archive fixture is not zipimport-able: {candidate}")
        result = run(archived)
        expected = f"gpu/triton/nested/protected{suffix}: executable Python archive"
        if result.returncode == 0 or expected not in result.stderr:
            raise SystemExit(f"governed archive {suffix} escaped the source-tree gate")

    archived_symlink = base / "archive-symlink"
    fixture(archived_symlink)
    archive_payload = archived_symlink / "payload.bin"
    with zipfile.ZipFile(archive_payload, "w") as bundle:
        bundle.writestr("porw_attack.py", archive_source)
    archive_link = archived_symlink / "gpu/triton/nested/protected.whl"
    archive_link.parent.mkdir(parents=True)
    archive_link.symlink_to(archive_payload)
    result = run(archived_symlink)
    if (
        result.returncode == 0
        or "gpu/triton/nested/protected.whl: executable Python archive" not in result.stderr
        or "symlink" not in result.stderr
    ):
        raise SystemExit("symlinked governed Python archive escaped the source-tree gate")

    governed_pth = base / "governed-pth"
    fixture(governed_pth)
    pth = governed_pth / "gpu/triton/nested/porw_attack.PTH"
    pth.parent.mkdir(parents=True)
    pth.write_text("import porw_attack\n")
    result = run(governed_pth)
    if result.returncode == 0 or "executable Python path file" not in result.stderr:
        raise SystemExit("governed .pth executable path file escaped the source-tree gate")

    build_archive = base / "build-archive"
    fixture(build_archive)
    candidate = build_archive / "gpu/triton/build/nested/protected.ZIP"
    candidate.parent.mkdir(parents=True)
    with zipfile.ZipFile(candidate, "w") as bundle:
        bundle.writestr("porw_attack.py", archive_source)
    if zipimport.zipimporter(str(candidate)).get_code("porw_attack") is None:
        raise SystemExit(f"build archive fixture is not zipimport-able: {candidate}")
    result = run(build_archive)
    if (
        result.returncode == 0
        or "gpu/triton/build/nested/protected.ZIP: executable Python archive"
        not in result.stderr
    ):
        raise SystemExit("build-nested executable archive escaped the pre-import gate")

    target_pth = base / "target-pth"
    fixture(target_pth)
    pth_directory = target_pth / "gpu/triton/target/dist"
    pth_directory.mkdir(parents=True)
    marker = target_pth / "pth-executed"
    pth = pth_directory / "porw_attack.pth"
    pth.write_text(
        "import pathlib; pathlib.Path(" + repr(str(marker)) + ").write_text('loaded')\n"
    )
    proof = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import site, sys; site.addsitedir(sys.argv[1])",
            str(pth_directory),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if proof.returncode != 0 or marker.read_text() != "loaded":
        raise SystemExit("target/dist .pth fixture did not prove executable")
    result = run(target_pth)
    if (
        result.returncode == 0
        or "gpu/triton/target/dist/porw_attack.pth: executable Python path file"
        not in result.stderr
    ):
        raise SystemExit("target/dist executable .pth escaped the pre-import gate")

    dependency_environment = base / "dependency-environment"
    fixture(dependency_environment)
    dependency_pth = dependency_environment / "gpu/triton/.venv/lib/distutils-precedence.pth"
    dependency_pth.parent.mkdir(parents=True)
    dependency_pth.write_text("import _distutils_hack\n")
    result = run(dependency_environment)
    if result.returncode != 0:
        raise SystemExit(f"exact dependency .venv exclusion was rejected:\n{result.stderr}")

    escaped_environment = base / "escaped-environment"
    fixture(escaped_environment)
    external_environment = escaped_environment / "external-venv"
    external_environment.mkdir()
    (external_environment / "distutils-precedence.pth").write_text("import _distutils_hack\n")
    (escaped_environment / "gpu/triton").mkdir(parents=True)
    (escaped_environment / "gpu/triton/.venv").symlink_to(external_environment)
    result = run(escaped_environment)
    if (
        result.returncode == 0
        or "dependency environment exclusion must not be a symlink" not in result.stderr
    ):
        raise SystemExit("symlinked dependency environment exclusion did not fail closed")

    broken_environment = base / "broken-environment"
    fixture(broken_environment)
    (broken_environment / "gpu/triton").mkdir(parents=True)
    (broken_environment / "gpu/triton/.venv").symlink_to(
        broken_environment / "missing-external-venv"
    )
    result = run(broken_environment)
    if (
        result.returncode == 0
        or "dependency environment exclusion must not be a symlink" not in result.stderr
    ):
        raise SystemExit("broken dependency environment symlink did not fail closed")

    outside_archive = base / "outside-archive"
    fixture(outside_archive)
    outside = outside_archive / "docs/examples/protected.zip"
    outside.parent.mkdir(parents=True)
    with zipfile.ZipFile(outside, "w") as bundle:
        bundle.writestr("porw_attack.py", archive_source)
    result = run(outside_archive)
    if result.returncode != 0:
        raise SystemExit(
            "archive outside governed gpu/triton scope was rejected:\n"
            f"{result.stderr}"
        )

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
        "literal_eval_call.py": "weights_leaf = set()\n",
        "closure_alias.py": (
            "from aigg_porw import verify_tile_fraud\n"
            "disguised_check = lambda *args: verify_tile_fraud(*args)\n"
        ),
        "container_alias.py": (
            "from aigg_porw import verify_tile_fraud\n"
            "disguised_checks = (verify_tile_fraud,)\n"
        ),
        "getattr_alias.py": (
            "import aigg_porw\n"
            "disguised_check = getattr(aigg_porw, 'verify_tile_fraud')\n"
        ),
        "from_module_alias.py": (
            "from aigg_porw import verification as module\n"
            "disguised_check = module.verify_tile_fraud\n"
        ),
        "dict_access.py": (
            "import aigg_porw\n"
            "disguised_check = aigg_porw.__dict__['verify_tile_fraud']\n"
        ),
        "star_import.py": "from aigg_porw.verification import *\n",
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
        "dynamic_builtins.py": (
            "import builtins\n"
            "builtins.exec(source)\n"
        ),
        "dynamic_alias.py": "runner = exec\nrunner(source)\n",
        "dynamic_builtins_alias.py": (
            "import builtins as runtime\n"
            "runner = runtime.compile\n"
            "runner(source, '<dynamic>', 'exec')\n"
        ),
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
    harmless_candidate.write_text(
        "weights_leaf = True\n"
        "partials_leaf = False\n"
        "merkle_parent = None\n"
        "fmix32 = -7\n"
        "tile_coeffs = b'locked-vector fixture'\n"
        "sketch_tiles = 'locked-vector fixture'\n"
        "verify_counted_merkle = (1, -2, 'x')\n"
        "verify_committed_opening = [1, False, None]\n"
        "verify_interior_non_inclusion = {'key': 1}\n"
        "verify_tile_fraud = {1, 2}\n"
    )
    result = run(harmless)
    if result.returncode != 0:
        raise SystemExit(f"harmless literal fixture was rejected:\n{result.stderr}")

    comprehension = base / "comprehension"
    fixture(comprehension)
    comprehension_candidate = comprehension / "gpu/tests/fixture.py"
    comprehension_candidate.parent.mkdir(parents=True)
    comprehension_candidate.write_text(
        "weights_leaf = [item for item in locked_values]\n"
    )
    result = run(comprehension)
    if result.returncode == 0 or "binding invariant violated" not in result.stderr:
        raise SystemExit("callable-capable comprehension escaped the source-tree gate")

    hostile = base / "hostile-launcher"
    fixture(hostile)
    hostile_candidate = hostile / "gpu/tests/duplicate.py"
    hostile_candidate.parent.mkdir(parents=True)
    hostile_candidate.write_text("def fmix32(value):\n    return value\n")
    hostile_path = base / "hostile-pythonpath"
    hostile_path.mkdir()
    (hostile_path / "sitecustomize.py").write_text(
        "import os\nos._exit(0)\n"
    )
    hostile_cwd = base / "hostile-cwd"
    hostile_cwd.mkdir()
    (hostile_cwd / "check_python_source_tree.py").write_text(
        "raise SystemExit(0)\n"
    )
    for module in ("ast", "pathlib", "tomllib"):
        (hostile_cwd / f"{module}.py").write_text(
            f"raise RuntimeError('cwd shadowed {module}')\n"
        )
    hostile_user_base = base / "hostile-user-base"
    hostile_user_site = (
        hostile_user_base
        / "lib"
        / f"python{sys.version_info.major}.{sys.version_info.minor}"
        / "site-packages"
    )
    hostile_user_site.mkdir(parents=True)
    (hostile_user_site / "sitecustomize.py").write_text(
        "import os\nos._exit(0)\n"
    )
    hostile_environment = {
        "PYTHONPATH": str(hostile_path),
        "PYTHONUSERBASE": str(hostile_user_base),
        "PYTHONNOUSERSITE": "0",
    }
    result = run(
        hostile,
        extra_environment=hostile_environment,
        cwd=hostile_cwd,
    )
    expected_error = (
        "python source-tree gate: explicit AST binding invariant violated"
    )
    if (
        result.returncode == 0
        or expected_error not in result.stderr
        or "gpu/tests/duplicate.py:1: definition fmix32" not in result.stderr
    ):
        raise SystemExit(
            "hostile sitecustomize/cwd bypassed deterministic source scanning: "
            f"rc={result.returncode}, stdout={result.stdout!r}, "
            f"stderr={result.stderr!r}"
        )

    hostile_imports = base / "hostile-imports"
    hostile_imports.mkdir()
    (hostile_imports / "sitecustomize.py").write_text(
        "import builtins\n"
        "import os\n"
        "def hostile_import(*args, **kwargs):\n"
        "    os._exit(0)\n"
        "builtins.__import__ = hostile_import\n"
    )
    for module in ("ast", "pathlib", "tomllib"):
        (hostile_imports / f"{module}.py").write_text(
            f"raise RuntimeError('shadowed {module}')\n"
        )
    result = run(
        hostile,
        extra_environment={"PYTHONPATH": str(hostile_imports)},
        cwd=hostile_cwd,
    )
    if (
        result.returncode == 0
        or expected_error not in result.stderr
        or "gpu/tests/duplicate.py:1: definition fmix32" not in result.stderr
    ):
        raise SystemExit(
            "hostile module shadows bypassed deterministic source scanning: "
            f"rc={result.returncode}, stdout={result.stdout!r}, "
            f"stderr={result.stderr!r}"
        )

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
