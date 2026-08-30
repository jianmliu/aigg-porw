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


def _require_exact_commands(run: str, expected: tuple[str, ...]) -> None:
    commands = _effective_commands(run)
    assert commands
    assert commands[0] == "set -euo pipefail"
    assert commands.count("set -euo pipefail") == 1
    assert not any(
        command.startswith(("set +", "set -e +", "set -u +"))
        or command in {"set +e", "set +u", "set +o pipefail"}
        for command in commands[1:]
    )
    for required in expected:
        assert commands.count(required) == 1, f"missing exact active command: {required}"

    protected = "cargo|cp|git|python|python3|rustc|rustup|test|uv"
    override = re.compile(
        rf"^(?:alias\s+(?:{protected})=|function\s+(?:{protected})(?:\s|\()|"
        rf"(?:{protected})\s*\(\s*\)\s*\{{)"
    )
    assert not any(override.search(command) for command in commands)


def _validate_release_contract(source: str) -> None:
    for step in _steps(source):
        run = step.get("run")
        if run is not None:
            assert isinstance(run, str)
            commands = _effective_commands(run)
            assert commands and commands[0] == "set -euo pipefail"

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
    _require_exact_commands(
        package_run,
        (
            "uv sync --frozen --extra dev",
            "uv run --frozen ruff check .",
            "uv run --frozen ruff format --check .",
            "uv run --frozen mypy src tests scripts "
            + "../../scripts/check_python_source_tree.py "
            + "../../scripts/check_triton_interpreter_report.py",
            "uv run --frozen pytest -q",
            "UV_OFFLINE=1 uv build --offline --no-build-isolation",
        ),
    )

    rust_gate = _named_step("Test the Rust workspace and feature boundaries", source)
    rust_run = rust_gate.get("run")
    assert isinstance(rust_run, str)
    _require_exact_commands(
        rust_run,
        (
            "cargo test --workspace --locked",
            "cargo test -p aigg-porw-core --locked",
            "cargo test -p aigg-porw-core --features scale --locked",
            "cargo check -p aigg-porw-core --no-default-features --locked",
        ),
    )

    smoke = _named_step("Smoke-test the exact wheel outside the checkout", source)
    smoke_run = smoke.get("run")
    assert smoke.get("working-directory") == "packages/python"
    assert isinstance(smoke_run, str)
    _require_exact_commands(
        smoke_run,
        (
            'cp -- ../../spec-cache/conformance/porw/sketch-tile-v2.json "$vector"',
            ".venv/bin/python scripts/smoke_installed_wheel.py "
            + '--uv "$(command -v uv)" --wheel "$wheel" --vector "$vector" '
            + '--source-checkout "$GITHUB_WORKSPACE"',
        ),
    )
    assert "${RUNNER_TEMP:?}" in smoke_run
    assert '--source-checkout "$GITHUB_WORKSPACE"' in smoke_run
    assert "../../spec-cache/conformance/porw/sketch-tile-v2.json" in smoke_run

    triton = _named_step("Run Python and mandatory Triton interpreter conformance", source)
    triton_run = triton.get("run")
    assert isinstance(triton_run, str)
    _require_exact_commands(
        triton_run,
        (
            "python -m pytest gpu/triton/tests/test_sketch.py "
            + "gpu/triton/tests/test_conformance.py "
            + "gpu/triton/tests/test_kernel_validation.py "
            + "gpu/triton/tests/test_benchmark_honesty.py "
            + '-q -rs --junitxml="$report"',
            'python -B scripts/check_triton_interpreter_report.py "$report"',
        ),
    )

    source_gate = _named_step("Enforce the single Python proof implementation", source)
    source_run = source_gate.get("run")
    assert isinstance(source_run, str)
    _require_exact_commands(
        source_run,
        ("./scripts/test-python-source-tree.sh", "./scripts/check-python-source-tree.sh"),
    )

    rust_install = _named_step("Install the pinned Rust toolchain", source)
    rust_install_run = rust_install.get("run")
    assert isinstance(rust_install_run, str)
    _require_exact_commands(
        rust_install_run,
        (
            "rustup toolchain install nightly-2025-05-31 --profile minimal "
            + "--component rustfmt --component clippy",
            "rustc --version --verbose",
            "cargo --version --verbose",
        ),
    )

    spec_lock = _named_step("Verify the canonical spec lock", source)
    spec_lock_run = spec_lock.get("run")
    assert isinstance(spec_lock_run, str)
    _require_exact_commands(spec_lock_run, ("python3 - <<'PY'",))

    linux = _named_step("Verify and install the Linux interpreter environment", source)
    linux_run = linux.get("run")
    assert isinstance(linux_run, str)
    _require_exact_commands(
        linux_run,
        (
            'test "$(uname -s)" = Linux',
            'test "$(uname -m)" = x86_64',
            "python - <<'PY'",
            "python -m pip install --require-hashes "
            + "-r gpu/triton/requirements-test-linux-x86_64.lock",
        ),
    )

    cache = _named_step("Prove the spec cache stayed read-only", source)
    cache_run = cache.get("run")
    assert isinstance(cache_run, str)
    _require_exact_commands(
        cache_run,
        (
            "git diff --exit-code -- spec-cache",
            'test -z "$(git status --porcelain --untracked-files=all -- spec-cache)"',
        ),
    )


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
