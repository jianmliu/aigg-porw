"""Commitment and counted-Merkle tests against the locked PoRW v2 fixture."""

import json
from pathlib import Path
from typing import Never, cast

import pytest
from blake3 import blake3

import aigg_porw.commitments as commitment_module
import aigg_porw.merkle as merkle_module
from aigg_porw import (
    TILE_BYTES,
    CommittedOpening,
    InteriorNonInclusionWitness,
    NeighborWitness,
    merkle_parent,
    partials_leaf,
    verify_committed_opening,
    verify_counted_merkle,
    verify_interior_non_inclusion,
    weights_leaf,
)

VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "spec-cache"
    / "conformance"
    / "porw"
    / "sketch-tile-v2.json"
)
U32_LIMIT = 1 << 32
U64_LIMIT = 1 << 64


def _vector() -> dict[str, object]:
    return cast(dict[str, object], json.loads(VECTOR_PATH.read_text(encoding="utf-8")))


def _unhex(value: str) -> bytes:
    return bytes.fromhex(value.removeprefix("0x"))


def _root(leaves: tuple[bytes, ...]) -> bytes:
    level = leaves
    while len(level) > 1:
        level = tuple(
            blake3(
                level[index] + (level[index + 1] if index + 1 < len(level) else level[index])
            ).digest()
            for index in range(0, len(level), 2)
        )
    return level[0]


def _proof(leaves: tuple[bytes, ...], index: int) -> tuple[bytes, ...]:
    result: list[bytes] = []
    level = leaves
    while len(level) > 1:
        sibling_index = index - 1 if index % 2 else index + 1
        result.append(level[sibling_index] if sibling_index < len(level) else level[index])
        level = tuple(
            blake3(
                level[position]
                + (level[position + 1] if position + 1 < len(level) else level[position])
            ).digest()
            for position in range(0, len(level), 2)
        )
        index //= 2
    return tuple(result)


def _locked_fixture() -> dict[str, object]:
    vector = _vector()
    fixture = vector["tampered_commitment_scenario"]
    assert isinstance(fixture, dict)
    return fixture


def test_leaf_hashes_and_parent_match_locked_vector() -> None:
    vector = _vector()
    fixture = _locked_fixture()
    coverage = fixture["coverage"]
    sketches = fixture["committed_s_tiles"]
    assert isinstance(coverage, list)
    assert isinstance(sketches, list)
    leaves = tuple(partials_leaf(index, sketch) for index, sketch in zip(coverage, sketches))
    assert ["0x" + leaf.hex() for leaf in leaves] == fixture["partials_leaves"]
    assert "0x" + merkle_parent(leaves[0], leaves[1]).hex() == fixture["partials_root"]

    reference = vector["reference_buffer"]
    assert isinstance(reference, dict)
    length = int(reference["n_tiles"]) * TILE_BYTES
    buffer = bytes(
        ((((offset * 2654435761) & (U64_LIMIT - 1)) >> 7) & 0xFF) for offset in range(length)
    )
    weights = vector["weights_tree"]
    assert isinstance(weights, dict)
    assert "0x" + weights_leaf(3, buffer[3 * TILE_BYTES :]).hex() == weights["leaves"][3]


