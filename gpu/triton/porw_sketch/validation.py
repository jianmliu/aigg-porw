"""Fail-closed validation for host-side Triton launch parameters."""

import numpy as np
import torch

from .reference import validate_coverage_tile_tensor
from .spec import TILE_BYTES, TILE_WORDS


CANONICAL_K = TILE_BYTES // 2
U32_MAX = (1 << 32) - 1


def _plain_int(name: str, value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    return value


def validate_slot_seed(slot_seed: int) -> None:
    _plain_int("slot_seed", slot_seed)
    if not 0 <= slot_seed <= U32_MAX:
        raise ValueError("slot_seed must be within the canonical u32 range")


def _validate_power_of_two(name: str, value: int) -> None:
    _plain_int(name, value)
    if value <= 0 or value & (value - 1):
        raise ValueError(f"{name} must be a positive power of two")


def validate_fused_inputs(
    a: torch.Tensor,
    b: torch.Tensor,
    topk_ids: torch.Tensor,
    slot_seed: int,
    enable_sketch: bool,
    block_m: int,
    block_n: int,
    block_k: int,
    group_m: int,
) -> tuple[int, int, int, int, int]:
    """Validate every host assumption used by the canonical fused launch."""
    for name, tensor in (("a", a), ("b", b), ("topk_ids", topk_ids)):
        if not isinstance(tensor, torch.Tensor):
            raise TypeError(f"{name} must be a torch.Tensor")

    if a.ndim != 2:
        raise ValueError("a must be two-dimensional [M, K]")
    if b.ndim != 3:
        raise ValueError("b must be three-dimensional [E, N, K]")
    if topk_ids.ndim != 2:
        raise ValueError("topk_ids must be two-dimensional [M, top_k]")
    if a.dtype != torch.float16 or b.dtype != torch.float16:
        raise TypeError("a and b must have exact dtype float16")
    if topk_ids.dtype != torch.int32:
        raise TypeError("topk_ids must have exact dtype int32")
    if b.device != a.device or topk_ids.device != a.device:
        raise ValueError("a, b, and topk_ids must be on the same device")
    for name, tensor in (("a", a), ("b", b), ("topk_ids", topk_ids)):
        if not tensor.is_contiguous():
            raise ValueError(f"{name} must use contiguous storage")

    m, k = a.shape
    experts, n, weight_k = b.shape
    route_m, top_k = topk_ids.shape
    if min(m, experts, n, top_k) <= 0:
        raise ValueError("fused dimensions must all be positive")
    if route_m != m:
        raise ValueError("topk_ids shape must match a along M")
    if weight_k != k:
        raise ValueError("a and b must have the same K dimension")
    if k != CANONICAL_K:
        raise ValueError(
            f"canonical fused PoRW requires K == {CANONICAL_K} fp16 values"
        )

    validate_slot_seed(slot_seed)
    if not isinstance(enable_sketch, bool):
        raise TypeError("enable_sketch must be a bool")
    _validate_power_of_two("block_m", block_m)
    _validate_power_of_two("block_n", block_n)
    _validate_power_of_two("block_k", block_k)
    if block_k > k or k % block_k != 0 or block_k % 2 != 0:
        raise ValueError("block_k must be even, no larger than K, and divide K")
    _plain_int("group_m", group_m)
    if group_m <= 0:
        raise ValueError("group_m must be positive")

    routing = topk_ids.detach().cpu()
    if bool(torch.any(routing < 0)) or bool(torch.any(routing >= experts)):
        raise ValueError("topk_ids entries must be within the expert range")
    return m, experts, n, k, top_k


def validate_aligned_routing(
    sorted_token_ids: np.ndarray,
    expert_ids: np.ndarray,
    num_post_padded: int,
    topk_ids: np.ndarray,
    experts: int,
    block_m: int,
) -> None:
    """Validate the exact routing buffers produced before a fused launch."""
    for name, array in (
        ("sorted_token_ids", sorted_token_ids),
        ("expert_ids", expert_ids),
        ("topk_ids", topk_ids),
    ):
        if not isinstance(array, np.ndarray):
            raise TypeError(f"{name} must be a NumPy array")
        if array.dtype != np.dtype(np.int32):
            raise TypeError(f"{name} must have exact dtype int32")
        if not array.flags.c_contiguous:
            raise ValueError(f"{name} must use contiguous storage")
    if sorted_token_ids.ndim != 1 or expert_ids.ndim != 1:
        raise ValueError("aligned routing outputs must be one-dimensional")
    if topk_ids.ndim != 2:
        raise ValueError("topk_ids must be two-dimensional")
    _plain_int("num_post_padded", num_post_padded)
    _plain_int("experts", experts)
    _validate_power_of_two("block_m", block_m)
    if experts <= 0:
        raise ValueError("experts must be positive")
    if num_post_padded != sorted_token_ids.size:
        raise ValueError("num_post_padded must equal the sorted routing length")
    if sorted_token_ids.size == 0 or sorted_token_ids.size % block_m != 0:
        raise ValueError(
            "sorted routing length must be a positive block_m multiple"
        )
    if expert_ids.size != sorted_token_ids.size // block_m:
        raise ValueError(
            "expert_ids must contain exactly one entry per routing block"
        )
    if np.any(expert_ids < 0) or np.any(expert_ids >= experts):
        raise ValueError("aligned expert_ids entries must be within the expert range")

    num_valid = topk_ids.size
    if np.any(sorted_token_ids < 0) or np.any(sorted_token_ids > num_valid):
        raise ValueError(
            "aligned token ids must be valid indices or the padding sentinel"
        )
    valid_ids = sorted_token_ids[sorted_token_ids < num_valid]
    if not np.array_equal(
        np.sort(valid_ids), np.arange(num_valid, dtype=np.int32)
    ):
        raise ValueError("aligned routing must contain each valid route exactly once")

    flat_routing = topk_ids.reshape(-1)
    for block_index, expert in enumerate(expert_ids):
        block = sorted_token_ids[
            block_index * block_m : (block_index + 1) * block_m
        ]
        padding = block == num_valid
        if np.any(padding) and not np.all(padding[np.argmax(padding) :]):
            raise ValueError("routing padding must be a trailing block suffix")
        valid_block = block[~padding]
        if valid_block.size == 0:
            raise ValueError("routing blocks must contain at least one valid route")
        if np.any(flat_routing[valid_block] != expert):
            raise ValueError("aligned route does not match its expert block")


def validate_sweep_inputs(
    buf_bytes: torch.Tensor,
    tile_ids: torch.Tensor | None,
    slot_seed: int,
    block: int,
    copy_to_host: bool,
) -> int:
    """Validate every host assumption used by the standalone sweep launch."""
    if not isinstance(buf_bytes, torch.Tensor):
        raise TypeError("buf_bytes must be a torch.Tensor")
    if buf_bytes.dtype != torch.uint8:
        raise TypeError("buf_bytes must have exact dtype uint8")
    if buf_bytes.ndim != 1:
        raise ValueError("buf_bytes must be one-dimensional")
    if not buf_bytes.is_contiguous():
        raise ValueError("buf_bytes must use contiguous storage")
    if buf_bytes.numel() == 0 or buf_bytes.numel() % TILE_BYTES != 0:
        raise ValueError(
            "buf_bytes must contain a positive whole number of 4 KiB tiles"
        )

    validate_slot_seed(slot_seed)
    _validate_power_of_two("block", block)
    if block > TILE_WORDS or TILE_WORDS % block != 0:
        raise ValueError("block must be no larger than TILE_WORDS and divide it")
    if not isinstance(copy_to_host, bool):
        raise TypeError("copy_to_host must be a bool")

    total_tiles = buf_bytes.numel() // TILE_WORDS // 4
    if tile_ids is not None:
        validate_coverage_tile_tensor(tile_ids, total_tiles, buf_bytes.device)
    return total_tiles
