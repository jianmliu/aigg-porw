#!/usr/bin/env bash
set -Eeuo pipefail

MODE="publish"
FRESH_OUTPUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-committed)
            MODE="check"
            shift
            ;;
        --fresh-output)
            [[ $# -ge 2 ]] || {
                echo "--fresh-output requires a path" >&2
                exit 2
            }
            FRESH_OUTPUT=$2
            shift 2
            ;;
        *)
            echo "usage: $0 [--check-committed [--fresh-output ABSOLUTE_PATH]]" >&2
            exit 2
            ;;
    esac
done
if [[ -n "$FRESH_OUTPUT" && "$MODE" != "check" ]]; then
    echo "--fresh-output requires --check-committed" >&2
    exit 2
fi

FOUNDRY_VERSION="1.7.1"
FOUNDRY_COMMIT="4072e48705af9d93e3c0f6e29e93b5e9a40caed8"
CHAIN_ID="31337"
HARDFORK="london"
BLOCK_GAS_LIMIT="30000000"
VECTOR_SHA256="fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7"

if [[ -L "$0" ]]; then
    echo "refusing to run through a symlink" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EVM_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd "$EVM_DIR/../.." && pwd -P)"
BENCH_DIR="$REPO_ROOT/benchmarks/evm"
FRESH_ROOT="$BENCH_DIR/generated"
REPORTER="$SCRIPT_DIR/report-anvil.py"
FRESH_PUBLISHER="$SCRIPT_DIR/publish-fresh-report.py"
EXPECTATIONS="$SCRIPT_DIR/canonical-benchmark.json"
VECTOR="$REPO_ROOT/spec-cache/conformance/porw/sketch-tile-v2.json"
ARTIFACT="$EVM_DIR/out/PorwVerifier.sol/PorwVerifier.json"
BROADCAST="$EVM_DIR/broadcast/AnvilBench.s.sol/$CHAIN_ID/run-latest.json"
FINAL_REPORT="$BENCH_DIR/anvil-london.json"
RPC_URL=""
PORT=""

RELEVANT_INPUTS=(
    ".gitmodules"
    "contracts/evm/foundry.toml"
    "contracts/evm/lib/forge-std"
    "contracts/evm/script/AnvilBench.s.sol"
    "contracts/evm/scripts/canonical-benchmark.json"
    "contracts/evm/scripts/publish-fresh-report.py"
    "contracts/evm/scripts/report-anvil.py"
    "contracts/evm/scripts/run-anvil-benchmark.sh"
    "contracts/evm/src/Blake3.sol"
    "contracts/evm/src/PorwVerifier.sol"
    "contracts/evm/src/bench/PoRWBenchFixture.sol"
    "spec-cache/conformance/porw/sketch-tile-v2.json"
)

