"""Fail-closed host validation for the public Triton launch wrappers."""

import ast
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from porw_sketch.reference import moe_align
from porw_sketch.spec import TILE_BYTES, TILE_WORDS
from porw_sketch.validation import (
    validate_aligned_routing,
    validate_fused_inputs,
    validate_sweep_inputs,
)


KERNELS_PATH = Path(__file__).resolve().parents[1] / "porw_sketch" / "kernels.py"
STUB_MODULE_NAME = "porw_sketch._kernels_validation_stub"
CANONICAL_K = TILE_BYTES // 2


@pytest.fixture
def kernel_module(monkeypatch):
    """Load host wrappers with fake Triton without touching canonical imports."""
    fake_language = ModuleType("triton.language")
    fake_language.constexpr = object()
    fake_triton = ModuleType("triton")
    fake_triton.jit = lambda function: function
    fake_triton.cdiv = lambda value, divisor: (value + divisor - 1) // divisor
    fake_triton.language = fake_language
    monkeypatch.setitem(sys.modules, "triton", fake_triton)
    monkeypatch.setitem(sys.modules, "triton.language", fake_language)

    module_spec = importlib.util.spec_from_file_location(
        STUB_MODULE_NAME,
        KERNELS_PATH,
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError(f"cannot load isolated kernel module from {KERNELS_PATH}")
    module = importlib.util.module_from_spec(module_spec)
    monkeypatch.setitem(sys.modules, STUB_MODULE_NAME, module)
    module_spec.loader.exec_module(module)
    return module


def test_kernel_module_stub_does_not_replace_canonical_import(kernel_module):
    import porw_sketch

    assert kernel_module.__name__ == STUB_MODULE_NAME
    assert sys.modules.get("porw_sketch.kernels") is not kernel_module
    assert getattr(porw_sketch, "kernels", None) is not kernel_module


def fused_inputs():
    return (
        torch.zeros((2, CANONICAL_K), dtype=torch.float16),
        torch.zeros((2, 3, CANONICAL_K), dtype=torch.float16),
        torch.tensor([[0, 1], [1, 0]], dtype=torch.int32),
    )


def test_fused_validation_accepts_canonical_inputs():
    a, b, topk_ids = fused_inputs()
    assert validate_fused_inputs(a, b, topk_ids, 0, True, 16, 64, 64, 1) == (
        2,
        2,
        3,
        CANONICAL_K,
        2,
    )


def test_aligned_routing_validation_accepts_exact_moe_alignment():
    routing = np.array([[0, 1], [1, 0], [1, 1]], dtype=np.int32)
    sorted_ids, expert_ids, padded = moe_align(routing, 2, 4)
    validate_aligned_routing(sorted_ids, expert_ids, padded, routing, 2, 4)


@pytest.mark.parametrize(
    "case",
    [
        "dtype",
        "shape",
        "count",
        "expert",
        "token",
        "duplicate",
        "binding",
        "padding",
    ],
)
def test_aligned_routing_validation_rejects_malformed_outputs(case):
    routing = np.array([[0, 1], [1, 0], [1, 1]], dtype=np.int32)
    sorted_ids, expert_ids, padded = moe_align(routing, 2, 4)
    if case == "dtype":
        sorted_ids = sorted_ids.astype(np.int64)
    elif case == "shape":
        expert_ids = expert_ids.reshape(1, -1)
    elif case == "count":
        padded -= 1
    elif case == "expert":
        expert_ids = expert_ids.copy()
        expert_ids[0] = 2
    elif case == "token":
        sorted_ids = sorted_ids.copy()
        sorted_ids[0] = routing.size + 1
    elif case == "duplicate":
        sorted_ids = sorted_ids.copy()
        sorted_ids[0] = sorted_ids[1]
    elif case == "binding":
        sorted_ids = sorted_ids.copy()
        sorted_ids[0], sorted_ids[4] = sorted_ids[4], sorted_ids[0]
    elif case == "padding":
        sorted_ids = sorted_ids.copy()
        sorted_ids[0], sorted_ids[3] = sorted_ids[3], sorted_ids[0]
    with pytest.raises((TypeError, ValueError)):
        validate_aligned_routing(sorted_ids, expert_ids, padded, routing, 2, 4)


@pytest.mark.parametrize(
    "mutate,error,match",
    [
        (
            lambda a, b, r: (
                a[:, :1024].contiguous(),
                b[:, :, :1024].contiguous(),
                r,
            ),
            ValueError,
            "K",
        ),
        (lambda a, b, r: (a.to(torch.float32), b, r), TypeError, "float16"),
        (lambda a, b, r: (a, b.to(torch.float32), r), TypeError, "float16"),
        (lambda a, b, r: (a, b, r.to(torch.int64)), TypeError, "int32"),
        (lambda a, b, r: (a.unsqueeze(0), b, r), ValueError, "two-dimensional"),
        (lambda a, b, r: (a, b.unsqueeze(0), r), ValueError, "three-dimensional"),
        (lambda a, b, r: (a, b, r[:1]), ValueError, "shape"),
        (
            lambda a, b, r: (torch.empty((CANONICAL_K, 2), dtype=a.dtype).T, b, r),
            ValueError,
            "contiguous",
        ),
        (
            lambda a, b, r: (
                a,
                torch.empty((2, 3, CANONICAL_K * 2), dtype=b.dtype)[:, :, ::2],
                r,
            ),
            ValueError,
            "contiguous",
        ),
        (
            lambda a, b, r: (a, b, torch.empty((2, 4), dtype=r.dtype)[:, ::2]),
            ValueError,
            "contiguous",
        ),
        (
            lambda a, b, r: (
                a,
                b,
                torch.tensor([[0, 2], [1, 0]], dtype=r.dtype),
            ),
            ValueError,
            "range",
        ),
        (lambda a, b, r: (a, b, r.to("meta")), ValueError, "device"),
    ],
)
def test_fused_validation_rejects_malformed_tensors(mutate, error, match):
    with pytest.raises(error, match=match):
        validate_fused_inputs(*mutate(*fused_inputs()), 0, True, 16, 64, 64, 1)


@pytest.mark.parametrize(
    "slot_seed,enable_sketch,blocks,error",
    [
        (-1, True, (16, 64, 64, 1), ValueError),
        (1 << 32, True, (16, 64, 64, 1), ValueError),
        (0, 1, (16, 64, 64, 1), TypeError),
        (0, True, (0, 64, 64, 1), ValueError),
        (0, True, (3, 64, 64, 1), ValueError),
        (0, True, (16, 0, 64, 1), ValueError),
        (0, True, (16, 63, 64, 1), ValueError),
        (0, True, (16, 64, 0, 1), ValueError),
        (0, True, (16, 64, 63, 1), ValueError),
        (0, True, (16, 64, 4096, 1), ValueError),
        (0, True, (16, 64, 64, 0), ValueError),
    ],
)
def test_fused_validation_rejects_invalid_runtime_parameters(
    slot_seed, enable_sketch, blocks, error
):
    with pytest.raises(error):
        validate_fused_inputs(
            *fused_inputs(), slot_seed, enable_sketch, *blocks
        )


def test_sweep_validation_accepts_canonical_inputs():
    buf = torch.zeros(TILE_BYTES * 2, dtype=torch.uint8)
    tile_ids = torch.tensor([0, 1], dtype=torch.int64)
    assert validate_sweep_inputs(buf, tile_ids, 0, TILE_WORDS, True) == 2


@pytest.mark.parametrize(
    "buf,tile_ids,slot_seed,block,copy_to_host,error",
    [
        (
            torch.zeros(TILE_BYTES, dtype=torch.int8),
            None,
            0,
            512,
            True,
            TypeError,
        ),
        (
            torch.zeros((1, TILE_BYTES), dtype=torch.uint8),
            None,
            0,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES * 2, dtype=torch.uint8)[::2],
            None,
            0,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES - 1, dtype=torch.uint8),
            None,
            0,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            torch.tensor([0], dtype=torch.int32),
            0,
            512,
            True,
            TypeError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            torch.tensor([1], dtype=torch.int64),
            0,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            torch.tensor([0], dtype=torch.int64, device="meta"),
            0,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            None,
            -1,
            512,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            None,
            0,
            0,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            None,
            0,
            3,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            None,
            0,
            TILE_WORDS * 2,
            True,
            ValueError,
        ),
        (
            torch.zeros(TILE_BYTES, dtype=torch.uint8),
            None,
            0,
            512,
            1,
            TypeError,
        ),
    ],
)
def test_sweep_validation_rejects_malformed_inputs(
    buf, tile_ids, slot_seed, block, copy_to_host, error
):
    with pytest.raises(error):
        validate_sweep_inputs(buf, tile_ids, slot_seed, block, copy_to_host)


