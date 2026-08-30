"""Executable installed-wheel and release-workflow regression gates."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast

import pytest
import yaml  # type: ignore[import-untyped]

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/conformance.yml"
EXPECTED_UV_VERSION = "0.11.16"
EXPECTED_SETUP_PYTHON_SHA = "e797f83bcb11b83ae66e0230d6156d7c80228e7c"
EXPECTED_SETUP_UV_SHA = "c771a70e6277c0a99b617c7a806ffedaca235ff9"
REQUIRED_KERNELS = {
    "test_sweep_kernel_matches_reference",
    "test_sweep_kernel_coverage_subset",
    "test_sweep_wrapper_rejects_invalid_tile_ids_before_launch",
    "test_sweep_internal_full_coverage_skips_caller_validation",
    "test_sweep_empty_external_coverage_returns_uint32_without_launch",
    "test_moe_kernel_gemm_correct",
    "test_moe_kernel_sketch_matches_spec",
    "test_moe_kernel_batch_invariance",
    "test_fused_equals_sweep_on_covered_tiles",
    "test_prepared_moe_launch_matches_reference_and_reuses_outputs",
    "test_prepared_sweep_launch_matches_reference_and_reuses_output",
}


def _run(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
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
    return completed


def _workflow(source: str | None = None) -> Mapping[str, Any]:
    loaded = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8") if source is None else source)
    assert isinstance(loaded, Mapping)
    return cast(Mapping[str, Any], loaded)


def _steps(source: str | None = None) -> list[Mapping[str, Any]]:
    workflow = _workflow(source)
    jobs = workflow.get("jobs")
    assert isinstance(jobs, Mapping)
    conformance = jobs.get("conformance")
    assert isinstance(conformance, Mapping)
    steps = conformance.get("steps")
    assert isinstance(steps, list)
    assert all(isinstance(step, Mapping) for step in steps)
    return cast(list[Mapping[str, Any]], steps)


def _named_step(name: str, source: str | None = None) -> Mapping[str, Any]:
    matching = [step for step in _steps(source) if step.get("name") == name]
    assert len(matching) == 1, f"expected exactly one active workflow step named {name!r}"
    return matching[0]


def _action_step(prefix: str, source: str | None = None) -> Mapping[str, Any]:
    matching = [
        step
        for step in _steps(source)
        if isinstance(step.get("uses"), str) and str(step["uses"]).startswith(prefix)
    ]
    assert len(matching) == 1, f"expected exactly one active action step for {prefix!r}"
    return matching[0]


def _active_invocation(run: str, executable: str, argument: str) -> bool:
    logical = re.sub(r"\\\n\s*", " ", run)
    suffix = rf"\s+{re.escape(argument)}" if argument else ""
    pattern = rf"(?m)^\s*{re.escape(executable)}{suffix}(?:\s|$)"
    return re.search(pattern, logical) is not None


def _validate_release_contract(source: str) -> None:
    setup_python = _action_step("actions/setup-python@", source)
    assert setup_python["uses"] == f"actions/setup-python@{EXPECTED_SETUP_PYTHON_SHA}"
    python_inputs = setup_python.get("with")
    assert isinstance(python_inputs, Mapping)
    assert python_inputs.get("python-version") == "3.12.13"
    assert python_inputs.get("check-latest") is False

    setup_uv = _action_step("astral-sh/setup-uv@", source)
    assert setup_uv["uses"] == f"astral-sh/setup-uv@{EXPECTED_SETUP_UV_SHA}"
    uv_inputs = setup_uv.get("with")
    assert isinstance(uv_inputs, Mapping)
    assert uv_inputs.get("version") == EXPECTED_UV_VERSION

    package_gate = _named_step("Test, type-check, and build the locked Python package", source)
    package_run = package_gate.get("run")
    assert package_gate.get("working-directory") == "packages/python"
    assert isinstance(package_run, str)
    for executable, argument in (
        ("uv", "sync --frozen --extra dev"),
        ("uv", "run --frozen ruff check ."),
        ("uv", "run --frozen ruff format --check ."),
        (
            "uv",
            "run --frozen mypy src tests scripts "
            + "../../scripts/check_triton_interpreter_report.py",
        ),
        ("uv", "run --frozen pytest -q"),
        ("UV_OFFLINE=1", "uv build --offline --no-build-isolation"),
    ):
        assert _active_invocation(package_run, executable, argument)

    rust_gate = _named_step("Test the Rust workspace and feature boundaries", source)
    rust_run = rust_gate.get("run")
    assert isinstance(rust_run, str)
    for argument in (
        "test --workspace --locked",
        "test -p aigg-porw-core --locked",
        "test -p aigg-porw-core --features scale --locked",
        "check -p aigg-porw-core --no-default-features --locked",
    ):
        assert _active_invocation(rust_run, "cargo", argument)

    smoke = _named_step("Smoke-test the exact wheel outside the checkout", source)
    smoke_run = smoke.get("run")
    assert smoke.get("working-directory") == "packages/python"
    assert isinstance(smoke_run, str)
    assert _active_invocation(
        smoke_run,
        ".venv/bin/python",
        "scripts/smoke_installed_wheel.py",
    )
    assert "${RUNNER_TEMP:?}" in smoke_run
    assert '--source-checkout "$GITHUB_WORKSPACE"' in smoke_run
    assert "../../spec-cache/conformance/porw/sketch-tile-v2.json" in smoke_run

    triton = _named_step("Run Python and mandatory Triton interpreter conformance", source)
    triton_run = triton.get("run")
    assert isinstance(triton_run, str)
    assert _active_invocation(triton_run, "python", "-m pytest")
    assert _active_invocation(
        triton_run,
        "python",
        "-B scripts/check_triton_interpreter_report.py",
    )

    source_gate = _named_step("Enforce the single Python proof implementation", source)
    source_run = source_gate.get("run")
    assert isinstance(source_run, str)
    assert _active_invocation(source_run, "./scripts/test-python-source-tree.sh", "")
    assert _active_invocation(source_run, "./scripts/check-python-source-tree.sh", "")


def _copy_archive_like_checkout(destination: Path) -> None:
    completed = _run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=REPO_ROOT,
    )
    for relative_text in completed.stdout.split("\0"):
        if not relative_text:
            continue
        relative = Path(relative_text)
        source = REPO_ROOT / relative
        if source.is_dir():
            # A gitlink is an archive entry but this package-only harness does
            # not need the checked-out forge-std directory.
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


@pytest.fixture(scope="module")
def archive_checkout(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("porw-archive") / "checkout"
    root.mkdir()
    _copy_archive_like_checkout(root)
    uv = shutil.which("uv")
    assert uv is not None
    environment = dict(os.environ, UV_OFFLINE="1")
    package = root / "packages/python"
    _run([uv, "sync", "--frozen", "--extra", "dev"], cwd=package, environment=environment)
    _run(
        [uv, "build", "--offline", "--no-build-isolation"],
        cwd=package,
        environment=environment,
    )
    return root


def _workflow_environment(tmp_path: Path, checkout: Path) -> dict[str, str]:
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir(parents=True)
    return dict(
        os.environ,
        GITHUB_WORKSPACE=str(checkout),
        RUNNER_TEMP=str(runner_temp),
        UV_OFFLINE="1",
    )


def _write_junit(path: Path, *, skipped: int) -> None:
    cases = "".join(
        f'<testcase classname="gate" name="{name}">'
        + ("<skipped/>" if skipped and index == 0 else "")
        + "</testcase>"
        for index, name in enumerate(sorted(REQUIRED_KERNELS))
    )
    path.write_text(
        f'<testsuite tests="{len(REQUIRED_KERNELS)}" skipped="{skipped}" '
        f'failures="0" errors="0">{cases}</testsuite>',
        encoding="utf-8",
    )


def _fake_python(directory: Path, junit: Path) -> Path:
    executable = directory / "python"
    executable.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        'if [ "${1:-}" = -m ] && [ "${2:-}" = pytest ]; then\n'
        '  for argument in "$@"; do\n'
        '    case "$argument" in\n'
        '      --junitxml=*) cp -- "$FAKE_JUNIT" "${argument#--junitxml=}" ;;\n'
        "    esac\n"
        "  done\n"
        "  exit 0\n"
        "fi\n"
        'exec "$REAL_PYTHON" "$@"\n',
        encoding="utf-8",
    )
    executable.chmod(0o755)
    assert junit.is_file()
    return executable


def test_workflow_contract_is_structural_and_actions_are_full_sha_pinned() -> None:
    source = WORKFLOW_PATH.read_text(encoding="utf-8")
    _validate_release_contract(source)

    for workflow_path in sorted((REPO_ROOT / ".github/workflows").glob("*.yml")):
        loaded = _workflow(workflow_path.read_text(encoding="utf-8"))
        jobs = loaded.get("jobs")
        assert isinstance(jobs, Mapping)
        for job in jobs.values():
            assert isinstance(job, Mapping)
            steps = job.get("steps")
            assert isinstance(steps, list)
            for step in steps:
                assert isinstance(step, Mapping)
                uses = step.get("uses")
                if uses is not None:
                    assert isinstance(uses, str)
                    assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", uses)


def _remove_uv_version(source: str) -> str:
    return source.replace("          version: 0.11.16\n", "", 1)


def _comment_smoke_invocation(source: str) -> str:
    return source.replace(
        "          .venv/bin/python scripts/smoke_installed_wheel.py \\\n",
        "          # .venv/bin/python scripts/smoke_installed_wheel.py \\\n",
        1,
    )


def _comment_zero_skip_invocation(source: str) -> str:
    return source.replace(
        '          python -B scripts/check_triton_interpreter_report.py "$report"\n',
        '          # python -B scripts/check_triton_interpreter_report.py "$report"\n',
        1,
    )


def _misnest_uv_inputs(source: str) -> str:
    return source.replace(
        "        with:\n          version: 0.11.16\n          enable-cache: false\n",
        "      - with:\n          version: 0.11.16\n          enable-cache: false\n",
        1,
    )


@pytest.mark.parametrize(
    "mutation",
    [
        _remove_uv_version,
        _comment_smoke_invocation,
        _comment_zero_skip_invocation,
        _misnest_uv_inputs,
    ],
)
def test_release_contract_rejects_omissions_comments_and_wrong_nesting(
    mutation: Callable[[str], str],
) -> None:
    source = WORKFLOW_PATH.read_text(encoding="utf-8")
    mutated = mutation(source)
    assert mutated != source
    with pytest.raises((AssertionError, yaml.YAMLError)):
        _validate_release_contract(mutated)


def test_exact_workflow_smoke_block_succeeds_in_archive_checkout(
    archive_checkout: Path,
    tmp_path: Path,
) -> None:
    step = _named_step("Smoke-test the exact wheel outside the checkout")
    run = step.get("run")
    assert isinstance(run, str)
    environment = _workflow_environment(tmp_path, archive_checkout)
    completed = _run(
        ["bash", "-euo", "pipefail", "-c", run],
        cwd=archive_checkout / "packages/python",
        environment=environment,
    )
    assert "installed-wheel smoke: passed" in completed.stdout
    assert not any(Path(environment["RUNNER_TEMP"]).iterdir())


def test_wheel_smoke_rejects_direct_in_checkout_vector(
    archive_checkout: Path,
    tmp_path: Path,
) -> None:
    package = archive_checkout / "packages/python"
    wheel = next((package / "dist").glob("aigg_porw-0.2.0.dev1+research-*.whl"))
    uv = shutil.which("uv")
    assert uv is not None
    completed = subprocess.run(
        [
            str(package / ".venv/bin/python"),
            str(package / "scripts/smoke_installed_wheel.py"),
            "--uv",
            uv,
            "--wheel",
            str(wheel),
            "--vector",
            str(archive_checkout / "spec-cache/conformance/porw/sketch-tile-v2.json"),
            "--source-checkout",
            str(archive_checkout),
        ],
        cwd=tmp_path,
        env=dict(os.environ, UV_OFFLINE="1"),
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "installed package tried to read source checkout" in completed.stderr


@pytest.mark.parametrize("skipped,expected_returncode", [(0, 0), (1, 1)])
def test_exact_workflow_triton_block_enforces_zero_skips_after_pytest_success(
    archive_checkout: Path,
    tmp_path: Path,
    skipped: int,
    expected_returncode: int,
) -> None:
    step = _named_step("Run Python and mandatory Triton interpreter conformance")
    run = step.get("run")
    assert isinstance(run, str)
    junit = tmp_path / "controlled.xml"
    _write_junit(junit, skipped=skipped)
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    _fake_python(fake_bin, junit)
    environment = _workflow_environment(tmp_path / "environment", archive_checkout)
    environment.update(
        FAKE_JUNIT=str(junit),
        REAL_PYTHON=sys.executable,
        PATH=f"{fake_bin}{os.pathsep}{environment['PATH']}",
    )
    completed = subprocess.run(
        ["bash", "-euo", "pipefail", "-c", run],
        cwd=archive_checkout,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if expected_returncode == 0:
        assert completed.returncode == 0, completed.stderr
        assert "with zero skips" in completed.stdout
    else:
        assert completed.returncode != 0
        assert "skipped=1" in completed.stderr


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
