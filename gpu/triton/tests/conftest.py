"""Pytest startup gates for the reproducible Triton PoRW environment."""

import platform
import sys
from importlib import metadata
from pathlib import Path

import pytest
import tomllib

REQUIRED_PYTHON = "3.12.13"
REQUIRED_PORW_VERSION = "0.2.0.dev1+research"
REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_SOURCE = (REPO_ROOT / "packages/python/src").resolve()
TRITON_SOURCE = (REPO_ROOT / "gpu/triton").resolve()
PACKAGE_DIRECTORY = PACKAGE_SOURCE / "aigg_porw"
PACKAGE_METADATA = REPO_ROOT / "packages/python/pyproject.toml"


def _require_checkout_package() -> None:
    if not (PACKAGE_DIRECTORY / "__init__.py").is_file():
        raise pytest.UsageError(
            f"canonical aigg_porw checkout package is missing: {PACKAGE_DIRECTORY}"
        )
    if not PACKAGE_METADATA.is_file():
        raise pytest.UsageError(
            f"canonical aigg_porw package metadata is missing: {PACKAGE_METADATA}"
        )

    try:
        configured_version = tomllib.loads(
            PACKAGE_METADATA.read_text(encoding="utf-8")
        )["project"]["version"]
    except (KeyError, OSError, tomllib.TOMLDecodeError) as error:
        raise pytest.UsageError(
            f"cannot read canonical aigg_porw package version: {error}"
        ) from error
    if configured_version != REQUIRED_PORW_VERSION:
        raise pytest.UsageError(
            "canonical aigg_porw package version mismatch: "
            f"expected {REQUIRED_PORW_VERSION}, found {configured_version!r}"
        )

    # Both entries are explicit repository test inputs, not published or
    # floating dependencies. The package path must win over any ambient copy.
    for source in (TRITON_SOURCE, PACKAGE_SOURCE):
        source_text = str(source)
        if source_text in sys.path:
            sys.path.remove(source_text)
        sys.path.insert(0, source_text)

    import aigg_porw

    imported_directory = Path(aigg_porw.__file__).resolve().parent
    if imported_directory != PACKAGE_DIRECTORY:
        raise pytest.UsageError(
            "aigg_porw resolved outside this checkout: "
            f"expected {PACKAGE_DIRECTORY}, found {imported_directory}"
        )

    try:
        installed_version = metadata.version("aigg-porw")
    except metadata.PackageNotFoundError:
        # Source-checkout consumption is intentional for this repository test.
        pass
    else:
        if installed_version != REQUIRED_PORW_VERSION:
            raise pytest.UsageError(
                "installed aigg-porw metadata version mismatch: "
                f"expected {REQUIRED_PORW_VERSION}, found {installed_version}"
            )


_require_checkout_package()


def pytest_configure() -> None:
    actual = platform.python_version()
    implementation = platform.python_implementation()
    if implementation != "CPython" or actual != REQUIRED_PYTHON:
        raise pytest.UsageError(
            f"Triton PoRW tests require CPython {REQUIRED_PYTHON}; "
            f"found {implementation} {actual}"
        )