def test_public_runtime_wrappers_contain_no_assert_statements():
    tree = ast.parse(KERNELS_PATH.read_text(encoding="utf-8"))
    wrappers = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name
        in {
            "make_params",
            "prepare_moe_gemm",
            "prepare_sketch_sweep",
            "run_moe_gemm",
            "run_sketch_sweep",
        }
    }
    assert wrappers.keys() == {
        "make_params",
        "prepare_moe_gemm",
        "prepare_sketch_sweep",
        "run_moe_gemm",
        "run_sketch_sweep",
    }
    assert not [
        node
        for wrapper in wrappers.values()
        for node in ast.walk(wrapper)
        if isinstance(node, ast.Assert)
    ]


def test_validation_remains_active_under_python_optimized_mode():
    package_root = str(KERNELS_PATH.parents[1])
    script = """
import torch
from porw_sketch.validation import validate_fused_inputs
k = 1024
a = torch.zeros((1, k), dtype=torch.float16)
b = torch.zeros((1, 1, k), dtype=torch.float16)
r = torch.zeros((1, 1), dtype=torch.int32)
try:
    validate_fused_inputs(a, b, r, 0, True, 16, 64, 64, 1)
except ValueError:
    raise SystemExit(0)
raise SystemExit(9)
"""
    env = dict(os.environ, PYTHONPATH=package_root)
    result = subprocess.run(
        [sys.executable, "-O", "-c", script], env=env, check=False
    )
    assert result.returncode == 0


