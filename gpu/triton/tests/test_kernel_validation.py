"""Fail-closed host validation for the public Triton launch wrappers."""

import ast
import os
import subprocess
import sys
from pathlib import Path

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
CANONICAL_K = TILE_BYTES // 2


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
        and node.name in {"make_params", "run_moe_gemm", "run_sketch_sweep"}
    }
    assert wrappers.keys() == {"make_params", "run_moe_gemm", "run_sketch_sweep"}
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
