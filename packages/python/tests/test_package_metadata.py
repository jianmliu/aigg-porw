"""Distribution metadata compatibility boundaries."""

import tomllib
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def test_declared_numpy_range_includes_the_pinned_gpu_runtime() -> None:
    metadata = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = metadata["project"]["dependencies"]
    assert "numpy>=2.0,<3" in dependencies
    assert "numpy>=2.3,<3" not in dependencies
    assert "NumPy `2.0.2`" in (PACKAGE_ROOT / "README.md").read_text(encoding="utf-8")