def test_locked_committed_opening_and_interior_non_inclusion_verify() -> None:
    fixture = _locked_fixture()
    root = _unhex(str(fixture["partials_root"]))
    opening_fixture = fixture["opening_committed_tile_3"]
    assert isinstance(opening_fixture, dict)
    opening = CommittedOpening(
        tile_index=3,
        sketch=3046284449,
        index=int(opening_fixture["leaf_index"]),
        proof=tuple(_unhex(item) for item in cast(list[str], opening_fixture["proof"])),
    )
    assert verify_committed_opening(root=root, leaf_count=2, challenged_tile=3, opening=opening)

    non_inclusion = fixture["non_inclusion_tile_2"]
    assert isinstance(non_inclusion, dict)
    left_fixture = non_inclusion["left"]
    right_fixture = non_inclusion["right"]
    assert isinstance(left_fixture, dict)
    assert isinstance(right_fixture, dict)
    leaves = tuple(_unhex(value) for value in cast(list[str], fixture["partials_leaves"]))
    witness = InteriorNonInclusionWitness(
        left=NeighborWitness(
            tile_index=int(left_fixture["tile_idx"]),
            sketch=int(left_fixture["s_tile"]),
            index=int(left_fixture["index"]),
            proof=_proof(leaves, int(left_fixture["index"])),
        ),
        right=NeighborWitness(
            tile_index=int(right_fixture["tile_idx"]),
            sketch=int(right_fixture["s_tile"]),
            index=int(right_fixture["index"]),
            proof=_proof(leaves, int(right_fixture["index"])),
        ),
    )
    assert verify_interior_non_inclusion(
        root=root, leaf_count=2, challenged_tile=2, witness=witness
    )


@pytest.mark.parametrize("leaf_count", [3, 5])
def test_counted_merkle_roundtrips_odd_duplicate_last_trees(leaf_count: int) -> None:
    leaves = tuple(blake3(f"leaf-{index}".encode()).digest() for index in range(leaf_count))
    root = _root(leaves)
    for index, leaf in enumerate(leaves):
        assert verify_counted_merkle(root, leaf, index, leaf_count, _proof(leaves, index))


@pytest.mark.parametrize("leaf_count", [3, 5])
def test_counted_merkle_rejects_wrong_duplicates_and_lengths(leaf_count: int) -> None:
    leaves = tuple(blake3(f"leaf-{index}".encode()).digest() for index in range(leaf_count))
    root = _root(leaves)
    index = leaf_count - 1
    proof = _proof(leaves, index)
    wrong = (leaves[index - 1], *proof[1:])
    assert not verify_counted_merkle(root, leaves[index], index, leaf_count, wrong)
    assert not verify_counted_merkle(root, leaves[index], index, leaf_count, proof[:-1])
    assert not verify_counted_merkle(root, leaves[index], index, leaf_count, (*proof, leaves[0]))


@pytest.mark.parametrize(
    ("index", "leaf_count"),
    [(-1, 2), (2, 2), (0, 0), (0, -1), (U64_LIMIT, U64_LIMIT)],
)
def test_counted_merkle_rejects_invalid_index_or_count(index: int, leaf_count: int) -> None:
    leaf = blake3(b"leaf").digest()
    assert not verify_counted_merkle(leaf, leaf, index, leaf_count, ())


def test_counted_merkle_rejects_malformed_hashes_and_proof_shapes() -> None:
    leaf = blake3(b"leaf").digest()
    assert not verify_counted_merkle(leaf[:-1], leaf, 0, 1, ())
    assert not verify_counted_merkle(leaf, leaf[:-1], 0, 1, ())
    assert not verify_counted_merkle(leaf, leaf, 0, 1, [])  # type: ignore[arg-type]
    assert not verify_counted_merkle(leaf, leaf, 0, 1, (leaf,) * 65)
    with pytest.raises(TypeError, match="root must be exact bytes"):
        verify_counted_merkle("root", leaf, 0, 1, ())  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="proof node must be exact bytes"):
        verify_counted_merkle(leaf, leaf, 0, 2, ("node",))  # type: ignore[arg-type]


class _IntSubclass(int):
    pass


class _BytesSubclass(bytes):
    pass


class _CommittedOpeningSubclass(CommittedOpening):
    pass


class _InteriorWitnessSubclass(InteriorNonInclusionWitness):
    pass


def test_numeric_protocol_fields_require_exact_integers() -> None:
    leaf = blake3(b"leaf").digest()
    for invalid in (True, _IntSubclass(0), 0.0):
        assert not verify_counted_merkle(leaf, leaf, invalid, 1, ())  # type: ignore[arg-type]
        assert not verify_counted_merkle(leaf, leaf, 0, invalid, ())  # type: ignore[arg-type]


