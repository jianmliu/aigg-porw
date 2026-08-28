#!/usr/bin/env bash
set -Eeuo pipefail

FOUNDRY_VERSION="1.7.1"
FOUNDRY_COMMIT="4072e48705af9d93e3c0f6e29e93b5e9a40caed8"
CHAIN_ID="31337"
HARDFORK="london"
BLOCK_GAS_LIMIT="30000000"
PORT="18545"
VECTOR_SHA256="fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7"

if [[ -L "$0" ]]; then
    echo "refusing to run through a symlink" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EVM_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd "$EVM_DIR/../.." && pwd -P)"
BENCH_DIR="$REPO_ROOT/benchmarks/evm"
REPORTER="$SCRIPT_DIR/report-anvil.py"
VECTOR="$REPO_ROOT/spec-cache/conformance/porw/sketch-tile-v2.json"
ARTIFACT="$EVM_DIR/out/PorwVerifier.sol/PorwVerifier.json"
BROADCAST="$EVM_DIR/broadcast/AnvilBench.s.sol/$CHAIN_ID/run-latest.json"
FINAL_REPORT="$BENCH_DIR/anvil-london.json"
RPC_URL="http://127.0.0.1:$PORT"

[[ "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || {
    echo "repository boundary mismatch" >&2
    exit 1
}
[[ -d "$BENCH_DIR" && ! -L "$BENCH_DIR" ]] || {
    echo "benchmark directory must be an existing non-symlink directory" >&2
    exit 1
}
[[ -f "$REPORTER" && ! -L "$REPORTER" && -f "$VECTOR" && ! -L "$VECTOR" ]] || {
    echo "reporter or canonical vector is missing or symlinked" >&2
    exit 1
}
[[ ! -L "$FINAL_REPORT" ]] || {
    echo "refusing to overwrite symlink evidence" >&2
    exit 1
}

TEMP_BASE="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_BASE/aigg-porw-anvil.XXXXXXXX")"
ANVIL_PID=""
PUBLISH_TEMP=""

stop_anvil() {
    if [[ -n "$ANVIL_PID" ]]; then
        kill "$ANVIL_PID" 2>/dev/null || true
        wait "$ANVIL_PID" 2>/dev/null || true
        ANVIL_PID=""
    fi
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM HUP
    set +e
    stop_anvil
    if [[ -n "$PUBLISH_TEMP" && "$PUBLISH_TEMP" == "$BENCH_DIR"/.anvil-london.json.* && -f "$PUBLISH_TEMP" && ! -L "$PUBLISH_TEMP" ]]; then
        rm -f -- "$PUBLISH_TEMP"
    fi
    case "$TEMP_DIR" in
        "$TEMP_BASE"/aigg-porw-anvil.*)
            if [[ -d "$TEMP_DIR" && ! -L "$TEMP_DIR" ]]; then
                rm -rf -- "$TEMP_DIR"
            fi
            ;;
        *)
            echo "refusing unsafe temporary cleanup: $TEMP_DIR" >&2
            status=1
            ;;
    esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

for tool in forge cast anvil python3 git; do
    command -v "$tool" >/dev/null || {
        echo "required tool not found: $tool" >&2
        exit 1
    }
done

check_foundry_version() {
    local tool=$1
    local label=$2
    local output first second
    output="$($tool --version)"
    first="$(printf '%s\n' "$output" | sed -n '1p')"
    second="$(printf '%s\n' "$output" | sed -n '2p')"
    [[ "$first" == "$label Version: $FOUNDRY_VERSION" && "$second" == "Commit SHA: $FOUNDRY_COMMIT" ]] || {
        echo "$tool is not pinned to $FOUNDRY_VERSION ($FOUNDRY_COMMIT)" >&2
        exit 1
    }
}

check_foundry_version forge forge
check_foundry_version cast cast
check_foundry_version anvil anvil

(
cd "$EVM_DIR"
forge config --json
) | python3 -c '
import json, sys
d = json.load(sys.stdin)
expected = {
    "solc": "0.8.33",
    "evm_version": "london",
    "optimizer": True,
    "optimizer_runs": 200,
    "via_ir": True,
}
actual = {key: d.get(key) for key in expected}
if actual != expected:
    raise SystemExit(f"unpinned Foundry compiler configuration: {actual!r}")
