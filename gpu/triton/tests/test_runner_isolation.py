"""Isolation and fail-closed guards for GPU benchmark evidence."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNNER = REPO_ROOT / "gpu/triton/run_gpu_bench.sh"
IMPORT_PROBE = REPO_ROOT / "gpu/triton/verify_checkout_imports.py"


def test_runner_uses_isolated_repo_imports_and_never_appends_ambient_paths() -> None:
    source = RUNNER.read_text(encoding="utf-8")
    assert "PYTHONNOUSERSITE=1" in source
    assert "${PYTHONPATH:+" not in source
    assert '"$PORW_PYTHON_BIN" -B -I "$PORW_IMPORT_PROBE"' in source
    assert 'cd -- "$PORW_REPO_ROOT"' in source
    assert "verify_checkout_imports.py" in source
    assert source.index("nvidia-smi is unavailable") < source.index(
        'PORW_OUTPUT_FILE="$(mktemp'
    )


def test_checkout_probe_ignores_hostile_pythonpath_cwd_and_user_site(
    tmp_path: Path,
) -> None:
    hostile_path = tmp_path / "hostile-path"
    hostile_user = tmp_path / "hostile-user"
    hostile_cwd = tmp_path / "hostile-cwd"
    for root in (hostile_path, hostile_user, hostile_cwd):
        for package in ("aigg_porw", "porw_sketch"):
            directory = root / package
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "__init__.py").write_text(
                "raise RuntimeError('hostile import selected')\n",
                encoding="utf-8",
            )

    environment = dict(
        os.environ,
        PYTHONPATH=str(hostile_path),
        PYTHONUSERBASE=str(hostile_user),
        PYTHONNOUSERSITE="0",
    )
    result = subprocess.run(
        [sys.executable, "-I", str(IMPORT_PROBE), str(REPO_ROOT)],
        cwd=hostile_cwd,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "aigg-porw checkout import probe: passed" in result.stdout
    assert "NumPy 2.0.2" in result.stdout
    assert str((REPO_ROOT / "packages/python/src/aigg_porw").resolve()) in result.stdout
    assert str((REPO_ROOT / "gpu/triton/porw_sketch").resolve()) in result.stdout

    isolated_repo = tmp_path / "clean-checkout"
    for relative in (
        "packages/python/src/aigg_porw",
        "gpu/triton/porw_sketch",
        "spec-cache/conformance/porw",
    ):
        shutil.copytree(REPO_ROOT / relative, isolated_repo / relative)
    for relative in (
        "packages/python/pyproject.toml",
        "gpu/triton/run_gpu_bench.sh",
        "gpu/triton/verify_checkout_imports.py",
    ):
        destination = isolated_repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, destination)
    (isolated_repo / "benchmarks/gpu").mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=isolated_repo, check=True)
    subprocess.run(["git", "add", "."], cwd=isolated_repo, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=PoRW Test",
            "-c",
            "user.email=porw-test@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
        cwd=isolated_repo,
        check=True,
    )
    runner_environment = dict(
        environment,
        PATH="/usr/bin:/bin",
        PORW_PYTHON=sys.executable,
        TRITON_INTERPRET="0",
    )
    runner_result = subprocess.run(
        [str(isolated_repo / "gpu/triton/run_gpu_bench.sh")],
        cwd=hostile_cwd,
        env=runner_environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert runner_result.returncode != 0
    assert "nvidia-smi is unavailable" in runner_result.stderr
    generated = isolated_repo / "benchmarks/gpu/generated"
    assert not generated.exists() or list(generated.iterdir()) == []
