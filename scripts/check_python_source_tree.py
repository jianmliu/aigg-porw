"""Enforce an explicit AST binding invariant for PoRW Python source.

Outside ``packages/python/src/aigg_porw``, this checker rejects protected
public algorithm spellings when they are defined, rebound through the
enumerated import/attribute/getattr/module-dict forms, dynamically written, or
registered as callables. Absolute named compatibility re-exports from a real
``aigg_porw`` module remain permitted. Under the explicitly governed
``gpu/triton`` tree, calls to ``exec``, ``eval``, and ``compile`` are also
rejected in their direct, ``builtins``-qualified, and simple-alias forms.
Before any checkout module can be imported, regular files and symlinks with
case-insensitive executable archive suffixes ``.zip``, ``.whl``, ``.egg``, or
``.pyz`` are rejected anywhere under that governed tree (apart from the same
explicit cache/build/environment directories excluded from source scanning).
``.pth`` executable path files are rejected in the same scope. Archives
outside ``gpu/triton`` are outside this integration-source invariant.

This is a syntactic invariant, not semantic proof against an equivalent
algorithm written under an unrelated name or against arbitrary dynamic
metaprogramming. AST literals may use a protected fixture name because they
cannot bind a callable.
"""

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
GOVERNED_DYNAMIC_PATHS = (Path("gpu/triton"),)
EXECUTABLE_ARCHIVE_SUFFIXES = frozenset({".egg", ".pyz", ".whl", ".zip"})
EXECUTABLE_PATH_SUFFIXES = frozenset({".pth"})


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


def reject_governed_executable_containers(root: Path) -> None:
    """Reject zipimport and site-path payloads before scanning Python source."""
    violations: list[str] = []
    for governed_relative in GOVERNED_DYNAMIC_PATHS:
        governed = root / governed_relative
        if not governed.exists():
            continue
        for directory, child_directories, filenames in os.walk(
            governed,
            followlinks=False,
        ):
            directory_path = Path(directory)
            entries = [
                *(directory_path / name for name in child_directories),
                *(directory_path / name for name in filenames),
            ]
            for candidate in sorted(entries):
                suffix = candidate.suffix.casefold()
                if suffix not in EXECUTABLE_ARCHIVE_SUFFIXES | EXECUTABLE_PATH_SUFFIXES:
                    continue
                relative = candidate.relative_to(root)
                entry_kind = "symlinked" if candidate.is_symlink() else "regular"
                if suffix in EXECUTABLE_ARCHIVE_SUFFIXES:
                    description = "executable Python archive"
                else:
                    description = "executable Python path file"
                violations.append(
                    f"{relative}: {description} ({entry_kind}, {suffix}) is forbidden "
                    f"under governed integration tree {governed_relative}"
                )
            child_directories[:] = sorted(
                name
                for name in child_directories
                if name not in SKIPPED_DIRECTORIES and not (directory_path / name).is_symlink()
            )
    if violations:
        print(
            "python source-tree gate: governed executable-container invariant violated",
            file=sys.stderr,
        )
        for violation in sorted(set(violations)):
            print(f"  {violation}", file=sys.stderr)
        raise SystemExit(1)


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
    if not isinstance(target.value, ast.Call) or target.value.args or target.value.keywords:
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
    if any(isinstance(node, ast.Call) for node in ast.walk(value)):
        return False
    try:
        ast.literal_eval(value)
    except (MemoryError, RecursionError, TypeError, ValueError):
        return False
    return True


def is_canonical_module_reference(
    value: ast.expr,
    canonical_module_bindings: set[str],
) -> bool:
    root = value
    while isinstance(root, ast.Attribute):
        root = root.value
    return isinstance(root, ast.Name) and root.id in canonical_module_bindings


def protected_module_dict_access(
    value: ast.expr,
    canonical_module_bindings: set[str],
) -> str | None:
    if not isinstance(value, ast.Subscript):
        return None
    namespace = value.value
    if (
        not isinstance(namespace, ast.Attribute)
        or namespace.attr != "__dict__"
        or not is_canonical_module_reference(namespace.value, canonical_module_bindings)
    ):
        return None
    if isinstance(value.slice, ast.Constant) and type(value.slice.value) is str:
        key = value.slice.value
        return key if is_protected(key) else None
    return None


def protected_getattr_access(
    value: ast.expr,
    canonical_module_bindings: set[str],
) -> str | None:
    if (
        not isinstance(value, ast.Call)
        or not isinstance(value.func, ast.Name)
        or value.func.id != "getattr"
        or len(value.args) < 2
        or not is_canonical_module_reference(value.args[0], canonical_module_bindings)
        or not isinstance(value.args[1], ast.Constant)
        or type(value.args[1].value) is not str
    ):
        return None
    attribute = value.args[1].value
    return attribute if is_protected(attribute) else None


def referenced_binding(
    value: ast.expr,
    canonical_algorithm_bindings: set[str],
    canonical_module_bindings: set[str],
) -> str | None:
    if isinstance(value, ast.Name) and value.id in canonical_algorithm_bindings:
        return value.id
    if (
        isinstance(value, ast.Attribute)
        and is_protected(value.attr)
        and is_canonical_module_reference(value.value, canonical_module_bindings)
    ):
        return value.attr
    getattr_access = protected_getattr_access(value, canonical_module_bindings)
    if getattr_access is not None:
        return getattr_access
    module_dict_access = protected_module_dict_access(value, canonical_module_bindings)
    if module_dict_access is not None:
        return module_dict_access
    if isinstance(value, ast.Lambda):
        for nested in ast.walk(value.body):
            if isinstance(nested, ast.Name) and nested.id in canonical_algorithm_bindings:
                return nested.id
            if (
                isinstance(nested, ast.Attribute)
                and is_protected(nested.attr)
                and is_canonical_module_reference(nested.value, canonical_module_bindings)
            ):
                return nested.attr
    if isinstance(value, ast.Call):
        nested_values = [*value.args, *(keyword.value for keyword in value.keywords)]
    else:
        nested_values = [
            child for child in ast.iter_child_nodes(value) if isinstance(child, ast.expr)
        ]
    for nested in nested_values:
        rebound = referenced_binding(
            nested,
            canonical_algorithm_bindings,
            canonical_module_bindings,
        )
        if rebound is not None:
            return rebound
    return None


