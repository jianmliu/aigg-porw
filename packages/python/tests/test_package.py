"""Executable installed-wheel and release-workflow regression gates."""

from __future__ import annotations

import hashlib
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
PINNED_RELEASE_RUN_DIGESTS = {
    "Install the pinned Rust toolchain": (
        "748c4b9b19ddba50fe7a5c4a6d575d65798177d940c1eddb67cf00f9c7785781"
    ),
    "Verify the canonical spec lock": (
        "7cf810653fdbc03974e5ab99534b7f22a9c822f2fe53d11fdc029b0d62eb98e2"
    ),
    "Test the Rust workspace and feature boundaries": (
        "ff7191b82fe2948e030109ab59afc3781e7e45234d9ac8eb1b8a71bfee264f7e"
    ),
    "Test, type-check, and build the locked Python package": (
        "090d56644ea598261ac3d47d27f501b4adcc98760f2abeae613c3ce48afdf3d8"
    ),
    "Smoke-test the exact wheel outside the checkout": (
        "7c3794d7550270206c02a2cad2df69c4069d55d28ea90d2cc0530c736d8f02e0"
    ),
    "Enforce tracked Python integration-source boundaries": (
        "a631a48f192d4adad249a61422d0e6c7bc3fd809c4d7ad74976d0619767bb040"
    ),
    "Verify and install the Linux interpreter environment": (
        "7da9c9e985d3726bc9fa43387c6138d4c3736b780dbef99f900ea5036bda27fe"
    ),
    "Run Python and mandatory Triton interpreter conformance": (
        "d0f92cd7b05661d80cb9525ddbc1a2dd498b7aacbb32fe617f3e1094f9e2388c"
    ),
    "Prove the spec cache stayed read-only": (
        "b9a325eba1727013addf238c73731d8cf9dd0c8a2d841ddc5a6f31c1518605a0"
    ),
}
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


def _workflow_paths(directory: Path) -> list[Path]:
    return sorted({*directory.glob("*.yml"), *directory.glob("*.yaml")})


def _effective_commands(run: str) -> tuple[str, ...]:
    commands: list[str] = []
    continued = ""
    for raw_line in run.splitlines():
        stripped = raw_line.strip()
        if not continued and (not stripped or stripped.startswith("#")):
            continue
        if stripped.endswith("\\"):
            continued += stripped[:-1].rstrip() + " "
            continue
        command = re.sub(r"\s+", " ", continued + stripped).strip()
        continued = ""
        if command and not command.startswith("#"):
            commands.append(command)
    assert not continued, "run block has a dangling line continuation"
    return tuple(commands)


def _normalized_run_block(run: str) -> str:
    lines = []
    for raw_line in run.replace("\r\n", "\n").replace("\r", "\n").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        lines.append(raw_line.rstrip())
    return "\n".join(lines)


def _require_pinned_run(name: str, run: str) -> None:
    commands = _effective_commands(run)
    assert commands
    assert commands[0] == "set -euo pipefail"
    normalized_run = _normalized_run_block(run).encode()
    actual_digest = hashlib.sha256(normalized_run).hexdigest()
    assert actual_digest == PINNED_RELEASE_RUN_DIGESTS[name], (
        f"normalized run block changed for {name!r}: {actual_digest}"
    )


def _validate_release_contract(source: str) -> None:
    run_steps: dict[str, str] = {}
    for step in _steps(source):
        run = step.get("run")
        if run is not None:
            assert isinstance(run, str)
            name = step.get("name")
            assert isinstance(name, str)
            assert name not in run_steps
            run_steps[name] = run
    assert set(run_steps) == set(PINNED_RELEASE_RUN_DIGESTS)
    for name, run in run_steps.items():
        _require_pinned_run(name, run)

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

    rust_gate = _named_step("Test the Rust workspace and feature boundaries", source)
    rust_run = rust_gate.get("run")
    assert isinstance(rust_run, str)

    smoke = _named_step("Smoke-test the exact wheel outside the checkout", source)
    smoke_run = smoke.get("run")
    assert smoke.get("working-directory") == "packages/python"
    assert isinstance(smoke_run, str)
    assert "${RUNNER_TEMP:?}" in smoke_run
    assert '--source-checkout "$GITHUB_WORKSPACE"' in smoke_run
    assert "../../spec-cache/conformance/porw/sketch-tile-v2.json" in smoke_run

    triton = _named_step("Run Python and mandatory Triton interpreter conformance", source)
    triton_run = triton.get("run")
    assert isinstance(triton_run, str)

    source_gate = _named_step("Enforce tracked Python integration-source boundaries", source)
    source_run = source_gate.get("run")
    assert isinstance(source_run, str)
    assert _effective_commands(source_run) == (
        "set -euo pipefail",
        "./scripts/test-python-source-tree.sh",
        "./scripts/check-python-source-tree.sh",
    )

    rust_install = _named_step("Install the pinned Rust toolchain", source)
    rust_install_run = rust_install.get("run")
    assert isinstance(rust_install_run, str)

    spec_lock = _named_step("Verify the canonical spec lock", source)
    spec_lock_run = spec_lock.get("run")
    assert isinstance(spec_lock_run, str)

    linux = _named_step("Verify and install the Linux interpreter environment", source)
    linux_run = linux.get("run")
    assert isinstance(linux_run, str)

    cache = _named_step("Prove the spec cache stayed read-only", source)
    cache_run = cache.get("run")
    assert isinstance(cache_run, str)


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

    for workflow_path in _workflow_paths(REPO_ROOT / ".github/workflows"):
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


def _delete_package_fail_fast(source: str) -> str:
    return source.replace(
        "          set -euo pipefail\n          uv sync --frozen --extra dev\n",
        "          uv sync --frozen --extra dev\n",
        1,
    )


