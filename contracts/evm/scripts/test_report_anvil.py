#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("report-anvil.py")
SELECTOR = "b0fac614"


class ReportAnvilTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        self.broadcast = self.root / "run-latest.json"
        self.artifact = self.root / "PorwVerifier.json"
        self.block = self.root / "block.json"
        self.vector = self.root / "vector.json"
        self.runtime_code = self.root / "runtime-code.hex"
        self.output = self.evidence / "report.json"

        create_hash = "0x" + "11" * 32
        call_hash = "0x" + "22" * 32
        address = "0x" + "33" * 20
        self.document = {
            "chain": 31337,
            "transactions": [
                {
                    "hash": create_hash,
                    "transactionType": "CREATE",
                    "contractName": "PorwVerifier",
                    "contractAddress": address,
                    "transaction": {"to": None, "input": "0x6000"},
                },
                {
                    "hash": call_hash,
                    "transactionType": "CALL",
                    "contractName": "PorwVerifier",
                    "contractAddress": address,
                    "transaction": {
                        "to": address,
                        "input": "0x" + SELECTOR + "00ff",
                    },
                },
            ],
            "receipts": [
                {
                    "transactionHash": create_hash,
                    "status": "0x1",
                    "gasUsed": "0x100",
                    "blockNumber": "0x1",
                    "contractAddress": address,
                },
                {
                    "transactionHash": call_hash,
                    "status": "0x1",
                    "gasUsed": hex(22_000),
                    "blockNumber": "0x2",
                    "to": address,
                },
            ],
        }
        self.artifact.write_text(
            json.dumps(
                {
                    "deployedBytecode": {"object": "0x6000"},
                    "metadata": {
                        "compiler": {"version": "0.8.33+commit.64118f21"},
                        "settings": {
                            "evmVersion": "london",
                            "optimizer": {"enabled": True, "runs": 200},
                            "viaIR": True,
                        },
                    },
                }
            )
        )
        self.block.write_text(json.dumps({"number": "0x2", "timestamp": "0x1234"}))
        self.vector.write_bytes(b'{"canonical":true}\n')
        self.runtime_code.write_text("0x6000\n")
        self.write_broadcast()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_broadcast(self) -> None:
        self.broadcast.write_text(json.dumps(self.document))

    def run_report(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--broadcast",
                str(self.broadcast),
                "--artifact",
                str(self.artifact),
                "--block",
                str(self.block),
                "--vector",
                str(self.vector),
                "--canonical-vector-sha256",
                hashlib.sha256(self.vector.read_bytes()).hexdigest(),
                "--runtime-code",
                str(self.runtime_code),
                "--output-root",
                str(self.evidence),
                "--output",
                str(self.output),
                "--forge-version",
                "1.7.1",
                "--forge-commit",
                "4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
                "--cast-version",
                "1.7.1",
                "--cast-commit",
                "4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
                "--anvil-version",
                "1.7.1",
                "--anvil-commit",
                "4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
            ],
            text=True,
            capture_output=True,
        )

    def test_emits_exact_calldata_and_gas_components(self) -> None:
        result = self.run_report()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.output.read_text())
        self.assertEqual(report["classification"], "proof_math_only")
        self.assertEqual(report["call"]["calldata"], {"bytes": 6, "nonzero_bytes": 5, "zero_bytes": 1})
        self.assertEqual(report["call"]["intrinsic_london_gas"], 21_084)
        self.assertEqual(report["call"]["execution_plus_memory_gas"], 916)
        self.assertEqual(report["call"]["receipt_gas_used"], 22_000)
        self.assertEqual(report["verifier"]["runtime_code_bytes"], 2)
        self.assertEqual(report["block_timestamp"], 0x1234)

    def test_rejects_ambiguous_selector_match_without_overwriting(self) -> None:
        self.output.write_text("preserve me")
        self.document["transactions"].append(dict(self.document["transactions"][1]))
        self.write_broadcast()
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_text(), "preserve me")

    def test_rejects_failed_receipt(self) -> None:
        self.document["receipts"][1]["status"] = "0x0"
        self.write_broadcast()
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_missing_selector(self) -> None:
        self.document["transactions"][1]["transaction"]["input"] = "0xdeadbeef00ff"
        self.write_broadcast()
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_receipt_below_intrinsic_gas(self) -> None:
        self.document["receipts"][1]["gasUsed"] = hex(21_083)
        self.write_broadcast()
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_runtime_code_that_differs_from_compiler_artifact(self) -> None:
        self.runtime_code.write_text("0x6001\n")
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_symlink_output(self) -> None:
        target = self.evidence / "target.json"
        target.write_text("preserve me")
        self.output.symlink_to(target)
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "preserve me")

    def test_compare_ignores_only_transaction_hashes_and_block_timestamp(self) -> None:
        first = self.evidence / "first.json"
        second = self.evidence / "second.json"
        base = {
            "block_timestamp": 1,
            "call": {"transaction_hash": "0xaaa", "receipt_gas_used": 22_000},
            "verifier": {"creation_transaction_hash": "0xbbb", "runtime_code_bytes": 2},
        }
        first.write_text(json.dumps(base))
        changed = json.loads(json.dumps(base))
        changed["block_timestamp"] = 2
        changed["call"]["transaction_hash"] = "0xccc"
        changed["verifier"]["creation_transaction_hash"] = "0xddd"
        second.write_text(json.dumps(changed))
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--compare", str(first), str(second)],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        changed["call"]["receipt_gas_used"] += 1
        second.write_text(json.dumps(changed))
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--compare", str(first), str(second)],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
