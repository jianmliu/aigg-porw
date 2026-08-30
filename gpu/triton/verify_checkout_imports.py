"""Isolated import and locked-vector probe for the local PoRW checkout."""

from __future__ import annotations

import importlib.metadata
import json
import os
import runpy
import sys
from dataclasses import dataclass
from pathlib import Path

import tomllib

EXPECTED_DISTRIBUTION_VERSION = "0.2.0.dev1+research"
EXPECTED_NUMPY_VERSION = "2.0.2"
EXPECTED_NUMPY_REQUIREMENT = "numpy>=2.0,<3"


@dataclass(frozen=True, slots=True)
class CheckoutImportEvidence:
    distribution_version: str
    numpy_version: str
    package_directory: Path
    triton_package_directory: Path


def _fail(message: str) -> None:
    raise RuntimeError(f"aigg-porw checkout import probe: {message}")


def _beneath(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _require_unsymlinked(path: Path, root: Path, description: str) -> Path:
    current = path
    while current != root:
        if current.is_symlink():
            _fail(f"{description} contains a symlink: {current}")
        current = current.parent
    resolved = path.resolve(strict=True)
    if not _beneath(resolved, root):
        _fail(f"{description} resolves outside checkout: {path} -> {resolved}")
    return resolved


def _exact_module_directory(module: object, expected: Path, name: str) -> Path:
    module_file = getattr(module, "__file__", None)
    if type(module_file) is not str:
        _fail(f"{name} has no exact source file")
    directory = Path(module_file).resolve(strict=True).parent
    if directory != expected:
        _fail(f"{name} imported from {directory}; expected {expected}")
    return directory


def verify_checkout(repository_root: Path | str) -> CheckoutImportEvidence:
    supplied_root = Path(repository_root).absolute()
    if supplied_root.is_symlink():
        _fail(f"repository root is a symlink: {supplied_root}")
    root = supplied_root.resolve(strict=True)
    package_source = _require_unsymlinked(
        root / "packages/python/src", root, "canonical package source"
    )
    package_directory = _require_unsymlinked(
        package_source / "aigg_porw", root, "canonical package"
    )
    triton_source = _require_unsymlinked(root / "gpu/triton", root, "Triton source")
    triton_package_directory = _require_unsymlinked(
        triton_source / "porw_sketch", root, "Triton package"
    )
    pyproject = _require_unsymlinked(
        root / "packages/python/pyproject.toml", root, "package metadata"
    )

    metadata = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    distribution_version = metadata.get("project", {}).get("version")
    requirements = metadata.get("project", {}).get("dependencies")
    if distribution_version != EXPECTED_DISTRIBUTION_VERSION:
        _fail(
            "distribution version mismatch: "
            f"expected {EXPECTED_DISTRIBUTION_VERSION}, found {distribution_version!r}"
        )
    if type(requirements) is not list or EXPECTED_NUMPY_REQUIREMENT not in requirements:
        _fail(f"missing exact runtime requirement {EXPECTED_NUMPY_REQUIREMENT}")

    approved = (str(package_source), str(triton_source))
    sys.path[:] = [
        *approved,
        *(
            entry
            for entry in sys.path
            if entry not in {"", *approved}
            and Path(entry).resolve() != Path.cwd().resolve()
        ),
    ]

    import aigg_porw
    import aigg_porw.scheme as canonical_scheme
    import numpy
    import porw_sketch

    exact_package = _exact_module_directory(aigg_porw, package_directory, "aigg_porw")
    exact_triton = _exact_module_directory(
        porw_sketch, triton_package_directory, "porw_sketch"
    )
    if numpy.__version__ != EXPECTED_NUMPY_VERSION:
        _fail(f"NumPy {EXPECTED_NUMPY_VERSION} required, found {numpy.__version__}")

    try:
        installed_version = importlib.metadata.version("aigg-porw")
    except importlib.metadata.PackageNotFoundError:
        installed_version = distribution_version
    if installed_version != distribution_version:
        _fail(
            "installed distribution metadata mismatch: "
            f"checkout {distribution_version}, installed {installed_version}"
        )

    compatibility_scheme = porw_sketch.spec
    if compatibility_scheme.sketch_tiles is not canonical_scheme.sketch_tiles:
        _fail("Triton compatibility layer is not bound to the canonical package")

    vector_path = root / "spec-cache/conformance/porw/sketch-tile-v2.json"
    vector = json.loads(vector_path.read_text(encoding="utf-8"))
    length = int(vector["reference_buffer"]["n_tiles"]) * canonical_scheme.TILE_BYTES
    buffer = bytes(
        ((((index * 2654435761) & ((1 << 64) - 1)) >> 7) & 0xFF)
        for index in range(length)
    )
    byte_array = numpy.frombuffer(buffer, dtype=numpy.uint8)
    for case in vector["sketches"]:
        actual = canonical_scheme.sketch_tiles(case["slot_seed"], byte_array)
        if actual.tolist() != case["per_tile"]:
            _fail(f"locked vector mismatch for slot seed {case['slot_seed']}")

    return CheckoutImportEvidence(
        distribution_version=distribution_version,
        numpy_version=numpy.__version__,
        package_directory=exact_package,
        triton_package_directory=exact_triton,
    )


def main() -> None:
    if len(sys.argv) not in {2, 4}:
        _fail("usage: verify_checkout_imports.py REPOSITORY_ROOT [--run SCRIPT]")
    evidence = verify_checkout(sys.argv[1])
    print(
        "aigg-porw checkout import probe: passed; "
        f"distribution {evidence.distribution_version}; "
        f"NumPy {evidence.numpy_version}; "
        f"aigg_porw {evidence.package_directory}; "
        f"porw_sketch {evidence.triton_package_directory}"
    )

    if len(sys.argv) == 4:
        if sys.argv[2] != "--run":
            _fail("only --run SCRIPT is supported after the repository root")
        root = Path(sys.argv[1]).resolve(strict=True)
        target = Path(sys.argv[3]).resolve(strict=True)
        expected_target = (root / "gpu/triton/bench_gpu.py").resolve(strict=True)
        if target != expected_target:
            _fail(f"refusing to execute non-benchmark target: {target}")
        os.chdir(root)
        runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()
