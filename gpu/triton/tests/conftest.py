"""Pytest startup gates for the reproducible Triton PoRW environment."""

import platform

import pytest


REQUIRED_PYTHON = "3.12.13"


def pytest_configure():
    actual = platform.python_version()
    implementation = platform.python_implementation()
    if implementation != "CPython" or actual != REQUIRED_PYTHON:
        raise pytest.UsageError(
            f"Triton PoRW tests require CPython {REQUIRED_PYTHON}; "
            f"found {implementation} {actual}"
        )
