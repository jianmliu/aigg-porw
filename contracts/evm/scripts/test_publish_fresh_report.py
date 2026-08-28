#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parents[2]
PUBLISHER = SCRIPTS_DIR / "publish-fresh-report.py"
RUNNER = SCRIPTS_DIR / "run-anvil-benchmark.sh"
GENERATED_ROOT = REPO_ROOT / "benchmarks" / "evm" / "generated"


def load_publisher():
    if not PUBLISHER.is_file():
        raise AssertionError(f"publisher is missing: {PUBLISHER}")
    spec = importlib.util.spec_from_file_location("publish_fresh_report", PUBLISHER)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load fresh-report publisher")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PublishFreshReportTest(unittest.TestCase):
    def setUp(self) -> None:
        GENERATED_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=GENERATED_ROOT)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.json"
        self.source.write_text(json.dumps({"fresh": True}) + "\n", encoding="utf-8")
        self.target = self.root / "artifact.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_atomically_publishes_exact_fresh_json(self) -> None:
        module = load_publisher()
        module.publish_json_atomic(self.source, self.target, GENERATED_ROOT)
        self.assertEqual(self.target.read_bytes(), self.source.read_bytes())

    def test_rejects_target_outside_generated_root(self) -> None:
        module = load_publisher()
        outside = REPO_ROOT / "benchmarks" / "evm" / "unsafe.json"
        with self.assertRaisesRegex(ValueError, "inside the generated benchmark root"):
            module.publish_json_atomic(self.source, outside, GENERATED_ROOT)
        self.assertFalse(outside.exists())

    def test_rejects_existing_target_without_overwriting(self) -> None:
        module = load_publisher()
        self.target.write_text("preserve me", encoding="utf-8")
        with self.assertRaisesRegex(FileExistsError, "already exists"):
            module.publish_json_atomic(self.source, self.target, GENERATED_ROOT)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "preserve me")

    def test_rejects_symlink_target_without_touching_victim(self) -> None:
        module = load_publisher()
        victim = self.root / "victim.json"
        victim.write_text("preserve me", encoding="utf-8")
        self.target.symlink_to(victim)
        with self.assertRaisesRegex(ValueError, "symlink"):
            module.publish_json_atomic(self.source, self.target, GENERATED_ROOT)
        self.assertEqual(victim.read_text(encoding="utf-8"), "preserve me")

    def test_rejects_symlink_parent_even_when_it_points_inside_root(self) -> None:
        module = load_publisher()
        real_parent = self.root / "real-parent"
        real_parent.mkdir()
        linked_parent = self.root / "linked-parent"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        target = linked_parent / "artifact.json"
        with self.assertRaisesRegex(ValueError, "symlink"):
            module.publish_json_atomic(self.source, target, GENERATED_ROOT)
        self.assertFalse((real_parent / "artifact.json").exists())

    def test_rejects_invalid_json_without_publishing(self) -> None:
        module = load_publisher()
        self.source.write_text("not json", encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            module.publish_json_atomic(self.source, self.target, GENERATED_ROOT)
        self.assertFalse(self.target.exists())

    def test_atomic_link_failure_leaves_no_target_or_temporary_file(self) -> None:
        module = load_publisher()
        with mock.patch.object(module.os, "link", side_effect=OSError("injected")):
            with self.assertRaisesRegex(OSError, "injected"):
                module.publish_json_atomic(self.source, self.target, GENERATED_ROOT)
        self.assertFalse(self.target.exists())
        self.assertEqual(
            [path for path in self.root.iterdir() if path.name.startswith(".fresh-")],
            [],
        )


class RunnerFreshOutputContractTest(unittest.TestCase):
    def setUp(self) -> None:
        GENERATED_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=GENERATED_ROOT)
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_runner(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(RUNNER), *arguments],
            text=True,
            capture_output=True,
        )

    def test_fresh_output_requires_check_mode(self) -> None:
        result = self.run_runner("--fresh-output", str(self.root / "fresh.json"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --check-committed", result.stderr)

    def test_rejects_fresh_output_outside_generated_root(self) -> None:
        result = self.run_runner(
            "--check-committed",
            "--fresh-output",
            str(REPO_ROOT / "benchmarks" / "evm" / "unsafe.json"),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inside benchmarks/evm/generated", result.stderr)

    def test_rejects_symlink_fresh_output_before_running_benchmark(self) -> None:
        victim = self.root / "victim.json"
        victim.write_text("preserve me", encoding="utf-8")
        target = self.root / "fresh.json"
        target.symlink_to(victim)
        result = self.run_runner(
            "--check-committed", "--fresh-output", str(target)
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr)
        self.assertEqual(victim.read_text(encoding="utf-8"), "preserve me")


if __name__ == "__main__":
    unittest.main()