def dynamic_creator_reference(
    value: ast.expr,
    dynamic_creator_bindings: set[str],
    builtins_module_bindings: set[str],
) -> str | None:
    if isinstance(value, ast.Name) and value.id in dynamic_creator_bindings:
        return value.id
    if (
        isinstance(value, ast.Attribute)
        and value.attr in DYNAMIC_CREATORS
        and isinstance(value.value, ast.Name)
        and value.value.id in builtins_module_bindings
    ):
        return value.attr
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
    source = candidate / "__init__.py" if candidate.is_dir() else candidate.with_suffix(".py")
    return (
        source.is_file()
        and not source.is_symlink()
        and beneath(source.resolve(strict=True), package_root)
    )


def inspect_file(
    path: Path,
    root: Path,
    governed_dynamic_paths: tuple[Path, ...],
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
    builtins_module_bindings: set[str] = set()
    dynamic_creator_bindings = set(DYNAMIC_CREATORS)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "builtins":
                    builtins_module_bindings.add(alias.asname or "builtins")
                if canonical_module_exists(alias.name, package_root):
                    canonical_module_bindings.add(alias.asname or alias.name.split(".", 1)[0])
                else:
                    bound = alias.asname or alias.name.rsplit(".", 1)[-1]
                    if is_protected(bound) or is_protected(alias.name.rsplit(".", 1)[-1]):
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
                if node.level == 0 and node.module == "builtins" and alias.name in DYNAMIC_CREATORS:
                    dynamic_creator_bindings.add(bound)
                protected_import = is_protected(bound) or is_protected(alias.name)
                if protected_import and not absolute_canonical:
                    violations.append(
                        f"{relative}:{node.lineno}: non-canonical import alias {bound}"
                    )
                if absolute_canonical and protected_import:
                    canonical_algorithm_bindings.add(bound)
                elif absolute_canonical and alias.name == "*":
                    violations.append(
                        f"{relative}:{node.lineno}: canonical star import is forbidden"
                    )
                elif absolute_canonical and canonical_module_exists(
                    f"{node.module}.{alias.name}", package_root
                ):
                    canonical_module_bindings.add(bound)

    assignments = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr))
    ]
    changed = True
    while changed:
        changed = False
        for node in assignments:
            creator = dynamic_creator_reference(
                assigned_value(node),
                dynamic_creator_bindings,
                builtins_module_bindings,
            )
            if creator is None:
                continue
            for target in assignment_targets(node):
                if isinstance(target, ast.Name) and target.id not in (dynamic_creator_bindings):
                    dynamic_creator_bindings.add(target.id)
                    changed = True

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if is_protected(node.name):
                violations.append(f"{relative}:{node.lineno}: definition {node.name}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    if isinstance(decorator, ast.Call):
                        for protected_name in literal_protected_arguments(decorator):
                            violations.append(
                                f"{relative}:{decorator.lineno}: decorator registers "
                                f"{protected_name}"
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
                protected_targets = [name for name in target_names(target) if is_protected(name)]
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
            dynamic_creator = dynamic_creator_reference(
                node.func,
                dynamic_creator_bindings,
                builtins_module_bindings,
            )
            if (
                any(
                    beneath(path.resolve(), governed_path)
                    for governed_path in governed_dynamic_paths
                )
                and dynamic_creator is not None
            ):
                violations.append(
                    f"{relative}:{node.lineno}: dynamic code creation via {dynamic_creator}"
                )
            if (
                isinstance(node.func, ast.Name)
                and node.func.id == "setattr"
                and len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and type(node.args[1].value) is str
                and is_protected(node.args[1].value)
            ):
                violations.append(f"{relative}:{node.lineno}: setattr writes {node.args[1].value}")
            if not isinstance(node.func, ast.Name) or node.func.id not in {
                "getattr",
                "hasattr",
            }:
                for protected_name in literal_protected_arguments(node):
                    violations.append(
                        f"{relative}:{node.lineno}: registry call binds {protected_name}"
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

    reject_governed_executable_containers(root)

    violations: list[str] = []
    governed_dynamic_paths = tuple(
        (root / relative).resolve() for relative in GOVERNED_DYNAMIC_PATHS
    )
    for directory, child_directories, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for child in child_directories:
            candidate = directory_path / child
            if candidate.is_symlink():
                violations.append(f"{candidate.relative_to(root)}: symlinked source directory")
        child_directories[:] = sorted(
            name
            for name in child_directories
            if name not in SKIPPED_DIRECTORIES and not (directory_path / name).is_symlink()
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
            violations.extend(
                inspect_file(
                    path,
                    root,
                    governed_dynamic_paths,
                    package_root,
                )
            )

    if violations:
        print(
            "python source-tree gate: explicit AST binding invariant violated",
            file=sys.stderr,
        )
        for violation in sorted(set(violations)):
            print(f"  {violation}", file=sys.stderr)
        raise SystemExit(1)

    print(
        "python source-tree gate: explicit PoRW AST binding invariant holds "
        f"at version {EXPECTED_VERSION}; dynamic-call and executable-container "
        "scope: gpu/triton; archives: .egg/.pyz/.whl/.zip; path files: .pth"
    )


if __name__ == "__main__":
    main()
