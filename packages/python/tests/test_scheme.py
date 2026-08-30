import json
from pathlib import Path
from typing import cast

import numpy as np
import pytest

from aigg_porw import (
    FMIX_M1,
    FMIX_M2,
    GOLDEN32,
    M32,
    SCHEME_ID,
    TILE_BYTES,
    TILE_WORDS,
    WORD_BYTES,
    fmix32,
    sketch_tiles,
    tile_coeffs,
)
from aigg_porw import scheme as scheme_module

VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "spec-cache"
    / "conformance"
    / "porw"
    / "sketch-tile-v2.json"
)


def _vector() -> dict[str, object]:
    return cast(dict[str, object], json.loads(VECTOR_PATH.read_text(encoding="utf-8")))


def _reference_buffer(n_tiles: int) -> np.ndarray:
    length = n_tiles * TILE_BYTES
    buffer = bytes(
        (((index * 2654435761) & 0xFFFFFFFFFFFFFFFF) >> 7) & 0xFF for index in range(length)
    )
    return np.frombuffer(buffer, dtype=np.uint8)


def _scalar_sketch_tiles(slot_seed: int, buffer: np.ndarray) -> np.ndarray:
    n_tiles = buffer.size // TILE_BYTES
    values = np.empty(n_tiles, dtype=np.uint64)
    for tile_index in range(n_tiles):
        start = tile_index * TILE_BYTES
        words = buffer[start : start + TILE_BYTES].view("<u4").astype(np.uint64)
        coefficients = tile_coeffs(slot_seed, tile_index)
        values[tile_index] = (coefficients * words).sum() & M32
    return values


def test_scheme_constants_and_sketches_match_locked_vector() -> None:
    vector = _vector()
    scheme = vector["scheme"]
    params = vector["params"]
    reference_buffer = vector["reference_buffer"]
    assert isinstance(scheme, dict)
    assert isinstance(params, dict)
    assert isinstance(reference_buffer, dict)

    assert SCHEME_ID == scheme["id"] == "aigg:porw:sketch-tile:v2"
    assert TILE_BYTES == params["tile_bytes"] == 4096
    assert TILE_WORDS == params["tile_words"] == 1024
    assert WORD_BYTES == 4
    assert GOLDEN32 == int(params["golden32"], 16) == 0x9E3779B9
    assert FMIX_M1 == 0x85EBCA6B
    assert FMIX_M2 == 0xC2B2AE35
    assert M32 == 0xFFFFFFFF

    buffer = _reference_buffer(int(reference_buffer["n_tiles"]))
    sketches = vector["sketches"]
    assert isinstance(sketches, list)
    for case in sketches:
        assert isinstance(case, dict)
        values = sketch_tiles(case["slot_seed"], buffer)
        assert values.dtype == np.uint64
        assert values.tolist() == case["per_tile"]


def test_coefficients_match_locked_vector_and_remain_odd() -> None:
    vector = _vector()
    coefficients = vector["coefficients"]
    assert isinstance(coefficients, dict)

    values = tile_coeffs(coefficients["slot_seed"], np.array([0, 3], dtype=np.uint64))
    assert values.shape == (2, TILE_WORDS)
    assert values.dtype == np.uint64
    assert values[0, :4].tolist() == coefficients["tile0_first4"]
    assert values[1, :4].tolist() == coefficients["tile3_first4"]
    assert np.all(values & 1 == 1)


def test_scalar_tile_index_has_one_dimensional_coefficient_shape() -> None:
    values = tile_coeffs(7, 0)
    assert values.shape == (TILE_WORDS,)
    assert values.dtype == np.uint64


@pytest.mark.parametrize("slot_seed", [True, np.uint32(1), -1, 1 << 32, "1"])
def test_slot_seed_must_be_an_exact_u32(slot_seed: object) -> None:
    with pytest.raises((TypeError, ValueError), match="slot_seed"):
        tile_coeffs(slot_seed, 0)  # type: ignore[arg-type]
    with pytest.raises((TypeError, ValueError), match="slot_seed"):
        sketch_tiles(slot_seed, np.zeros(TILE_BYTES, dtype=np.uint8))  # type: ignore[arg-type]


@pytest.mark.parametrize("tile_index", [True, np.uint64(0), -1, 1 << 64, 1.0])
def test_scalar_tile_index_must_be_an_exact_u64(tile_index: object) -> None:
    with pytest.raises((TypeError, ValueError), match="tile_idx"):
        tile_coeffs(7, tile_index)  # type: ignore[arg-type]


def test_tile_index_array_requires_exact_uint64_ndarray() -> None:
    invalid_values: list[object] = [
        [0, 1],
        np.array([0, 1], dtype=np.uint32),
        np.ma.array([0, 1], dtype=np.uint64),
    ]
    for tile_indices in invalid_values:
        with pytest.raises(TypeError, match="tile_idx"):
            tile_coeffs(7, tile_indices)  # type: ignore[arg-type]


def test_fmix32_requires_exact_uint64_ndarray() -> None:
    invalid_values: list[object] = [
        [1, 2],
        np.uint64(1),
        np.array([1, 2], dtype=np.uint32),
        np.ma.array([1, 2], dtype=np.uint64),
    ]
    for values in invalid_values:
        with pytest.raises(TypeError, match="h"):
            fmix32(values)  # type: ignore[arg-type]


def test_sketch_buffer_requires_exact_contiguous_one_dimensional_uint8_array() -> None:
    valid = np.zeros(TILE_BYTES * 2, dtype=np.uint8)
    assert sketch_tiles(1, valid).shape == (2,)
    assert sketch_tiles(1, valid[:0]).shape == (0,)

    invalid_values: list[tuple[object, type[Exception], str]] = [
        (bytes(TILE_BYTES), TypeError, "buf"),
        (np.zeros(TILE_BYTES, dtype=np.int8), TypeError, "buf"),
        (np.ma.array(np.zeros(TILE_BYTES, dtype=np.uint8)), TypeError, "buf"),
        (valid.reshape(2, TILE_BYTES), ValueError, "one-dimensional"),
        (valid[::2], ValueError, "C-contiguous"),
        (valid[:-1], ValueError, "multiple"),
    ]
    for buffer, error, message in invalid_values:
        with pytest.raises(error, match=message):
            sketch_tiles(1, buffer)  # type: ignore[arg-type]


def test_sketch_batches_bound_temporaries_and_preserve_absolute_indices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch_cap = 256
    n_tiles = batch_cap + 2
    buffer = _reference_buffer(n_tiles)
    expected = _scalar_sketch_tiles(0xDEADBEEF, buffer)
    assert scheme_module._SKETCH_BATCH_TILES == batch_cap
    batch_calls: list[tuple[int, int]] = []
    original_batch = scheme_module._sketch_tile_batch

    def recording_batch(
        slot_seed: int,
        batch_buffer: np.ndarray,
        first_tile_index: int,
    ) -> np.ndarray:
        batch_calls.append((batch_buffer.size // TILE_BYTES, first_tile_index))
        return original_batch(slot_seed, batch_buffer, first_tile_index)

    monkeypatch.setattr(scheme_module, "_sketch_tile_batch", recording_batch)
    actual = sketch_tiles(0xDEADBEEF, buffer)

    assert batch_calls == [(batch_cap, 0), (2, batch_cap)]
    assert np.array_equal(actual, expected)
