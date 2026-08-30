"""Canonical counted-Merkle verification for PoRW commitments."""

from typing import TypeGuard

from blake3 import blake3

HASH_BYTES = 32
MAX_PROOF_NODES = 64
U64_LIMIT = 1 << 64


def _require_exact_bytes(value: object, name: str) -> bytes:
    if type(value) is not bytes:
        raise TypeError(f"{name} must be exact bytes")
    return value


def _is_u64(value: object) -> TypeGuard[int]:
    return type(value) is int and 0 <= value < U64_LIMIT


def _validate_proof_nodes(proof: object) -> TypeGuard[tuple[bytes, ...]]:
    """Validate all bounded proof node byte values without hashing."""
    if type(proof) is not tuple:
        return False
    if len(proof) > MAX_PROOF_NODES:
        return False

    widths_are_valid = True
    for node in proof:
        _require_exact_bytes(node, "proof node")
        widths_are_valid = widths_are_valid and len(node) == HASH_BYTES
    return widths_are_valid


def _validate_counted_proof(index: object, leaf_count: object, proof: object) -> bool:
    """Validate an entire counted proof without performing any hashing."""
    if not _validate_proof_nodes(proof):
        return False
    if not _is_u64(index) or not _is_u64(leaf_count):
        return False
    if leaf_count == 0 or index >= leaf_count:
        return False

    expected_nodes = (leaf_count - 1).bit_length()
    return expected_nodes <= MAX_PROOF_NODES and len(proof) == expected_nodes


def merkle_parent(left: bytes, right: bytes) -> bytes:
    """Hash two exact 32-byte Merkle nodes in left-to-right order."""
    left_bytes = _require_exact_bytes(left, "left")
    right_bytes = _require_exact_bytes(right, "right")
    if len(left_bytes) != HASH_BYTES:
        raise ValueError("left must be exactly 32 bytes")
    if len(right_bytes) != HASH_BYTES:
        raise ValueError("right must be exactly 32 bytes")
    return blake3(left_bytes + right_bytes).digest()


def verify_counted_merkle(
    root: bytes,
    leaf: bytes,
    index: int,
    leaf_count: int,
    proof: tuple[bytes, ...],
) -> bool:
    """Verify an exact duplicate-last tree shape without throwing on bad proofs.

    Protocol fields use exact native types: integers must be exact ``int``
    instances and the proof must be an exact tuple. Byte values use exact
    ``bytes``; passing another kind of object is programmer misuse and raises
    ``TypeError`` before any hashing takes place. Wrong byte widths and other
    malformed protocol values fail closed with ``False``.
    """
    root_bytes = _require_exact_bytes(root, "root")
    leaf_bytes = _require_exact_bytes(leaf, "leaf")
    if len(root_bytes) != HASH_BYTES or len(leaf_bytes) != HASH_BYTES:
        return False
    if not _validate_counted_proof(index, leaf_count, proof):
        return False

    accumulator = leaf_bytes
    position = index
    width = leaf_count
    for sibling in proof:
        if position % 2 == 0:
            if position + 1 == width and sibling != accumulator:
                return False
            accumulator = merkle_parent(accumulator, sibling)
        else:
            accumulator = merkle_parent(sibling, accumulator)
        position //= 2
        width = (width + 1) // 2
    return accumulator == root_bytes
