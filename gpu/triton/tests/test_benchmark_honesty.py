"""Static guards for device-launch-only GPU benchmark semantics."""

import ast
from pathlib import Path


BENCHMARK_PATH = Path(__file__).resolve().parents[1] / "bench_gpu.py"


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def test_timed_callbacks_only_launch_prepared_device_work():
    tree = ast.parse(BENCHMARK_PATH.read_text(encoding="utf-8"))
    main = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    bench_calls = [
        node
        for node in ast.walk(main)
        if isinstance(node, ast.Call) and _call_name(node) == "bench"
    ]
    assert len(bench_calls) == 3
    callback_calls = []
    for call in bench_calls:
        callback = call.args[0]
        assert isinstance(callback, ast.Lambda)
        assert isinstance(callback.body, ast.Call)
        callback_calls.append(_call_name(callback.body))
    assert callback_calls.count("_launch_prepared_moe") == 2
    assert callback_calls.count("_launch_prepared_sweep") == 1


def test_preflight_factories_are_outside_all_timed_callbacks():
    tree = ast.parse(BENCHMARK_PATH.read_text(encoding="utf-8"))
    main = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    calls = [_call_name(node) for node in ast.walk(main) if isinstance(node, ast.Call)]
    assert calls.count("prepare_moe_gemm") == 1
    assert calls.count("prepare_sketch_sweep") == 1
    for callback in (node for node in ast.walk(main) if isinstance(node, ast.Lambda)):
        names = {
            _call_name(node)
            for node in ast.walk(callback)
            if isinstance(node, ast.Call)
        }
        assert "prepare_moe_gemm" not in names
        assert "prepare_sketch_sweep" not in names
        assert "run_moe_gemm" not in names
        assert "run_sketch_sweep" not in names


def test_output_labels_device_launch_scope_and_not_wrapper_overhead():
    source = BENCHMARK_PATH.read_text(encoding="utf-8")
    assert "device_launch_base" in source
    assert "device_launch_fused" in source
    assert "device_launch_overhead" in source
    assert "device_launch_sweep" in source
    assert "run_moe_gemm" not in source
    assert "run_sketch_sweep" not in source