def test_leaf_hash_primitives_reject_noncanonical_inputs_before_hashing() -> None:
    tile = bytes(TILE_BYTES)
    assert len(weights_leaf(U64_LIMIT - 1, tile)) == 32
    assert len(partials_leaf(U64_LIMIT - 1, U32_LIMIT - 1)) == 32
    with pytest.raises(TypeError, match="tile must be exact bytes"):
        weights_leaf(0, "tile")  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="tile_index must be an exact integer"):
        weights_leaf(True, tile)
    with pytest.raises(TypeError, match="sketch must be an exact integer"):
        partials_leaf(0, _IntSubclass(1))
    with pytest.raises(ValueError, match="tile must be exactly 4096 bytes"):
        weights_leaf(0, tile[:-1])
    with pytest.raises(ValueError, match="u64 range"):
        partials_leaf(-1, 0)
    with pytest.raises(ValueError, match="u32 range"):
        partials_leaf(0, U32_LIMIT)


def test_opening_mutations_fail_closed() -> None:
    fixture = _locked_fixture()
    root = _unhex(str(fixture["partials_root"]))
    opening_fixture = fixture["opening_committed_tile_3"]
    assert isinstance(opening_fixture, dict)
    proof = tuple(_unhex(item) for item in cast(list[str], opening_fixture["proof"]))
    valid = {
        "tile_index": 3,
        "sketch": 3046284449,
        "index": 1,
        "proof": proof,
    }
    mutations: tuple[dict[str, object], ...] = (
        {"tile_index": 2},
        {"tile_index": -1},
        {"tile_index": U64_LIMIT},
        {"sketch": 3046284448},
        {"sketch": U32_LIMIT},
        {"index": 0},
        {"index": -1},
        {"proof": (bytes([proof[0][0] ^ 1]) + proof[0][1:],)},
        {"proof": [proof[0]]},
    )
    for mutation in mutations:
        fields = valid | mutation
        opening = CommittedOpening(**fields)  # type: ignore[arg-type]
        assert not verify_committed_opening(
            root=root, leaf_count=2, challenged_tile=3, opening=opening
        )
    assert not verify_committed_opening(
        root=root,
        leaf_count=2,
        challenged_tile=_IntSubclass(3),
        opening=CommittedOpening(**valid),  # type: ignore[arg-type]
    )


def test_interior_non_inclusion_requires_adjacent_strict_bracket() -> None:
    fixture = _locked_fixture()
    root = _unhex(str(fixture["partials_root"]))
    leaves = tuple(_unhex(value) for value in cast(list[str], fixture["partials_leaves"]))
    left = NeighborWitness(1, 853679690, 0, _proof(leaves, 0))
    right = NeighborWitness(3, 3046284449, 1, _proof(leaves, 1))
    mutations = (
        InteriorNonInclusionWitness(NeighborWitness(1, 853679691, 0, left.proof), right),
        InteriorNonInclusionWitness(left, NeighborWitness(3, 3046284448, 1, right.proof)),
        InteriorNonInclusionWitness(left, NeighborWitness(4, 3046284449, 1, right.proof)),
        InteriorNonInclusionWitness(left, NeighborWitness(3, 3046284449, 0, right.proof)),
        InteriorNonInclusionWitness(left, NeighborWitness(3, 3046284449, 2, right.proof)),
    )
    for witness in mutations:
        assert not verify_interior_non_inclusion(
            root=root, leaf_count=2, challenged_tile=2, witness=witness
        )
    valid = InteriorNonInclusionWitness(left, right)
    for challenged_tile in (1, 3, -1, U64_LIMIT, True):
        assert not verify_interior_non_inclusion(
            root=root, leaf_count=2, challenged_tile=challenged_tile, witness=valid
        )