class RecordingKernel:
    def __init__(self):
        self.calls = []

    def __getitem__(self, grid):
        def launch(*args, **kwargs):
            self.calls.append((grid, args, kwargs))

        return launch


def _unexpected_preflight(*args, **kwargs):
    raise AssertionError("timed launch repeated preflight or host conversion")


def test_prepared_moe_launch_reuses_buffers_without_host_work(
    kernel_module, monkeypatch
):
    a, b, topk_ids = fused_inputs()
    prepared = kernel_module.prepare_moe_gemm(a, b, topk_ids, 0)
    output_ids = tuple(
        id(tensor)
        for tensor in (prepared.c, prepared.partials, prepared.coverage)
    )
    recording = RecordingKernel()
    monkeypatch.setattr(kernel_module, "moe_gemm_sketch_kernel", recording)
    for name in (
        "validate_fused_inputs",
        "validate_aligned_routing",
        "make_params",
        "_u32_np",
    ):
        monkeypatch.setattr(kernel_module, name, _unexpected_preflight)
    for name in ("zeros", "empty", "tensor", "from_numpy", "arange"):
        monkeypatch.setattr(kernel_module.torch, name, _unexpected_preflight)

    with pytest.raises(TypeError, match="validated prepared"):
        kernel_module._launch_prepared_moe(object(), enable_sketch=False)
    with pytest.raises(TypeError, match="bool"):
        kernel_module._launch_prepared_moe(prepared, enable_sketch=1)
    kernel_module._launch_prepared_moe(prepared, enable_sketch=False)
    kernel_module._launch_prepared_moe(prepared, enable_sketch=True)

    assert len(recording.calls) == 2
    assert recording.calls[0][2]["ENABLE_SKETCH"] is False
    assert recording.calls[1][2]["ENABLE_SKETCH"] is True
    assert output_ids == tuple(
        id(tensor)
        for tensor in (prepared.c, prepared.partials, prepared.coverage)
    )


def test_prepared_sweep_launch_reuses_output_without_host_work(
    kernel_module, monkeypatch
):
    buffer = torch.zeros(TILE_BYTES * 2, dtype=torch.uint8)
    prepared = kernel_module.prepare_sketch_sweep(buffer, 0)
    output_id = id(prepared.out)
    recording = RecordingKernel()
    monkeypatch.setattr(kernel_module, "sketch_sweep_kernel", recording)
    for name in ("validate_sweep_inputs", "make_params", "_u32_np"):
        monkeypatch.setattr(kernel_module, name, _unexpected_preflight)
    for name in ("zeros", "empty", "tensor", "from_numpy", "arange"):
        monkeypatch.setattr(kernel_module.torch, name, _unexpected_preflight)

    with pytest.raises(TypeError, match="validated prepared"):
        kernel_module._launch_prepared_sweep(object())
    kernel_module._launch_prepared_sweep(prepared)
    kernel_module._launch_prepared_sweep(prepared)

    assert len(recording.calls) == 2
    assert id(prepared.out) == output_id


def test_private_prepared_launchers_have_no_preflight_or_host_copy_calls():
    tree = ast.parse(KERNELS_PATH.read_text(encoding="utf-8"))
    launchers = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"_launch_prepared_moe", "_launch_prepared_sweep"}
    }
    assert launchers.keys() == {
        "_launch_prepared_moe",
        "_launch_prepared_sweep",
    }
    forbidden = {
        "cpu",
        "numpy",
        "zeros",
        "empty",
        "tensor",
        "from_numpy",
        "arange",
        "make_params",
        "validate_fused_inputs",
        "validate_aligned_routing",
        "validate_sweep_inputs",
        "moe_align",
        "_u32_np",
    }
    calls = {
        launcher_name: {
            node.func.attr
            if isinstance(node.func, ast.Attribute)
            else node.func.id
            for node in ast.walk(launcher)
            if isinstance(node, ast.Call)
            and isinstance(node.func, (ast.Attribute, ast.Name))
        }
        for launcher_name, launcher in launchers.items()
    }
    assert not {
        launcher: sorted(names & forbidden)
        for launcher, names in calls.items()
        if names & forbidden
    }
