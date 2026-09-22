"""Install one exact wheel in an empty venv and reproduce a caller vector."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

EXPECTED_VERSION = "0.2.0.dev1+research"

_CHILD = r"""
import importlib.metadata
import json
import sys
from pathlib import Path

source_checkout = Path(sys.argv[1]).resolve(strict=True)
vector_path = Path(sys.argv[2]).resolve(strict=True)
environment_root = Path(sys.prefix).resolve(strict=True)


def beneath(path, parent):
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def deny_checkout_reads(event, arguments):
    if event != "open" or not arguments:
        return
    candidate = arguments[0]
    if not isinstance(candidate, (str, bytes)):
        return
    try:
        resolved = Path(candidate).resolve(strict=False)
    except (OSError, TypeError, ValueError):
        return
    if beneath(resolved, source_checkout):
        raise RuntimeError(f"installed package tried to read source checkout: {resolved}")


sys.addaudithook(deny_checkout_reads)

import numpy as np
from aigg_porw import SCHEME_ID, TILE_BYTES, sketch_tiles

distribution = importlib.metadata.distribution("aigg-porw")
if distribution.version != "0.2.0.dev1+research":
    raise SystemExit(f"unexpected installed version: {distribution.version}")
module_file = Path(sys.modules["aigg_porw"].__file__).resolve(strict=True)
if not beneath(module_file, environment_root):
    raise SystemExit(f"aigg_porw imported outside the empty venv: {module_file}")
packaged_paths = [str(path) for path in distribution.files or ()]
if any("spec-cache" in path or path.endswith("sketch-tile-v2.json") for path in packaged_paths):
    raise SystemExit("the wheel must not embed the private conformance cache")

vector = json.loads(vector_path.read_text(encoding="utf-8"))
if SCHEME_ID != vector["scheme"]["id"]:
    raise SystemExit("installed scheme ID disagrees with the caller vector")
length = int(vector["reference_buffer"]["n_tiles"]) * TILE_BYTES
buffer = bytes(
    ((((index * 2654435761) & ((1 << 64) - 1)) >> 7) & 0xFF)
    for index in range(length)
)
array = np.frombuffer(buffer, dtype=np.uint8)
for case in vector["sketches"]:
    actual = sketch_tiles(case["slot_seed"], array)
    if actual.tolist() != case["per_tile"]:
        raise SystemExit(f"locked vector mismatch for slot seed {case['slot_seed']}")
print(
    "installed-wheel smoke: passed; "
    f"version={distribution.version}; module={module_file}; vector={vector_path}"
)
"""


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv", required=True, type=Path)
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--vector", required=True, type=Path)
    parser.add_argument("--locked-project", required=True, type=Path)
    parser.add_argument("--source-checkout", required=True, type=Path)
    return parser.parse_args()


def _regular_file(path: Path, description: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"{description} must be a regular file: {path}")
    return path.resolve(strict=True)


def _run(command: list[str], *, environment: dict[str, str], cwd: Path) -> None:
    subprocess.run(command, check=True, env=environment, cwd=cwd)


def main() -> None:
    arguments = _arguments()
    if sys.version_info[:2] != (3, 12):
        raise SystemExit(f"CPython 3.12 required, found {sys.version.split()[0]}")

    uv = _regular_file(arguments.uv, "uv executable")
    wheel = _regular_file(arguments.wheel, "wheel")
    vector = _regular_file(arguments.vector, "caller vector")
    checkout = arguments.source_checkout.resolve(strict=True)
    locked_project = arguments.locked_project
    if locked_project.is_symlink() or not locked_project.is_dir():
        raise SystemExit(f"locked project must be a regular directory: {locked_project}")
    locked_project = locked_project.resolve(strict=True)
    if locked_project != checkout / "packages/python":
        raise SystemExit("locked project must be the package directory in source checkout")
    _regular_file(locked_project / "pyproject.toml", "locked project metadata")
    _regular_file(locked_project / "uv.lock", "locked project lock")
    expected_prefix = f"aigg_porw-{EXPECTED_VERSION}-"
    if not wheel.name.startswith(expected_prefix) or wheel.suffix != ".whl":
        raise SystemExit(f"unexpected wheel identity: {wheel.name}")

    environment = dict(os.environ)
    for name in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE"):
        environment.pop(name, None)
    environment.update(
        PIP_DISABLE_PIP_VERSION_CHECK="1",
        PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1",
        UV_OFFLINE="1",
    )

    with tempfile.TemporaryDirectory(prefix="aigg-porw-wheel-smoke-") as temporary:
        root = Path(temporary).resolve(strict=True)
        try:
            root.relative_to(checkout)
        except ValueError:
            pass
        else:
            raise SystemExit("wheel smoke environment must be outside the source checkout")
        environment_path = root / "venv"
        environment["UV_PROJECT_ENVIRONMENT"] = str(environment_path)
        _run(
            [
                str(uv),
                "sync",
                "--project",
                str(locked_project),
                "--python",
                sys.executable,
                "--frozen",
                "--offline",
                "--no-dev",
                "--no-install-project",
            ],
            environment=environment,
            cwd=root,
        )
        python = environment_path / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        _run(
            [
                str(uv),
                "pip",
                "install",
                "--offline",
                "--no-deps",
                "--python",
                str(python),
                str(wheel),
            ],
            environment=environment,
            cwd=root,
        )
        _run(
            [
                str(python),
                "-B",
                "-I",
                "-c",
                _CHILD,
                str(checkout),
                str(vector),
            ],
            environment=environment,
            cwd=root,
        )


if __name__ == "__main__":
    main()
