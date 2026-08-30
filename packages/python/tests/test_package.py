"""Installed-wheel and release-workflow regression gates."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
VECTOR_PATH = REPO_ROOT / "spec-cache/conformance/porw/sketch-tile-v2.json"
SMOKE_RUNNER = PACKAGE_ROOT / "scripts/smoke_installed_wheel.py"
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/conformance.yml"


def _run(command: list[str], *, cwd: Path, environment: dict[str, str] | None = None) -> None:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, (
        f"command failed ({completed.returncode}): {command!r}\n"
        f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
    )


def test_wheel_installs_outside_checkout_and_reproduces_caller_vector(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    assert uv is not None
    assert SMOKE_RUNNER.is_file(), "the installed-wheel smoke runner is required"

    build_directory = tmp_path / "artifacts"
    environment = dict(os.environ, UV_OFFLINE="1")
    _run(
        [
            uv,
            "build",
            "--offline",
            "--no-build-isolation",
            "--wheel",
            "--out-dir",
            str(build_directory),
        ],
        cwd=PACKAGE_ROOT,
        environment=environment,
    )
    wheels = list(build_directory.glob("aigg_porw-0.2.0.dev1+research-*.whl"))
    assert len(wheels) == 1

    external_vector = tmp_path / "caller-vector.json"
    external_vector.write_bytes(VECTOR_PATH.read_bytes())
    _run(
        [
            sys.executable,
            str(SMOKE_RUNNER),
            "--uv",
            uv,
            "--wheel",
            str(wheels[0]),
            "--vector",
            str(external_vector),
            "--source-checkout",
            str(REPO_ROOT),
        ],
        cwd=tmp_path,
        environment=environment,
    )


def test_release_workflow_keeps_every_action_and_release_gate_pinned() -> None:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    workflow_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((REPO_ROOT / ".github/workflows").glob("*.yml"))
    )
    action_refs = re.findall(r"^\s*uses:\s*[^@\s]+@([^\s#]+)", workflow_sources, re.MULTILINE)
    assert action_refs
    assert all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_refs)

    required_fragments = (
        "python-version: 3.12.13",
        "astral-sh/setup-uv@",
        "uv sync --frozen --extra dev",
        "uv run --frozen ruff check .",
        "uv run --frozen ruff format --check .",
        "uv run --frozen mypy src tests",
        "uv run --frozen pytest -q",
        "UV_OFFLINE=1 uv build --offline --no-build-isolation",
        "smoke_installed_wheel.py",
        "./scripts/test-python-source-tree.sh",
        "./scripts/check-python-source-tree.sh",
        "cargo test --workspace --locked",
        "cargo test -p aigg-porw-core --features scale --locked",
        "cargo check -p aigg-porw-core --no-default-features --locked",
        "skipped or failures or errors or missing",
    )
    for fragment in required_fragments:
        assert fragment in workflow, f"release workflow omits: {fragment}"


def test_release_documents_preserve_unpublished_research_boundaries() -> None:
    documents = "\n".join(
        (REPO_ROOT / path).read_text(encoding="utf-8")
        for path in ("README.md", "RELEASE.md", "SECURITY.md", "compatibility.json")
    )
    for fragment in (
        "aigg-porw",
        "0.2.0.dev1+research",
        "v0.2.0-research.1",
        "unpublished",
        "numpy>=2.0,<3",
        "NO_FRAUD",
        "one challenge verdict",
        "inference execution",
        "universal residency",
        "Worker eligibility",
        "capacity",
        "economic entitlement",
        "financial entitlement",
        "ephemeral",
        "non-credential",
        "locally",
    ):
        assert fragment in documents, f"release documentation omits: {fragment}"