def test_witness_values_are_immutable_and_exact_types_are_required() -> None:
    leaf = blake3(b"leaf").digest()
    opening = CommittedOpening(1, 2, 0, ())
    with pytest.raises((AttributeError, TypeError)):
        opening.index = 1  # type: ignore[misc]
    assert not verify_committed_opening(
        root=leaf,
        leaf_count=1,
        challenged_tile=1,
        opening={"tile_index": 1},  # type: ignore[arg-type]
    )
    witness = InteriorNonInclusionWitness(
        NeighborWitness(1, 1, 0, ()), NeighborWitness(3, 3, 1, ())
    )
    assert not verify_interior_non_inclusion(
        root=leaf,
        leaf_count=2,
        challenged_tile=2,
        witness=(witness.left, witness.right),  # type: ignore[arg-type]
    )


def _forbid_hashing(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def forbidden_blake3(*args: object, **kwargs: object) -> Never:
        calls.append(1)
        raise AssertionError("hashing occurred before recursive input validation")

    monkeypatch.setattr(commitment_module, "blake3", forbidden_blake3)
    monkeypatch.setattr(merkle_module, "blake3", forbidden_blake3)
    return calls


@pytest.mark.parametrize(
    "invalid_node",
    ["node", bytearray(32), memoryview(bytes(32)), _BytesSubclass(32)],
)
def test_committed_opening_rejects_nested_non_exact_bytes_before_hashing(
    monkeypatch: pytest.MonkeyPatch, invalid_node: object
) -> None:
    calls = _forbid_hashing(monkeypatch)
    opening = CommittedOpening(3, 7, 1, (invalid_node,))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_committed_opening(root=bytes(32), leaf_count=2, challenged_tile=3, opening=opening)
    assert calls == []


def test_non_inclusion_prevalidates_later_neighbor_before_any_hashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    witness = InteriorNonInclusionWitness(
        left=NeighborWitness(1, 11, 0, (bytes(32),)),
        right=NeighborWitness(3, 33, 1, ("late-node",)),  # type: ignore[arg-type]
    )
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_interior_non_inclusion(
            root=bytes(32), leaf_count=2, challenged_tile=2, witness=witness
        )
    assert calls == []


def test_non_inclusion_scans_nested_bytes_even_when_earlier_numeric_field_is_bad(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    witness = InteriorNonInclusionWitness(
        left=NeighborWitness(-1, 11, 0, (bytes(32),)),
        right=NeighborWitness(3, 33, 1, ("late-node",)),  # type: ignore[arg-type]
    )
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_interior_non_inclusion(
            root=bytes(32), leaf_count=2, challenged_tile=2, witness=witness
        )
    assert calls == []


def test_high_level_malformed_exact_bytes_fail_closed_before_hashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    opening = CommittedOpening(3, 7, 1, (bytes(31),))
    assert not verify_committed_opening(
        root=bytes(32), leaf_count=2, challenged_tile=3, opening=opening
    )
    witness = InteriorNonInclusionWitness(
        left=NeighborWitness(1, 11, 0, (bytes(32),)),
        right=NeighborWitness(3, 33, 1, (bytes(31),)),
    )
    assert not verify_interior_non_inclusion(
        root=bytes(32), leaf_count=2, challenged_tile=2, witness=witness
    )
    assert calls == []


@pytest.mark.parametrize(
    "invalid_root",
    ["root", bytearray(32), memoryview(bytes(32)), _BytesSubclass(32)],
)
def test_high_level_roots_require_exact_bytes_before_hashing(
    monkeypatch: pytest.MonkeyPatch, invalid_root: object
) -> None:
    calls = _forbid_hashing(monkeypatch)
    opening = CommittedOpening(3, 7, 0, ())
    with pytest.raises(TypeError, match="^root must be exact bytes$"):
        verify_committed_opening(
            root=invalid_root,  # type: ignore[arg-type]
            leaf_count=1,
            challenged_tile=3,
            opening=opening,
        )
    assert calls == []


@pytest.mark.parametrize(
    "context_change",
    [
        {"leaf_count": -1},
        {"leaf_count": 0},
        {"leaf_count": U64_LIMIT},
        {"challenged_tile": -1},
        {"challenged_tile": U64_LIMIT},
        {"challenged_tile": True},
    ],
)
def test_committed_opening_scans_nested_bytes_before_bad_context_numbers(
    monkeypatch: pytest.MonkeyPatch, context_change: dict[str, object]
) -> None:
    calls = _forbid_hashing(monkeypatch)
    context: dict[str, object] = {
        "root": bytes(32),
        "leaf_count": 2,
        "challenged_tile": 3,
        "opening": CommittedOpening(3, 7, 1, ("late-node",)),  # type: ignore[arg-type]
    }
    context.update(context_change)
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_committed_opening(**context)  # type: ignore[arg-type]
    assert calls == []


@pytest.mark.parametrize(
    ("context_change", "invalid_side"),
    [
        ({"leaf_count": -1}, "left"),
        ({"leaf_count": 0}, "right"),
        ({"challenged_tile": -1}, "left"),
        ({"challenged_tile": U64_LIMIT}, "right"),
        ({"challenged_tile": True}, "right"),
    ],
)
def test_non_inclusion_scans_both_nested_proofs_before_bad_context_numbers(
    monkeypatch: pytest.MonkeyPatch,
    context_change: dict[str, object],
    invalid_side: str,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    left_proof: tuple[bytes, ...] | tuple[str, ...] = (bytes(32),)
    right_proof: tuple[bytes, ...] | tuple[str, ...] = (bytes(32),)
    if invalid_side == "left":
        left_proof = ("late-left",)
    else:
        right_proof = ("late-right",)
    witness = InteriorNonInclusionWitness(
        NeighborWitness(1, 11, 0, left_proof),  # type: ignore[arg-type]
        NeighborWitness(3, 33, 1, right_proof),  # type: ignore[arg-type]
    )
    context: dict[str, object] = {
        "root": bytes(32),
        "leaf_count": 2,
        "challenged_tile": 2,
        "witness": witness,
    }
    context.update(context_change)
    with pytest.raises(TypeError, match="^proof node must be exact bytes$"):
        verify_interior_non_inclusion(**context)  # type: ignore[arg-type]
    assert calls == []


def test_exact_bytes_with_bad_widths_and_numbers_fail_closed_without_hashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    assert not verify_committed_opening(
        root=bytes(31),
        leaf_count=-1,
        challenged_tile=-1,
        opening=CommittedOpening(3, 7, 1, (bytes(31),)),
    )
    assert not verify_interior_non_inclusion(
        root=bytes(31),
        leaf_count=-1,
        challenged_tile=-1,
        witness=InteriorNonInclusionWitness(
            NeighborWitness(1, 11, 0, (bytes(31),)),
            NeighborWitness(3, 33, 1, (bytes(31),)),
        ),
    )
    assert calls == []


def test_wrong_high_level_witness_classes_fail_without_attribute_access_or_hashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _forbid_hashing(monkeypatch)
    for wrong_opening in (object(), _CommittedOpeningSubclass(3, 7, 0, ())):
        assert not verify_committed_opening(
            root=bytes(32),
            leaf_count=-1,
            challenged_tile=-1,
            opening=wrong_opening,  # type: ignore[arg-type]
        )
    for wrong_witness in (
        object(),
        _InteriorWitnessSubclass(NeighborWitness(1, 11, 0, ()), NeighborWitness(3, 33, 1, ())),
    ):
        assert not verify_interior_non_inclusion(
            root=bytes(32),
            leaf_count=-1,
            challenged_tile=-1,
            witness=wrong_witness,  # type: ignore[arg-type]
        )
    assert not verify_interior_non_inclusion(
        root=bytes(32),
        leaf_count=2,
        challenged_tile=2,
        witness=InteriorNonInclusionWitness(object(), object()),  # type: ignore[arg-type]
    )
    assert calls == []