def _weaken_pytest_with_or_true(source: str) -> str:
    return source.replace(
        "          uv run --frozen pytest -q\n",
        "          uv run --frozen pytest -q || true\n",
        1,
    )


def _weaken_rust_with_semicolon_true(source: str) -> str:
    return source.replace(
        "          cargo test --workspace --locked\n",
        "          cargo test --workspace --locked; true\n",
        1,
    )


def _mask_source_gate_with_pipeline(source: str) -> str:
    return source.replace(
        "          ./scripts/check-python-source-tree.sh\n",
        "          ./scripts/check-python-source-tree.sh | cat\n",
        1,
    )


def _background_source_gate(source: str) -> str:
    return source.replace(
        "          ./scripts/test-python-source-tree.sh\n",
        "          ./scripts/test-python-source-tree.sh &\n",
        1,
    )


def _override_uv_function(source: str) -> str:
    return source.replace(
        "          set -euo pipefail\n          uv sync --frozen --extra dev\n",
        "          set -euo pipefail\n          uv() { return 0; }\n"
        "          uv sync --frozen --extra dev\n",
        1,
    )


def _override_cargo_alias(source: str) -> str:
    return source.replace(
        "          set -euo pipefail\n          cargo test --workspace --locked\n",
        "          set -euo pipefail\n          alias cargo=true\n"
        "          cargo test --workspace --locked\n",
        1,
    )


def _inject_command_substitution(source: str) -> str:
    return source.replace(
        "          uv run --frozen pytest -q\n",
        '          uv run --frozen pytest -q "$(true)"\n',
        1,
    )


def _insert_command_at_block_start(source: str) -> str:
    return source.replace(
        "          set -euo pipefail\n          uv sync --frozen --extra dev\n",
        "          set -euo pipefail\n          exit 0\n          uv sync --frozen --extra dev\n",
        1,
    )


def _insert_assignment_in_block_middle(source: str) -> str:
    return source.replace(
        "          uv run --frozen ruff check .\n          uv run --frozen ruff format --check .\n",
        "          uv run --frozen ruff check .\n"
        "          PYTHONPATH=/tmp\n"
        "          uv run --frozen ruff format --check .\n",
        1,
    )


def _insert_command_at_block_end(source: str) -> str:
    return source.replace(
        "          UV_OFFLINE=1 uv build --offline --no-build-isolation\n\n"
        "      - name: Smoke-test the exact wheel outside the checkout\n",
        "          UV_OFFLINE=1 uv build --offline --no-build-isolation\n"
        "          exec true\n\n"
        "      - name: Smoke-test the exact wheel outside the checkout\n",
        1,
    )


def _break_heredoc_control_flow_indentation(source: str) -> str:
    return source.replace(
        "          if actual != expected:\n"
        '              raise SystemExit(f"unexpected spec lock: {actual!r}")\n',
        "          if actual != expected:\n"
        '          raise SystemExit(f"unexpected spec lock: {actual!r}")\n',
        1,
    )


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
        _delete_package_fail_fast,
        _weaken_pytest_with_or_true,
        _weaken_rust_with_semicolon_true,
        _mask_source_gate_with_pipeline,
        _background_source_gate,
        _override_uv_function,
        _override_cargo_alias,
        _inject_command_substitution,
        _insert_command_at_block_start,
        _insert_assignment_in_block_middle,
        _insert_command_at_block_end,
        _break_heredoc_control_flow_indentation,
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


@pytest.mark.parametrize(
    "injected",
    [
        "return 0",
        "source /tmp/porw-override.sh",
        ". /tmp/porw-override.sh",
        "PATH=/tmp",
        "IFS=:",
        "BASH_ENV=/tmp/porw-override.sh",
        "PYTHONPATH=/tmp",
        "env UV_OFFLINE=0 true",
        "cd /tmp",
        "trap - EXIT",
        "set +e",
        "porw_override() { true; }",
        "alias uv=true",
    ],
)
def test_release_contract_rejects_every_extra_effective_shell_construct(
    injected: str,
) -> None:
    source = WORKFLOW_PATH.read_text(encoding="utf-8")
    mutated = source.replace(
        "          set -euo pipefail\n          uv sync --frozen --extra dev\n",
        f"          set -euo pipefail\n          {injected}\n"
        "          uv sync --frozen --extra dev\n",
        1,
    )
    assert mutated != source
    with pytest.raises(AssertionError):
        _validate_release_contract(mutated)


def test_workflow_discovery_includes_yaml_extension(tmp_path: Path) -> None:
    source_directory = REPO_ROOT / ".github/workflows"
    workflow_directory = tmp_path / "workflows"
    workflow_directory.mkdir()
    for source in _workflow_paths(source_directory):
        shutil.copy2(source, workflow_directory / source.name)
    original = workflow_directory / "conformance.yml"
    renamed = workflow_directory / "conformance.yaml"
    original.rename(renamed)

    discovered = _workflow_paths(workflow_directory)
    assert renamed in discovered
    assert original not in discovered
    _validate_release_contract(renamed.read_text(encoding="utf-8"))


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


def test_exact_workflow_source_boundary_block_succeeds_in_archive_checkout(
    archive_checkout: Path,
) -> None:
    step = _named_step("Enforce tracked Python integration-source boundaries")
    run = step.get("run")
    assert isinstance(run, str)
    completed = _run(
        ["bash", "-euo", "pipefail", "-c", run],
        cwd=archive_checkout,
    )
    assert "python source-tree gate self-tests: passed" in completed.stdout
    assert "explicit PoRW AST binding invariant holds" in completed.stdout


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
