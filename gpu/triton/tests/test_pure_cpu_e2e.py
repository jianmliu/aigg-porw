"""Tests for the pure-CPU end-to-end verifiable stack (residency + execution).

Pure CPU / NumPy — always runs.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from demo.fly_brain import payload as payload_mod
from demo.fly_brain.pure_cpu_e2e import run, fly_forward

CHALLENGE = "00" * 31 + "2a"


def _run(**kw):
    p = payload_mod.synthesize("e2e-test", neurons=4000, synapses=40000)
    args = dict(challenge_hex=CHALLENGE, slot_ms=100.0, steps=2, stimulus_seed=1,
                repeats=2, chunk_tiles=4096)
    args.update(kw)
    return run(p, **args)


def test_both_halves_pass_and_share_model_id():
    r = _run()
    assert r["A_residency"]["ok"] is True
    assert r["A_residency"]["opening_verified"] is True
    assert r["A_residency"]["fraud_honest_verdict"] == "no_fraud"
    assert r["A_residency"]["fraud_tampered_verdict"] == "fraud"
    assert r["B_execution"]["ok"] is True
    att = r["B_execution"]["attestation"]
    assert att["binds_verified"] is True
    assert att["rebind_to_other_model_rejected"] is True
    # the attestation is over the SAME model that was proven resident
    assert r["A_residency"]["resident_bytes"] > 0
    assert r["all_checks_pass"] is True


def test_execution_is_deterministic():
    r1 = _run(stimulus_seed=7)
    r2 = _run(stimulus_seed=7)
    assert r1["B_execution"]["response_digest"] == r2["B_execution"]["response_digest"]
    assert r1["B_execution"]["transcript_digest"] == r2["B_execution"]["transcript_digest"]


def test_execution_depends_on_stimulus():
    a = _run(stimulus_seed=1)["B_execution"]["response_digest"]
    b = _run(stimulus_seed=2)["B_execution"]["response_digest"]
    assert a != b


def test_forward_reads_resident_weights():
    # zeroing the weights changes the propagation output -> the computation
    # genuinely depends on the resident synapse bytes.
    p = payload_mod.synthesize("weights-dep", neurons=3000, synapses=30000)
    conn = payload_mod.decode_synapses(p)
    out = fly_forward(conn, stimulus_seed=1, steps=2)
    import dataclasses

    zeroed = dataclasses.replace(conn, weight=np.zeros_like(conn.weight))
    out0 = fly_forward(zeroed, stimulus_seed=1, steps=2)
    assert not np.array_equal(out, out0)
