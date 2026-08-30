#!/usr/bin/env bash
# Reject a second Python implementation of canonical PoRW proof mathematics.
set -euo pipefail

PORW_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PORW_DEFAULT_ROOT="$(cd -- "$PORW_SCRIPT_DIR/.." && pwd -P)"
PORW_SOURCE_ROOT="${1:-$PORW_DEFAULT_ROOT}"
PORW_DEFAULT_PYTHON="$PORW_DEFAULT_ROOT/packages/python/.venv/bin/python"
if [[ ! -x "$PORW_DEFAULT_PYTHON" ]]; then
  PORW_DEFAULT_PYTHON=python3
fi
PORW_PYTHON_BIN="${PORW_SOURCE_TREE_PYTHON:-$PORW_DEFAULT_PYTHON}"

"$PORW_PYTHON_BIN" - "$PORW_SOURCE_ROOT" <<'PY'
from __future__ import annotations

import ast
import os
import sys
import tomllib
from pathlib import Path

EXPECTED_VERSION = "0.2.0.dev1+research"
SKIPPED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "target",
}
FORBIDDEN_NAMES = {
    "fmix32",
    "tilecoeffs",
    "sketchtiles",
    "verifycountedmerkle",
    "merkleverifycounted",  # legacy word order
    "weightsleaf",
    "partialsleaf",
    "merkleparent",
    "verifycommittedopening",
    "verifyinteriornoninclusion",
    "verifytilefraud",
    "fraudverdict",  # legacy local verifier name
}


def normalized(name: str) -> str:
    return "".join(character for character in name.casefold() if character.isalnum())


def is_forbidden(name: str) -> bool:
    return normalized(name) in FORBIDDEN_NAMES


def fail(message: str) -> None:
    print(f"python source-tree gate: {message}", file=sys.stderr)
    raise SystemExit(1)


root = Path(sys.argv[1]).resolve()
package_root = root / "packages/python/src/aigg_porw"
pyproject = root / "packages/python/pyproject.toml"
if not package_root.is_dir() or not (package_root / "__init__.py").is_file():
    fail(f"canonical checkout package is missing: {package_root}")
if not pyproject.is_file():
    fail(f"canonical package metadata is missing: {pyproject}")

try:
    metadata = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    actual_version = metadata["project"]["version"]
except (KeyError, OSError, tomllib.TOMLDecodeError) as error:
    fail(f"cannot read canonical package version: {error}")
if type(actual_version) is not str or actual_version != EXPECTED_VERSION:
    fail(
        "canonical package version mismatch: "
        f"expected {EXPECTED_VERSION}, found {actual_version!r}"
    )

violations: list[str] = []
for directory, child_directories, filenames in os.walk(root):
    child_directories[:] = sorted(
        name for name in child_directories if name not in SKIPPED_DIRECTORIES
    )
    directory_path = Path(directory)
    try:
        directory_path.relative_to(package_root)
    except ValueError:
        pass
    else:
        child_directories[:] = []
        continue

    for filename in sorted(filenames):
        if not filename.endswith(".py"):
            continue
        path = directory_path / filename
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as error:
            fail(f"cannot inspect {path.relative_to(root)}: {error}")

        relative = path.relative_to(root)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if is_forbidden(node.name):
                    violations.append(f"{relative}:{node.lineno}: definition {node.name}")
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
                targets: list[ast.expr]
                if isinstance(node, ast.Assign):
                    targets = list(node.targets)
                else:
                    targets = [node.target]
                for target in targets:
                    names = [item.id for item in ast.walk(target) if isinstance(item, ast.Name)]
                    for name in names:
                        if is_forbidden(name):
                            violations.append(
                                f"{relative}:{node.lineno}: assignment to {name}"
                            )
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                # Explicit imports/re-exports from the canonical package are
                # compatibility plumbing, not duplicate implementations.
                module = node.module if isinstance(node, ast.ImportFrom) else None
                canonical = module == "aigg_porw" or (
                    module is not None and module.startswith("aigg_porw.")
                )
                for alias in node.names:
                    bound_name = alias.asname or alias.name.rsplit(".", 1)[-1]
                    imported_name = alias.name.rsplit(".", 1)[-1]
                    if (
                        is_forbidden(bound_name) or is_forbidden(imported_name)
                    ) and not canonical:
                        violations.append(
                            f"{relative}:{node.lineno}: non-canonical import alias {bound_name}"
                        )

if violations:
    print(
        "python source-tree gate: duplicate PoRW production definitions found",
        file=sys.stderr,
    )
    for violation in violations:
        print(f"  {violation}", file=sys.stderr)
    raise SystemExit(1)

print(
    "python source-tree gate: canonical PoRW implementation is unique "
    f"at version {EXPECTED_VERSION}"
)
PY