[[ "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || {
    echo "repository boundary mismatch" >&2
    exit 1
}
[[ -d "$BENCH_DIR" && ! -L "$BENCH_DIR" ]] || {
    echo "benchmark directory must be an existing non-symlink directory" >&2
    exit 1
}
[[ -f "$REPORTER" && ! -L "$REPORTER" && -f "$EXPECTATIONS" && ! -L "$EXPECTATIONS" && -f "$VECTOR" && ! -L "$VECTOR" ]] || {
    echo "reporter, canonical expectations, or vector is missing or symlinked" >&2
    exit 1
}
[[ -f "$FRESH_PUBLISHER" && ! -L "$FRESH_PUBLISHER" ]] || {
    echo "fresh benchmark publisher is missing or symlinked" >&2
    exit 1
}
[[ ! -L "$FINAL_REPORT" ]] || {
    echo "refusing to overwrite symlink evidence" >&2
    exit 1
}

if [[ -n "$FRESH_OUTPUT" ]]; then
    [[ "$FRESH_OUTPUT" == /* ]] || {
        echo "fresh output must be an absolute path" >&2
        exit 1
    }
    [[ ! -L "$FRESH_ROOT" ]] || {
        echo "benchmarks/evm/generated must not be a symlink" >&2
        exit 1
    }
    mkdir -p "$FRESH_ROOT"
    [[ -d "$FRESH_ROOT" && ! -L "$FRESH_ROOT" ]] || {
        echo "benchmarks/evm/generated must be a regular directory" >&2
        exit 1
    }
    case "$FRESH_OUTPUT" in
        "$FRESH_ROOT"/*) ;;
        *)
            echo "fresh output must be inside benchmarks/evm/generated" >&2
            exit 1
            ;;
    esac
    python3 "$FRESH_PUBLISHER" \
        --allowed-root "$FRESH_ROOT" \
        --target "$FRESH_OUTPUT" \
        --validate-target-only
fi

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

for tool in forge cast anvil python3 git cmp; do
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

verify_relevant_inputs_match_index() {
    local input index_entry mode index_oid worktree_oid submodule_status
    for input in "${RELEVANT_INPUTS[@]}"; do
        index_entry="$(git -C "$REPO_ROOT" ls-files -s -- "$input")"
        [[ -n "$index_entry" ]] || {
            echo "relevant input is not staged in the Git index: $input" >&2
            return 1
        }
        read -r mode index_oid _ <<<"$index_entry"
        if [[ "$mode" == "160000" ]]; then
            [[ -d "$REPO_ROOT/$input" && ! -L "$REPO_ROOT/$input" ]] || {
                echo "relevant submodule is missing or symlinked: $input" >&2
                return 1
            }
            worktree_oid="$(git -C "$REPO_ROOT/$input" rev-parse HEAD)"
            submodule_status="$(git -C "$REPO_ROOT/$input" status --porcelain)"
            [[ "$worktree_oid" == "$index_oid" && -z "$submodule_status" ]] || {
                echo "relevant submodule does not match the staged gitlink: $input" >&2
                return 1
            }
        else
            [[ -f "$REPO_ROOT/$input" && ! -L "$REPO_ROOT/$input" ]] || {
                echo "relevant input is missing or symlinked: $input" >&2
                return 1
            }
            worktree_oid="$(git -C "$REPO_ROOT" hash-object -- "$input")"
            [[ "$worktree_oid" == "$index_oid" ]] || {
                echo "relevant input has unstaged content: $input" >&2
                return 1
            }
        fi
    done
}

verify_relevant_inputs_match_index

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

wait_for_anvil() {
    local log_file=$1
    local attempt client_version
    for attempt in $(seq 1 100); do
        kill -0 "$ANVIL_PID" 2>/dev/null || {
            echo "Anvil exited before RPC became ready" >&2
            return 1
        }
        PORT="$(sed -n 's/.*Listening on 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$log_file" | tail -1)"
        if [[ -n "$PORT" ]]; then
            [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -gt 1024 && "$PORT" -le 65535 ]] || {
                echo "Anvil reported an invalid dynamic port" >&2
                return 1
            }
            RPC_URL="http://127.0.0.1:$PORT"
        fi
        if [[ -n "$RPC_URL" ]] && cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
            kill -0 "$ANVIL_PID" 2>/dev/null || {
                echo "Anvil exited during RPC identity verification" >&2
                return 1
            }
            [[ "$(cast chain-id --rpc-url "$RPC_URL")" == "$CHAIN_ID" ]] || {
                echo "Anvil returned an unexpected chain id" >&2
                return 1
            }
            client_version="$(cast rpc --rpc-url "$RPC_URL" web3_clientVersion)"
            [[ "$client_version" == *"anvil/v$FOUNDRY_VERSION"* ]] || {
                echo "RPC client identity is not the pinned Anvil version" >&2
                return 1
            }
            kill -0 "$ANVIL_PID" 2>/dev/null || {
                echo "Anvil exited before readiness was accepted" >&2
                return 1
            }
            return 0
        fi
        sleep 0.1
    done
    echo "timed out waiting for Anvil RPC" >&2
    return 1
}

run_once() {
    local run_number=$1
    local run_dir="$TEMP_DIR/run-$run_number"
    mkdir "$run_dir"
    PORT=""
    RPC_URL=""

    anvil \
        --host 127.0.0.1 \
        --port 0 \
        --chain-id "$CHAIN_ID" \
        --hardfork "$HARDFORK" \
        --gas-limit "$BLOCK_GAS_LIMIT" >"$run_dir/anvil.log" 2>&1 &
    ANVIL_PID=$!
    wait_for_anvil "$run_dir/anvil.log"

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
        --expectations "$EXPECTATIONS" \
        --source-manifest "$TEMP_DIR/source-manifest.json" \
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

generate_source_manifest() {
    local output=$1
    python3 - "$REPO_ROOT" "$output" "${RELEVANT_INPUTS[@]}" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
output = Path(sys.argv[2])
entries = []
for relative in sys.argv[3:]:
    path = root / relative
    if path.is_dir():
        commit = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        payload = ("gitlink\0" + commit).encode()
        entries.append({"gitlink_commit": commit, "path": relative, "sha256": hashlib.sha256(payload).hexdigest()})
    else:
        entries.append({"path": relative, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
document = {
    "entries": entries,
    "relevant_input_worktree_dirty": False,
    "schema": "aigg.porw.source-manifest.v2",
}
output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

generate_source_manifest "$TEMP_DIR/source-manifest.json"

run_once 1
run_once 2
python3 "$REPORTER" --compare "$TEMP_DIR/run-1/report.json" "$TEMP_DIR/run-2/report.json"
verify_relevant_inputs_match_index
generate_source_manifest "$TEMP_DIR/source-manifest-final.json"
cmp -s "$TEMP_DIR/source-manifest.json" "$TEMP_DIR/source-manifest-final.json" || {
    echo "measurement-relevant inputs changed during the benchmark" >&2
    exit 1
}

if [[ "$MODE" == "check" ]]; then
    [[ -f "$FINAL_REPORT" && ! -L "$FINAL_REPORT" ]] || {
        echo "committed benchmark evidence is missing or symlinked" >&2
        exit 1
    }
    python3 "$REPORTER" --compare "$FINAL_REPORT" "$TEMP_DIR/run-1/report.json"
    if [[ -n "$FRESH_OUTPUT" ]]; then
        python3 "$FRESH_PUBLISHER" \
            --allowed-root "$FRESH_ROOT" \
            --source "$TEMP_DIR/run-1/report.json" \
            --target "$FRESH_OUTPUT"
        echo "wrote fresh verified CI evidence: $FRESH_OUTPUT"
    fi
    echo "fresh clean-head evidence matches committed deterministic fields: $FINAL_REPORT"
    exit 0
fi

PUBLISH_TEMP="$(mktemp "$BENCH_DIR/.anvil-london.json.XXXXXXXX")"
[[ -f "$PUBLISH_TEMP" && ! -L "$PUBLISH_TEMP" ]] || {
    echo "mktemp did not create a regular publish file" >&2
    exit 1
}
cp "$TEMP_DIR/run-1/report.json" "$PUBLISH_TEMP"
mv -f "$PUBLISH_TEMP" "$FINAL_REPORT"

echo "wrote verified two-run Anvil evidence: $FINAL_REPORT"
