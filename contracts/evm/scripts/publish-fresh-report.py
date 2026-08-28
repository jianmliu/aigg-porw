#!/usr/bin/env python3
"""Safely publish a verified fresh benchmark report for CI artifact upload."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


def _resolved_generated_root(allowed_root: Path) -> Path:
    if not allowed_root.is_absolute():
        raise ValueError("generated benchmark root must be absolute")
    if allowed_root.is_symlink():
        raise ValueError("generated benchmark root must not be a symlink")
    resolved = allowed_root.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("generated benchmark root must be a directory")
    if resolved != allowed_root:
        raise ValueError("generated benchmark root must be a physical path")
    return resolved


def validate_target(target: Path, allowed_root: Path) -> Path:
    root = _resolved_generated_root(allowed_root)
    if not target.is_absolute():
        raise ValueError("fresh output target must be absolute")
    if target.is_symlink():
        raise ValueError("fresh output target must not be a symlink")
    if target.exists():
        raise FileExistsError(f"fresh output target already exists: {target}")

    try:
        relative_parent = target.parent.relative_to(root)
    except ValueError as error:
        raise ValueError(
            "fresh output target must be inside the generated benchmark root"
        ) from error

    current = root
    for component in relative_parent.parts:
        current = current / component
        if current.is_symlink():
            raise ValueError("fresh output parent must not contain a symlink")
        if not current.is_dir():
            raise ValueError("fresh output parent must already be a directory")

    resolved_parent = target.parent.resolve(strict=True)
    try:
        resolved_parent.relative_to(root)
    except ValueError as error:
        raise ValueError(
            "fresh output target must be inside the generated benchmark root"
        ) from error
    return target


def publish_json_atomic(source: Path, target: Path, allowed_root: Path) -> None:
    target = validate_target(target, allowed_root)
    if source.is_symlink() or not source.is_file():
        raise ValueError("fresh benchmark source must be a regular non-symlink file")

    payload = source.read_bytes()
    document = json.loads(payload)
    if not isinstance(document, dict):
        raise ValueError("fresh benchmark source must contain a JSON object")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".fresh-anvil.", suffix=".json", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        if temporary.read_bytes() != payload:
            raise OSError("fresh benchmark temporary copy did not verify")

        # A hard link publishes atomically and refuses to replace a target that
        # appears after the preflight check.
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allowed-root", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--validate-target-only", action="store_true")
    arguments = parser.parse_args()

    try:
        if arguments.validate_target_only:
            if arguments.source is not None:
                parser.error("--source is incompatible with --validate-target-only")
            validate_target(arguments.target, arguments.allowed_root)
        else:
            if arguments.source is None:
                parser.error("--source is required when publishing")
            publish_json_atomic(
                arguments.source, arguments.target, arguments.allowed_root
            )
    except (FileExistsError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"refusing fresh benchmark publication: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
