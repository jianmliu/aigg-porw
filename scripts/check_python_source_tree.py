"""Enforce the single-canonical-implementation boundary for PoRW Python.

Outside ``packages/python/src/aigg_porw``, protected public proof algorithms
may only be bound by an absolute import from ``aigg_porw``. Governed files may
not define them, rebind their callable objects (even under another name),
write them through attributes or literal ``globals()``/``locals()`` keys, or
register a callable under a protected literal name. Dynamic code creation is
forbidden under ``gpu/triton``. A plain non-callable literal used as a test
fixture may share a protected name because it cannot become a verifier.
"""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

import tomllib

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
PROTECTED_NAMES = {
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
DYNAMIC_CREATORS = {"compile", "eval", "exec"}


def normalized(name: str) -> str:
    return "".join(character for character in name.casefold() if character.isalnum())


def is_protected(name: str) -> bool:
    return normalized(name) in PROTECTED_NAMES


def fail(message: str) -> None:
    print(f"python source-tree gate: {message}", file=sys.stderr)
    raise SystemExit(1)


def beneath(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def require_regular_tree(path: Path, root: Path, description: str) -> Path:
    current = path
    while current != root:
        if current.is_symlink():
            fail(f"{description} must not contain a symlink: {current}")
        current = current.parent
    resolved = path.resolve(strict=True)
    if not beneath(resolved, root.resolve(strict=True)):
        fail(f"{description} resolves outside the checkout: {path} -> {resolved}")
    return resolved


def assignment_targets(
    node: ast.Assign | ast.AnnAssign | ast.NamedExpr,
) -> list[ast.expr]:
    if isinstance(node, ast.Assign):
        return list(node.targets)
    return [node.target]


def assigned_value(node: ast.Assign | ast.AnnAssign | ast.NamedExpr) -> ast.expr:
    if isinstance(node, ast.AnnAssign):
        return node.value if node.value is not None else ast.Constant(None)
    return node.value


def target_names(target: ast.expr) -> list[str]:
    return [item.id for item in ast.walk(target) if isinstance(item, ast.Name)]


def protected_attribute(target: ast.expr) -> str | None:
    if isinstance(target, ast.Attribute) and is_protected(target.attr):
        return target.attr
    return None


def protected_namespace_key(target: ast.expr) -> str | None:
    if not isinstance(target, ast.Subscript):
        return None
    if (
        not isinstance(target.value, ast.Call)
        or target.value.args
        or target.value.keywords
    ):
        return None
    if not isinstance(target.value.func, ast.Name) or target.value.func.id not in {
        "globals",
        "locals",
    }:
        return None
    if isinstance(target.slice, ast.Constant) and type(target.slice.value) is str:
        key = target.slice.value
        return key if is_protected(key) else None
    return None


def is_harmless_literal(value: ast.expr) -> bool:
    return isinstance(value, ast.Constant) and type(value.value) in {
        bytes,
        float,
        int,
        str,
        type(None),
    }


def referenced_binding(
    value: ast.expr,
    canonical_algorithm_bindings: set[str],
    canonical_module_bindings: set[str],
) -> str | None:
    if isinstance(value, ast.Name) and value.id in canonical_algorithm_bindings:
        return value.id
    if isinstance(value, ast.Attribute) and is_protected(value.attr):
        root = value.value
        while isinstance(root, ast.Attribute):
            root = root.value
        if isinstance(root, ast.Name) and root.id in canonical_module_bindings:
            return value.attr
    if isinstance(value, ast.Lambda):
        for nested in ast.walk(value.body):
            if (
                isinstance(nested, ast.Name)
                and nested.id in canonical_algorithm_bindings
            ):
                return nested.id
            if isinstance(nested, ast.Attribute) and is_protected(nested.attr):
                return nested.attr
    if isinstance(value, ast.Call):
        nested_values = [*value.args, *(keyword.value for keyword in value.keywords)]
    else:
        nested_values = list(ast.iter_child_nodes(value))
    for nested in nested_values:
        if isinstance(nested, ast.expr):
            rebound = referenced_binding(
                nested,
                canonical_algorithm_bindings,
                canonical_module_bindings,
            )
            if rebound is not None:
                return rebound
    return None


def literal_protected_arguments(call: ast.Call) -> list[str]:
    values = [*call.args, *(keyword.value for keyword in call.keywords)]
    return [
        value.value
        for value in values
        if isinstance(value, ast.Constant)
        and type(value.value) is str
        and is_protected(value.value)
    ]


def canonical_module_exists(module: str, package_root: Path) -> bool:
    parts = module.split(".")
    if not parts or parts[0] != "aigg_porw":
        return False
    candidate = package_root.parent.joinpath(*parts)
    source = (
        candidate / "__init__.py"
        if candidate.is_dir()
        else candidate.with_suffix(".py")
    )
    return (
        source.is_file()
        and not source.is_symlink()
        and beneath(source.resolve(strict=True), package_root)
    )


def inspect_file(
    path: Path,
    root: Path,
    governed_gpu: Path,
    package_root: Path,
) -> list[str]:
    relative = path.relative_to(root)
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError) as error:
        fail(f"cannot inspect {relative}: {error}")

    violations: list[str] = []
    canonical_algorithm_bindings: set[str] = set()
    canonical_module_bindings: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if canonical_module_exists(alias.name, package_root):
                    canonical_module_bindings.add(
                        alias.asname or alias.name.split(".", 1)[0]
                    )
                else:
                    bound = alias.asname or alias.name.rsplit(".", 1)[-1]
                    if is_protected(bound) or is_protected(
                        alias.name.rsplit(".", 1)[-1]
                    ):
                        violations.append(
                            f"{relative}:{node.lineno}: non-canonical import alias {bound}"
                        )
        elif isinstance(node, ast.ImportFrom):
            absolute_canonical = (
                node.level == 0
                and node.module is not None
                and canonical_module_exists(node.module, package_root)
            )
            for alias in node.names:
                bound = alias.asname or alias.name
                protected = is_protected(bound) or is_protected(alias.name)
                if protected and not absolute_canonical:
                    violations.append(
                        f"{relative}:{node.lineno}: non-canonical import alias {bound}"
                    )
                if absolute_canonical and protected:
                    canonical_algorithm_bindings.add(bound)

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if is_protected(node.name):
                violations.append(f"{relative}:{node.lineno}: definition {node.name}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    if isinstance(decorator, ast.Call):
                        for protected in literal_protected_arguments(decorator):
                            violations.append(
                                f"{relative}:{decorator.lineno}: decorator registers {protected}"
                            )
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            value = assigned_value(node)
            rebound = referenced_binding(
                value,
                canonical_algorithm_bindings,
                canonical_module_bindings,
            )
            for target in assignment_targets(node):
                attribute = protected_attribute(target)
                namespace_key = protected_namespace_key(target)
                if attribute is not None:
                    violations.append(
                        f"{relative}:{node.lineno}: attribute assignment to {attribute}"
                    )
                if namespace_key is not None:
                    violations.append(
                        f"{relative}:{node.lineno}: dynamic namespace assignment to {namespace_key}"
                    )
                protected_targets = [
                    name for name in target_names(target) if is_protected(name)
                ]
                if protected_targets and not is_harmless_literal(value):
                    for name in protected_targets:
                        violations.append(
                            f"{relative}:{node.lineno}: callable or rebound assignment to {name}"
                        )
                if rebound is not None:
                    violations.append(
                        f"{relative}:{node.lineno}: canonical algorithm rebound from {rebound}"
                    )
        elif isinstance(node, ast.Call):
            if (
                beneath(path.resolve(), governed_gpu)
                and isinstance(node.func, ast.Name)
                and node.func.id in DYNAMIC_CREATORS
            ):
                violations.append(
                    f"{relative}:{node.lineno}: dynamic code creation via {node.func.id}"
                )
            if (
                isinstance(node.func, ast.Name)
                and node.func.id == "setattr"
                and len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and type(node.args[1].value) is str
                and is_protected(node.args[1].value)
            ):
                violations.append(
                    f"{relative}:{node.lineno}: setattr writes {node.args[1].value}"
                )
            if not isinstance(node.func, ast.Name) or node.func.id not in {
                "getattr",
                "hasattr",
            }:
                for protected in literal_protected_arguments(node):
                    violations.append(
                        f"{relative}:{node.lineno}: registry call binds {protected}"
                    )
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                if (
                    isinstance(key, ast.Constant)
                    and type(key.value) is str
                    and is_protected(key.value)
                    and not is_harmless_literal(value)
                ):
                    violations.append(
                        f"{relative}:{node.lineno}: registry literal binds {key.value}"
                    )
    return violations


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: check_python_source_tree.py REPOSITORY_ROOT")
    supplied_root = Path(sys.argv[1]).absolute()
    if supplied_root.is_symlink():
        fail(f"repository root must not be a symlink: {supplied_root}")
    root = supplied_root.resolve(strict=True)
    package_root = root / "packages/python/src/aigg_porw"
    pyproject = root / "packages/python/pyproject.toml"
    if not package_root.is_dir() or not (package_root / "__init__.py").is_file():
        fail(f"canonical checkout package is missing: {package_root}")
    if not pyproject.is_file():
        fail(f"canonical package metadata is missing: {pyproject}")

    package_root = require_regular_tree(package_root, root, "canonical package")
    require_regular_tree(pyproject, root, "canonical package metadata")
    for package_source in package_root.rglob("*.py"):
        require_regular_tree(package_source, root, "canonical package source")

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
    governed_gpu = (root / "gpu/triton").resolve()
    for directory, child_directories, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for child in child_directories:
            candidate = directory_path / child
            if candidate.is_symlink():
                violations.append(
                    f"{candidate.relative_to(root)}: symlinked source directory"
                )
        child_directories[:] = sorted(
            name
            for name in child_directories
            if name not in SKIPPED_DIRECTORIES
            and not (directory_path / name).is_symlink()
        )
        if beneath(directory_path.resolve(), package_root):
            child_directories[:] = []
            continue

        for filename in sorted(filenames):
            if not filename.endswith(".py"):
                continue
            path = directory_path / filename
            if path.is_symlink():
                violations.append(f"{path.relative_to(root)}: symlinked Python source")
                continue
            resolved = path.resolve(strict=True)
            if not beneath(resolved, root):
                violations.append(
                    f"{path.relative_to(root)}: Python source resolves outside checkout"
                )
                continue
            violations.extend(inspect_file(path, root, governed_gpu, package_root))

    if violations:
        print(
            "python source-tree gate: canonical algorithm binding invariant violated",
            file=sys.stderr,
        )
        for violation in sorted(set(violations)):
            print(f"  {violation}", file=sys.stderr)
        raise SystemExit(1)

    print(
        "python source-tree gate: canonical algorithm bindings are unique and "
        f"explicit at version {EXPECTED_VERSION}"
    )


if __name__ == "__main__":
    main()
