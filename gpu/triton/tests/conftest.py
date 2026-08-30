"""Pytest startup gates for the reproducible Triton PoRW environment."""

import platform
import sys
from pathlib import Path

import pytest

REQUIRED_PYTHON = "3.12.13"
REPO_ROOT = Path(__file__).resolve().parents[3]
TRITON_SOURCE = (REPO_ROOT / "gpu/triton").resolve()


def _verify_exact_checkout() -> None:
    # Resolve the verifier from the exact checkout before either package.
    sys.path.insert(0, str(TRITON_SOURCE))
    from verify_checkout_imports import verify_checkout

    verify_checkout(REPO_ROOT)


_verify_exact_checkout()


def pytest_configure() -> None:
    actual = platform.python_version()
    implementation = platform.python_implementation()
    if implementation != "CPython" or actual != REQUIRED_PYTHON:
        raise pytest.UsageError(
            f"Triton PoRW tests require CPython {REQUIRED_PYTHON}; "
            f"found {implementation} {actual}"
        )