'

port_is_free() {
    python3 - "$PORT" <<'PY'
import socket
import sys

sock = socket.socket()
try:
    try:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
    except OSError:
        raise SystemExit(1)
finally:
    sock.close()
PY
}

wait_for_anvil() {
    local attempt
    for attempt in $(seq 1 100); do
        if cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
            [[ "$(cast chain-id --rpc-url "$RPC_URL")" == "$CHAIN_ID" ]] || {
                echo "Anvil returned an unexpected chain id" >&2
                return 1
            }
            return 0
        fi
        kill -0 "$ANVIL_PID" 2>/dev/null || {
            echo "Anvil exited before RPC became ready" >&2
            return 1
        }
        sleep 0.1
    done
    echo "timed out waiting for Anvil RPC" >&2
    return 1
}

run_once() {
    local run_number=$1
    local run_dir="$TEMP_DIR/run-$run_number"
    mkdir "$run_dir"
    port_is_free || {
        echo "127.0.0.1:$PORT is already in use; refusing to attach to an unrelated node" >&2
        return 1
    }

    anvil \
        --host 127.0.0.1 \
        --port "$PORT" \
        --chain-id "$CHAIN_ID" \
        --hardfork "$HARDFORK" \
        --gas-limit "$BLOCK_GAS_LIMIT" \
        --silent >"$run_dir/anvil.log" 2>&1 &
    ANVIL_PID=$!
    wait_for_anvil

    (
        cd "$EVM_DIR"
        forge script script/AnvilBench.s.sol:AnvilBench \
            --rpc-url "$RPC_URL" \
            --broadcast \
            --slow
    ) >"$run_dir/forge.log" 2>&1

    [[ -f "$BROADCAST" && ! -L "$BROADCAST" && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || {
        echo "Foundry did not produce regular broadcast and contract artifacts" >&2
        return 1
    }
    cp "$BROADCAST" "$run_dir/run-latest.json"
    cast block latest --json --rpc-url "$RPC_URL" >"$run_dir/call-block.json"
    local verifier_address
    verifier_address="$(python3 - "$run_dir/run-latest.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    document = json.load(handle)
matches = [
    tx.get("contractAddress")
    for tx in document.get("transactions", [])
    if isinstance(tx, dict)
    and tx.get("transactionType") == "CREATE"
    and tx.get("contractName") == "PorwVerifier"
]
if len(matches) != 1 or not isinstance(matches[0], str) or re.fullmatch(r"0x[0-9a-fA-F]{40}", matches[0]) is None:
    raise SystemExit("could not identify exactly one verifier deployment")
print(matches[0])
PY
)"
    cast code "$verifier_address" --rpc-url "$RPC_URL" >"$run_dir/runtime-code.hex"

    python3 "$REPORTER" \
        --broadcast "$run_dir/run-latest.json" \
        --artifact "$ARTIFACT" \
        --block "$run_dir/call-block.json" \
        --vector "$VECTOR" \
        --canonical-vector-sha256 "$VECTOR_SHA256" \
        --runtime-code "$run_dir/runtime-code.hex" \
        --output-root "$run_dir" \
        --output "$run_dir/report.json" \
        --forge-version "$FOUNDRY_VERSION" \
        --forge-commit "$FOUNDRY_COMMIT" \
        --cast-version "$FOUNDRY_VERSION" \
        --cast-commit "$FOUNDRY_COMMIT" \
        --anvil-version "$FOUNDRY_VERSION" \
        --anvil-commit "$FOUNDRY_COMMIT"

    stop_anvil
}

run_once 1
run_once 2
python3 "$REPORTER" --compare "$TEMP_DIR/run-1/report.json" "$TEMP_DIR/run-2/report.json"

PUBLISH_TEMP="$(mktemp "$BENCH_DIR/.anvil-london.json.XXXXXXXX")"
[[ -f "$PUBLISH_TEMP" && ! -L "$PUBLISH_TEMP" ]] || {
    echo "mktemp did not create a regular publish file" >&2
    exit 1
}
cp "$TEMP_DIR/run-1/report.json" "$PUBLISH_TEMP"
mv -f "$PUBLISH_TEMP" "$FINAL_REPORT"

echo "wrote verified two-run Anvil evidence: $FINAL_REPORT"
