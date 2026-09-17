"""Pure-CPU end-to-end verifiable stack on the fruit-fly-brain model.

One command, no GPU, that composes both halves of a verifiable-compute claim
over the SAME content-addressed model:

  A. RESIDENCY (cryptographic, no TEE) — the exact model bytes are held resident
     and locked in DRAM (mlock), stream-audited at the measured DRAM bandwidth
     under a fresh public challenge; the full PoRW proof loop passes.

  B. EXECUTION (CPU TEE) — a deterministic connectome propagation is run over
     the resident weights (a real read of the resident synapse bytes), and its
     transcript (bound to the same model_id) is attested by a CPU TEE.

Because both halves carry the same model_id (the weights Merkle root), the
attestation cannot be about a different model than the one proven resident. The
result is a fully CPU-based stack: residency in DRAM + execution in a CPU TEE,
no GPU in the loop.

Stage: residency is real and measured; the TEE step is the mock adapter (see
ROADMAP-tee-cpu.md for the path to real TDX/SNP quotes). The connectome
propagation is a real, deterministic CPU computation over the resident bytes;
it is a signal-propagation stand-in, not a trained behavioral inference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[2]))  # gpu/triton

from porw_sketch import commit
from porw_sketch.spec import TILE_BYTES
from demo.fly_brain.payload import synthesize, decode_synapses, FLYWIRE_NEURONS, FLYWIRE_SYNAPSES
from demo.fly_brain.attest import ExecutionTranscript, MockCpuTeeAdapter
from experiments.cpu_memory import residency as R


def fly_forward(conn, stimulus_seed: int, steps: int) -> np.ndarray:
    """A deterministic connectome propagation over the resident synapses.

    Seeds a sparse set of input neurons and propagates activation along the
    synapse list for ``steps`` steps: ``a'[post] += weight * a[pre]``, followed
    by a tanh nonlinearity. Reads every resident synapse record each step, so
    the computation genuinely depends on the resident weight bytes. float64 and
    a fixed reduction order make it reproducible.
    """
    n = conn.neurons
    rng = np.random.default_rng(stimulus_seed)
    act = np.zeros(n, dtype=np.float64)
    seeds = rng.choice(n, size=max(1, n // 100), replace=False)
    act[seeds] = 1.0
    for _ in range(steps):
        nxt = np.zeros(n, dtype=np.float64)
        np.add.at(nxt, conn.post, conn.weight * act[conn.pre])
        act = np.tanh(nxt)
    return act


def _digest(a: np.ndarray) -> bytes:
    from blake3 import blake3

    return blake3(np.ascontiguousarray(a).tobytes()).digest()


def run(payload, *, challenge_hex: str, slot_ms: float, steps: int, stimulus_seed: int,
        repeats: int, chunk_tiles: int) -> dict:
    challenge = bytes.fromhex(challenge_hex.removeprefix("0x"))
    if len(challenge) != 32:
        raise SystemExit("challenge must be 32 bytes (64 hex chars)")
    device_id = hashlib.blake2b(("device:" + payload.name).encode(), digest_size=32).digest()
    slot_seed = commit.derive_slot_seed(challenge, device_id)

    buf = np.ascontiguousarray(payload.buf)
    n_tiles = payload.n_tiles
    tiles = buf.reshape(n_tiles, TILE_BYTES)

    # ---- A. residency (mlock + DRAM bandwidth + PoRW proof loop) -----------
    locked = R.mlock(buf)
    bw = R.measure_dram_bandwidth(buf, slot_seed, repeats=repeats, chunk_tiles=chunk_tiles)
    sketches = R.sketch_stream(buf, slot_seed, chunk_tiles).astype(np.uint32)
    coverage_bytes = n_tiles * TILE_BYTES
    env = R.envelope(coverage_bytes, bw.baseline_read_gib_s, slot_ms)

    weights_leaves = [commit.weights_leaf(int(t), tiles[t].tobytes()) for t in range(n_tiles)]
    weights_root = commit.merkle_root(weights_leaves)
    model_id = weights_root
    partials_leaves = [commit.partials_leaf(int(t), int(sketches[t])) for t in range(n_tiles)]
    partials_root = commit.merkle_root(partials_leaves)

    audit_tile = n_tiles // 3
    opening_ok = commit.verify_committed_opening(
        partials_root, n_tiles, slot_seed, audit_tile, int(sketches[audit_tile]),
        commit.merkle_proof(partials_leaves, audit_tile), audit_tile,
    )
    canonical = tiles[audit_tile].tobytes()
    wproof = commit.merkle_proof(weights_leaves, audit_tile)
    honest = commit.fraud_verdict(
        slot_seed, partials_root, weights_root, n_tiles, n_tiles, audit_tile,
        canonical, int(sketches[audit_tile]), audit_tile,
        commit.merkle_proof(partials_leaves, audit_tile), wproof,
    )
    lied = int((int(sketches[audit_tile]) + 1) & 0xFFFFFFFF)
    lied_leaves = list(partials_leaves)
    lied_leaves[audit_tile] = commit.partials_leaf(audit_tile, lied)
    tampered = commit.fraud_verdict(
        slot_seed, commit.merkle_root(lied_leaves), weights_root, n_tiles, n_tiles,
        audit_tile, canonical, lied, audit_tile, commit.merkle_proof(lied_leaves, audit_tile), wproof,
    )
    residency_ok = bool(
        opening_ok and honest == "no_fraud" and tampered == "fraud" and env["coverage_fits_slot"]
    )

    # ---- B. execution over the resident weights + CPU-TEE attestation ------
    conn = decode_synapses(payload)
    t0 = time.perf_counter()
    output = fly_forward(conn, stimulus_seed, steps)
    infer_s = time.perf_counter() - t0
    request_digest = hashlib.blake2b(
        b"stimulus:" + stimulus_seed.to_bytes(8, "little") + steps.to_bytes(4, "little"),
        digest_size=32,
    ).digest()
    response_digest = _digest(output)

    transcript = ExecutionTranscript(model_id, challenge, request_digest, response_digest)
    adapter = MockCpuTeeAdapter()
    proof, quote = adapter.attest(transcript)
    attest_ok = adapter.verify(proof, quote, transcript)
    wrong = ExecutionTranscript(bytes(32), challenge, request_digest, response_digest)
    rebind_rejected = not adapter.verify(proof, quote, wrong)
    execution_ok = bool(attest_ok and rebind_rejected)

    if locked:
        R.munlock(buf)

    return {
        "stack": "pure-cpu-verifiable",
        "scheme": "aigg:porw:sketch-tile:v2",
        "model": payload.summary(),
        "model_id": "0x" + model_id.hex(),
        "challenge": "0x" + challenge.hex(),
        "slot_seed": slot_seed,
        "A_residency": {
            "resident_bytes": int(buf.nbytes),
            "mlocked": locked,
            "dram_read_gib_s": bw.baseline_read_gib_s,
            "reference_sketch_gib_s": bw.gib_s_median,
            "envelope": env,
            "opening_verified": bool(opening_ok),
            "fraud_honest_verdict": honest,
            "fraud_tampered_verdict": tampered,
            "ok": residency_ok,
        },
        "B_execution": {
            "computation": "connectome-propagation",
            "neurons": conn.neurons,
            "synapses": conn.synapses,
            "steps": steps,
            "inference_seconds": round(infer_s, 4),
            "request_digest": "0x" + request_digest.hex(),
            "response_digest": "0x" + response_digest.hex(),
            "attestation": {**proof.summary(), "binds_verified": attest_ok,
                            "rebind_to_other_model_rejected": rebind_rejected},
            "transcript_digest": "0x" + transcript.digest().hex(),
            "ok": execution_ok,
        },
        "all_checks_pass": residency_ok and execution_ok,
    }


def _print(r: dict) -> None:
    m = r["model"]; A = r["A_residency"]; B = r["B_execution"]; e = A["envelope"]
    print(f"Pure-CPU verifiable stack — {r['scheme']}")
    print(f"  model         {m['name']}  ({m['source']})  {m['n_tiles']:,} tiles  {m['mib_total']} MiB")
    print(f"  model id      {r['model_id']}")
    print(f"  challenge     {r['challenge']}  -> slot_seed {r['slot_seed']}")
    print(f"  --- A. residency (cryptographic, no TEE) ---")
    print(f"  resident      {A['resident_bytes']:,} B  mlocked={A['mlocked']}")
    print(f"  DRAM read     {A['dram_read_gib_s']} GiB/s (residency ceiling)")
    print(f"  envelope      slot {e['slot_ms']}ms -> {e['max_model_mib_per_slot']} MiB/slot  fits={e['coverage_fits_slot']}")
    print(f"  proof loop    opening={A['opening_verified']} honest={A['fraud_honest_verdict']} tampered={A['fraud_tampered_verdict']}")
    print(f"  residency     {'OK' if A['ok'] else 'FAIL'}")
    print(f"  --- B. execution (CPU TEE) ---")
    hw = "hardware" if B["attestation"]["is_hardware"] else "MOCK (not hardware)"
    print(f"  inference     {B['computation']}  {B['neurons']:,} neurons x {B['steps']} steps  {B['inference_seconds']}s")
    print(f"  response      {B['response_digest'][:22]}...")
    print(f"  attestation   {B['attestation']['verified_by']} [{hw}]  binds={B['attestation']['binds_verified']} rebind-rejected={B['attestation']['rebind_to_other_model_rejected']}")
    print(f"  execution     {'OK' if B['ok'] else 'FAIL'}")
    print(f"  ALL CHECKS    {'PASS' if r['all_checks_pass'] else 'FAIL'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", default="flywire-adult-brain")
    ap.add_argument("--neurons", type=int, default=None)
    ap.add_argument("--synapses", type=int, default=None)
    ap.add_argument("--slot-ms", type=float, default=100.0)
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--stimulus-seed", type=int, default=1)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--chunk-tiles", type=int, default=4096)
    ap.add_argument("--challenge", default="00" * 31 + "2a")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    payload = synthesize(
        args.name,
        neurons=args.neurons or FLYWIRE_NEURONS,
        synapses=args.synapses or FLYWIRE_SYNAPSES,
    )
    r = run(
        payload,
        challenge_hex=args.challenge,
        slot_ms=args.slot_ms,
        steps=args.steps,
        stimulus_seed=args.stimulus_seed,
        repeats=args.repeats,
        chunk_tiles=args.chunk_tiles,
    )
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        _print(r)
    return 0 if r["all_checks_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
