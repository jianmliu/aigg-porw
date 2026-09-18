"""Tests for the CPU-DRAM PoRW residency experiment.

Pure CPU / NumPy — no CUDA or Triton needed, so these always run.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from porw_sketch.spec import TILE_BYTES, sketch_tiles
from experiments.cpu_memory import residency as R
from experiments.cpu_memory.bench_cpu import run
from demo.fly_brain import payload as payload_mod

CHALLENGE = "00" * 31 + "2a"


def test_stream_sketch_matches_reference_at_various_chunk_sizes():
    rng = np.random.default_rng(1)
    buf = rng.integers(0, 256, size=53 * TILE_BYTES, dtype=np.uint8)
    ref = sketch_tiles(0xDEADBEEF, buf)
    for chunk in (1, 7, 16, 4096):
        assert np.array_equal(R.sketch_stream(buf, 0xDEADBEEF, chunk), ref)


def test_mlock_roundtrips_or_reports_false():
    buf = np.zeros(4 * TILE_BYTES, dtype=np.uint8)
    locked = R.mlock(buf)
    assert isinstance(locked, bool)
    if locked:
        assert R.munlock(buf) is True


def test_envelope_math():
    e = R.envelope(coverage_bytes=100 * (1 << 20), bandwidth_gib_s=10.0, slot_ms=100.0)
    # 10 GiB/s * 0.1 s = 1 GiB per slot, so a 100 MiB model fits
    assert e["coverage_fits_slot"] is True
    assert e["bytes_per_slot"] == int(10.0 * (1 << 30) * 0.1)
    tight = R.envelope(coverage_bytes=2 * (1 << 30), bandwidth_gib_s=10.0, slot_ms=100.0)
    assert tight["coverage_fits_slot"] is False


def test_end_to_end_small_scale_all_checks_pass():
    p = payload_mod.synthesize("cpu-test", neurons=4000, synapses=40000)
    r = run(p, challenge_hex=CHALLENGE, slot_ms=100.0, repeats=2, chunk_tiles=4096)
    assert r["residency"]["resident_bytes"] == p.bytes_total
    assert r["sweep_matches_reference"] is True
    assert r["opening_verified"] is True
    assert r["fraud_honest_verdict"] == "no_fraud"
    assert r["fraud_tampered_verdict"] == "fraud"
    assert r["envelope"]["coverage_fits_slot"] is True
    assert r["all_checks_pass"] is True


def test_model_id_is_deterministic_across_runs():
    p1 = payload_mod.synthesize("cpu-determinism", neurons=3000, synapses=15000)
    p2 = payload_mod.synthesize("cpu-determinism", neurons=3000, synapses=15000)
    r1 = run(p1, challenge_hex=CHALLENGE, slot_ms=100.0, repeats=1, chunk_tiles=4096)
    r2 = run(p2, challenge_hex=CHALLENGE, slot_ms=100.0, repeats=1, chunk_tiles=4096)
    assert r1["model_id"] == r2["model_id"]
    assert r1["weights_root"] == r2["weights_root"]
