#!/usr/bin/env python3
"""Turn one Foundry Anvil broadcast into fail-closed benchmark evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import sys
from typing import Any


SELECTOR = "b0fac614"
CONTRACT_NAME = "PorwVerifier"
EXPECTED_CHAIN_ID = 31_337
EXPECTED_SOLC = "0.8.33+commit.64118f21"
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


class EvidenceError(ValueError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broadcast", required=True, type=Path)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--block", required=True, type=Path)
    parser.add_argument("--vector", required=True, type=Path)
    parser.add_argument("--canonical-vector-sha256", required=True)
    parser.add_argument("--runtime-code", required=True, type=Path)
    parser.add_argument("--expectations", required=True, type=Path)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    for tool in ("forge", "cast", "anvil"):
        parser.add_argument(f"--{tool}-version", required=True)
        parser.add_argument(f"--{tool}-commit", required=True)
    return parser.parse_args()


def load_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise EvidenceError(f"{label} must be a regular non-symlink file: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"invalid {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must contain a JSON object")
    return value


def parse_quantity(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise EvidenceError(f"{label} is not an integer quantity")
    if isinstance(value, int):
        if value < 0:
            raise EvidenceError(f"{label} is negative")
        return value
    if isinstance(value, str):
        try:
            parsed = int(value, 16 if value.startswith("0x") else 10)
        except ValueError as exc:
            raise EvidenceError(f"{label} is not an integer quantity") from exc
        if parsed < 0:
            raise EvidenceError(f"{label} is negative")
        return parsed
    raise EvidenceError(f"{label} is not an integer quantity")


def require_hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or HASH_RE.fullmatch(value) is None:
        raise EvidenceError(f"{label} is not a 32-byte transaction hash")
    return value.lower()


def require_address(value: Any, label: str) -> str:
    if not isinstance(value, str) or ADDRESS_RE.fullmatch(value) is None:
        raise EvidenceError(f"{label} is not a 20-byte address")
    return value.lower()


def decode_hex(value: Any, label: str) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise EvidenceError(f"{label} is not 0x-prefixed hex")
    encoded = value[2:]
    if len(encoded) % 2:
        raise EvidenceError(f"{label} has odd-length hex")
    try:
        return bytes.fromhex(encoded)
    except ValueError as exc:
        raise EvidenceError(f"{label} contains non-hex characters") from exc


def receipt_for(receipts: list[Any], tx_hash: str, label: str) -> dict[str, Any]:
    matches = [r for r in receipts if isinstance(r, dict) and str(r.get("transactionHash", "")).lower() == tx_hash]
    if len(matches) != 1:
        raise EvidenceError(f"expected exactly one {label} receipt, found {len(matches)}")
    return matches[0]


def validate_tool_version(version: str, commit: str, label: str) -> dict[str, str]:
    if VERSION_RE.fullmatch(version) is None:
        raise EvidenceError(f"invalid {label} version")
    if COMMIT_RE.fullmatch(commit) is None:
        raise EvidenceError(f"invalid {label} commit")
    return {"commit": commit, "version": version}


def validate_output(output_root: Path, output: Path) -> Path:
    if output_root.is_symlink() or not output_root.is_dir():
        raise EvidenceError("output root must be an existing non-symlink directory")
    root = output_root.resolve(strict=True)
    if output.is_symlink():
        raise EvidenceError("refusing to replace a symlink output")
    resolved_parent = output.parent.resolve(strict=True)
    try:
        resolved_parent.relative_to(root)
    except ValueError as exc:
        raise EvidenceError("output must remain below output root") from exc
    if output.name in ("", ".", ".."):
        raise EvidenceError("invalid output filename")
    return resolved_parent / output.name


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    broadcast = load_json(args.broadcast, "broadcast artifact")
    artifact = load_json(args.artifact, "contract artifact")
    block = load_json(args.block, "block artifact")
    expectations = load_json(args.expectations, "canonical expectations")
    source_manifest = load_json(args.source_manifest, "source manifest")

    if expectations.get("schema") != "aigg.porw.anvil-canonical.v1":
        raise EvidenceError("unexpected canonical expectations schema")
    if expectations.get("selector") != "0x" + SELECTOR or expectations.get("expected_verdict") != "Fraud":
        raise EvidenceError("canonical expectations do not bind the Fraud entry point")
    expected_calldata_bytes = parse_quantity(expectations.get("calldata_bytes"), "expected calldata bytes")
    expected_calldata_sha = expectations.get("calldata_sha256")
    expected_runtime_bytes = parse_quantity(expectations.get("runtime_code_bytes"), "expected runtime bytes")
    expected_runtime_sha = expectations.get("runtime_bytecode_sha256")
    if not isinstance(expected_calldata_sha, str) or re.fullmatch(r"[0-9a-f]{64}", expected_calldata_sha) is None:
        raise EvidenceError("invalid expected calldata SHA-256")
    if not isinstance(expected_runtime_sha, str) or re.fullmatch(r"[0-9a-f]{64}", expected_runtime_sha) is None:
        raise EvidenceError("invalid expected runtime SHA-256")

    if source_manifest.get("schema") != "aigg.porw.source-manifest.v1":
        raise EvidenceError("unexpected source manifest schema")
    git_base_commit = source_manifest.get("git_base_commit")
    if not isinstance(git_base_commit, str) or COMMIT_RE.fullmatch(git_base_commit) is None:
        raise EvidenceError("invalid source-manifest Git base commit")
    if source_manifest.get("relevant_input_worktree_dirty") is not False:
        raise EvidenceError("source manifest reports dirty relevant inputs")
    source_entries = source_manifest.get("entries")
    if not isinstance(source_entries, list) or not source_entries:
        raise EvidenceError("source manifest has no entries")
    source_paths: list[str] = []
    for entry in source_entries:
        if not isinstance(entry, dict):
            raise EvidenceError("invalid source manifest entry")
        path = entry.get("path")
        digest = entry.get("sha256")
        if (
            not isinstance(path, str)
            or not path
            or path.startswith("/")
            or ".." in Path(path).parts
            or not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        ):
            raise EvidenceError("invalid source manifest entry")
        source_paths.append(path)
    if source_paths != sorted(set(source_paths)):
        raise EvidenceError("source manifest paths must be unique and sorted")

    if args.vector.is_symlink() or not args.vector.is_file():
        raise EvidenceError("canonical vector must be a regular non-symlink file")
    vector_sha = hashlib.sha256(args.vector.read_bytes()).hexdigest()
    if vector_sha != args.canonical_vector_sha256.lower():
        raise EvidenceError("canonical vector SHA-256 mismatch")
    if expectations.get("canonical_vector_sha256") != vector_sha:
        raise EvidenceError("canonical expectations bind a different conformance vector")

    chain_id = parse_quantity(broadcast.get("chain"), "broadcast chain")
    if chain_id != EXPECTED_CHAIN_ID:
        raise EvidenceError(f"unexpected chain id {chain_id}")

    transactions = broadcast.get("transactions")
    receipts = broadcast.get("receipts")
    if not isinstance(transactions, list) or not isinstance(receipts, list):
        raise EvidenceError("broadcast transactions and receipts must be arrays")

    creations = [
        tx
        for tx in transactions
        if isinstance(tx, dict)
        and tx.get("transactionType") == "CREATE"
        and tx.get("contractName") == CONTRACT_NAME
    ]
    if len(creations) != 1:
        raise EvidenceError(f"expected exactly one verifier creation, found {len(creations)}")
    creation = creations[0]
    verifier_address = require_address(creation.get("contractAddress"), "verifier address")
    creation_hash = require_hash(creation.get("hash"), "creation transaction hash")
    creation_receipt = receipt_for(receipts, creation_hash, "creation")
    if parse_quantity(creation_receipt.get("status"), "creation receipt status") != 1:
        raise EvidenceError("verifier creation receipt status is not 1")
    if require_address(creation_receipt.get("contractAddress"), "created contract address") != verifier_address:
        raise EvidenceError("creation receipt address does not match broadcast transaction")

    selector_bytes = bytes.fromhex(SELECTOR)
    calls: list[tuple[dict[str, Any], bytes]] = []
    for tx in transactions:
        if not isinstance(tx, dict) or tx.get("transactionType") != "CALL":
            continue
        transaction = tx.get("transaction")
        if not isinstance(transaction, dict):
            continue
        to = transaction.get("to")
        if not isinstance(to, str) or to.lower() != verifier_address:
            continue
        calldata = decode_hex(transaction.get("input"), "call calldata")
        if calldata.startswith(selector_bytes):
            calls.append((tx, calldata))
    if len(calls) != 1:
        raise EvidenceError(f"expected exactly one verifier selector match, found {len(calls)}")

    call, calldata = calls[0]
    calldata_sha = hashlib.sha256(calldata).hexdigest()
    if len(calldata) != expected_calldata_bytes or calldata_sha != expected_calldata_sha:
        raise EvidenceError("verifier call does not match canonical Fraud calldata")
    call_hash = require_hash(call.get("hash"), "call transaction hash")
    call_receipt = receipt_for(receipts, call_hash, "call")
    status = parse_quantity(call_receipt.get("status"), "call receipt status")
    if status != 1:
        raise EvidenceError("verifier call receipt status is not 1")
    receipt_to = require_address(call_receipt.get("to"), "call receipt destination")
    if receipt_to != verifier_address:
        raise EvidenceError("call receipt destination does not match verifier")
    transaction = call.get("transaction")
    assert isinstance(transaction, dict)
    if transaction.get("accessList", []) not in (None, []):
        raise EvidenceError("London intrinsic formula excludes non-empty access lists")

    zero_bytes = calldata.count(0)
    nonzero_bytes = len(calldata) - zero_bytes
    intrinsic = 21_000 + 4 * zero_bytes + 16 * nonzero_bytes
    receipt_gas = parse_quantity(call_receipt.get("gasUsed"), "call receipt gasUsed")
    if receipt_gas < intrinsic:
        raise EvidenceError("receipt gasUsed is below London intrinsic gas")
    execution_plus_memory = receipt_gas - intrinsic
    if intrinsic + execution_plus_memory != receipt_gas:
        raise EvidenceError("gas components do not add back to receipt gasUsed")

    call_block = parse_quantity(call_receipt.get("blockNumber"), "call receipt blockNumber")
    block_number = parse_quantity(block.get("number"), "block number")
    if block_number != call_block:
        raise EvidenceError("block artifact does not describe the verifier call block")
    block_timestamp = parse_quantity(block.get("timestamp"), "block timestamp")

    deployed = artifact.get("deployedBytecode")
    if not isinstance(deployed, dict):
        raise EvidenceError("deployed bytecode is missing")
    artifact_runtime = decode_hex(deployed.get("object"), "deployed bytecode")
    if not artifact_runtime:
        raise EvidenceError("verifier runtime bytecode is empty")
    if args.runtime_code.is_symlink() or not args.runtime_code.is_file():
        raise EvidenceError("on-chain runtime code must be a regular non-symlink file")
    try:
        runtime = decode_hex(args.runtime_code.read_text(encoding="ascii").strip(), "on-chain runtime code")
    except (OSError, UnicodeError) as exc:
        raise EvidenceError(f"invalid on-chain runtime code: {exc}") from exc
    if runtime != artifact_runtime:
        raise EvidenceError("on-chain runtime code differs from the pinned compiler artifact")
    runtime_sha = hashlib.sha256(runtime).hexdigest()
    if len(runtime) != expected_runtime_bytes or runtime_sha != expected_runtime_sha:
        raise EvidenceError("verifier runtime code does not match canonical expectations")
    metadata = artifact.get("metadata")
    if not isinstance(metadata, dict):
        raise EvidenceError("contract metadata is missing")
    compiler = metadata.get("compiler")
    settings = metadata.get("settings")
    if not isinstance(compiler, dict) or compiler.get("version") != EXPECTED_SOLC:
        raise EvidenceError("unexpected solc version")
    if not isinstance(settings, dict):
        raise EvidenceError("compiler settings are missing")
    optimizer = settings.get("optimizer")
    if (
        settings.get("evmVersion") != "london"
        or settings.get("viaIR") is not True
        or not isinstance(optimizer, dict)
        or optimizer.get("enabled") is not True
        or optimizer.get("runs") != 200
    ):
        raise EvidenceError("contract artifact does not use the pinned London build settings")

    return {
        "block_timestamp": block_timestamp,
        "call": {
            "block_number": call_block,
            "calldata": {
                "bytes": len(calldata),
                "nonzero_bytes": nonzero_bytes,
                "sha256": calldata_sha,
                "zero_bytes": zero_bytes,
            },
            "expected_verdict": "Fraud",
            "execution_plus_memory_gas": execution_plus_memory,
            "intrinsic_london_gas": intrinsic,
            "receipt_gas_used": receipt_gas,
            "selector": "0x" + SELECTOR,
            "status": status,
            "transaction_hash": call_hash,
        },
        "canonical_vector_sha256": vector_sha,
        "canonical_expectations_sha256": hashlib.sha256(args.expectations.read_bytes()).hexdigest(),
        "chain_id": chain_id,
        "classification": "proof_math_only",
        "environment": {
            "anvil": validate_tool_version(args.anvil_version, args.anvil_commit, "Anvil"),
            "cast": validate_tool_version(args.cast_version, args.cast_commit, "Cast"),
            "forge": validate_tool_version(args.forge_version, args.forge_commit, "Forge"),
            "hardfork": "london",
            "optimizer": {"enabled": True, "runs": 200},
            "solc": EXPECTED_SOLC,
            "via_ir": True,
        },
        "schema": "aigg.porw.anvil-benchmark.v2",
        "source_identity": {
            "entries": source_entries,
            "git_base_commit": git_base_commit,
            "manifest_sha256": hashlib.sha256(args.source_manifest.read_bytes()).hexdigest(),
            "relevant_input_worktree_dirty": False,
        },
        "verifier": {
            "address": verifier_address,
            "creation_transaction_hash": creation_hash,
            "runtime_code_bytes": len(runtime),
            "runtime_bytecode_sha256": runtime_sha,
        },
    }


def atomic_write(output: Path, report: dict[str, Any]) -> None:
    payload = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def compare_reports(first_path: Path, second_path: Path) -> None:
    first = load_json(first_path, "first report")
    second = load_json(second_path, "second report")
    for report in (first, second):
        report.pop("block_timestamp", None)
        call = report.get("call")
        verifier = report.get("verifier")
        if not isinstance(call, dict) or not isinstance(verifier, dict):
            raise EvidenceError("benchmark report is missing call or verifier data")
        call.pop("transaction_hash", None)
        verifier.pop("creation_transaction_hash", None)
    if first != second:
        raise EvidenceError("benchmark runs differ in deterministic fields")


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "--compare":
        try:
            compare_reports(Path(sys.argv[2]), Path(sys.argv[3]))
        except (EvidenceError, OSError) as exc:
            print(f"report-anvil: {exc}", file=sys.stderr)
            return 1
        print("deterministic benchmark fields match")
        return 0
    args = parse_args()
    try:
        output = validate_output(args.output_root, args.output)
        report = build_report(args)
        atomic_write(output, report)
    except (EvidenceError, OSError) as exc:
        print(f"report-anvil: {exc}", file=os.sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
