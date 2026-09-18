"""End-to-end smoke test for the fruit-fly-brain PoRW demo.

Runs the full residency -> commit -> open -> fraud -> non-inclusion loop at a
tiny scale. Uses the sketch sweep, so it needs CUDA or TRITON_INTERPRET=1;
without either it skips (mirroring the kernel-test gate).
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from porw_sketch import commit
from porw_sketch.spec import TILE_BYTES
from demo.fly_brain import payload as payload_mod
from demo.fly_brain.run_demo import run


def _kernels_runnable() -> bool:
    if os.environ.get("TRITON_INTERPRET") == "1":
        return True
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


pytestmark = pytest.mark.skipif(
    not _kernels_runnable(),
    reason="sweep kernel needs CUDA or TRITON_INTERPRET=1",
)

CHALLENGE = "00" * 31 + "2a"


def _run(coverage_fraction, attest="none"):
    p = payload_mod.synthesize("test-fly", neurons=2500, synapses=25000)
    return run(p, challenge_hex=CHALLENGE, coverage_fraction=coverage_fraction, seed=3, attest=attest)


def test_end_to_end_sparse_coverage_all_checks_pass():
    r = _run(0.6)
    assert r["sweep_matches_reference"] is True
    assert r["opening"]["verified"] is True
    assert r["fraud_proof"]["honest_verdict"] == "no_fraud"
    assert r["fraud_proof"]["tampered_verdict"] == "fraud"
    assert r["non_inclusion"]["verified"] is True
    assert r["all_checks_pass"] is True


def test_full_coverage_has_no_uncovered_tile():
    r = _run(1.0)
    assert r["coverage_tiles"] == r["model"]["n_tiles"]
    assert r["non_inclusion"]["challenged_tile"] is None
    assert r["all_checks_pass"] is True


def test_payload_is_deterministic_and_tile_aligned():
    a = payload_mod.synthesize("determinism", neurons=1500, synapses=9000)
    b = payload_mod.synthesize("determinism", neurons=1500, synapses=9000)
    assert (a.buf == b.buf).all()
    assert a.buf.size % TILE_BYTES == 0
    # model id (weights root) is reproducible across builds
    n = a.n_tiles
    tiles_a = a.buf.reshape(n, TILE_BYTES)
    root_a = commit.merkle_root([commit.weights_leaf(i, tiles_a[i].tobytes()) for i in range(n)])
    tiles_b = b.buf.reshape(n, TILE_BYTES)
    root_b = commit.merkle_root([commit.weights_leaf(i, tiles_b[i].tobytes()) for i in range(n)])
    assert root_a == root_b


def test_mock_execution_attestation_binds_residency_and_execution():
    r = _run(0.6, attest="mock")
    ea = r["execution_attestation"]
    assert ea is not None
    assert ea["is_hardware"] is False
    assert ea["verified_by"] == "mock"
    assert ea["binds_verified"] is True
    # the residency<->execution tie: a proof cannot be rebound to another model
    assert ea["rebind_to_other_model_rejected"] is True
    assert r["residency_ok"] is True
    assert r["all_checks_pass"] is True


def test_attestation_report_data_binds_model_id():
    from demo.fly_brain.attest import ExecutionTranscript, MockCpuTeeAdapter, TDX_REPORT_DATA_OFFSET

    model_a = b"\x11" * 32
    model_b = b"\x22" * 32
    ch = bytes.fromhex(CHALLENGE)
    req = b"\xaa" * 32
    resp = b"\xbb" * 32
    adapter = MockCpuTeeAdapter()
    t_a = ExecutionTranscript(model_a, ch, req, resp)
    proof, quote = adapter.attest(t_a)
    # verifies for the same transcript
    assert adapter.verify(proof, quote, t_a) is True
    # the report_data carries the transcript digest, which binds the model id
    rd = bytes.fromhex(proof.report_data.removeprefix("0x"))
    assert rd[:32] == t_a.digest()
    # a transcript over a different model id does not verify against this quote
    t_b = ExecutionTranscript(model_b, ch, req, resp)
    assert adapter.verify(proof, quote, t_b) is False


def test_checkpoint_source_uses_exact_bytes(tmp_path):
    import numpy as np

    blob = (np.arange(9000, dtype=np.uint8)).tobytes()
    f = tmp_path / "weights.bin"
    f.write_bytes(blob)
    p = payload_mod.from_checkpoint(f, name="real-model")
    assert p.source.startswith("checkpoint:")
    assert p.buf[: len(blob)].tobytes() == blob
    assert p.buf.size % TILE_BYTES == 0
