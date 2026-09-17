"""End-to-end PoRW demo on a content-addressable fruit-fly-brain model.

The demo runs the full scheme-v2 loop against a real, content-addressable
weight payload held resident on the GPU (or on CPU in Triton interpreter mode
for a correctness smoke run):

  1. materialize the fly-brain weight bytes resident on the device;
  2. derive the public per-device slot seed from a challenge;
  3. sweep-sketch the covered tiles on the device (GPU-resident sweep kernel),
     cross-checked bit-for-bit against the NumPy reference;
  4. commit: weights Merkle root (model id) + coverage-ordered partials root;
  5. verify a committed opening (an audited tile is really committed);
  6. verify a tile fraud proof — honest tile -> NoFraud, tampered tile -> Fraud;
  7. verify a non-inclusion proof for an uncovered tile (sparse/MoE coverage).

What this proves: the exact model weight bytes were resident on the device and
the device could answer byte-level audits over them under a fresh public
challenge. What it does NOT prove: that the brain computes anything, or that a
user inference request was executed — inference execution is out of PoRW scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[3] / "gpu" / "triton"))

from porw_sketch import commit
from porw_sketch.spec import TILE_BYTES


def _device_id_from(name: str) -> bytes:
    """A stable 32-byte device id for the demo (a real node uses its node key)."""
    return hashlib.blake2b(("device:" + name).encode(), digest_size=32).digest()


def _select_device():
    try:
        import torch
    except ImportError:
        return None, "none"
    if torch.cuda.is_available():
        return torch, "cuda"
    return torch, "cpu"  # Triton interpreter path


def _resident_buffer(torch, device: str, buf: np.ndarray):
    """Place the weight bytes resident on the device and return the tensor."""
    t = torch.from_numpy(buf)
    if device == "cuda":
        t = t.to("cuda", non_blocking=False)
        torch.cuda.synchronize()
    return t


def _sweep_sketches(torch, device: str, buf_t, slot_seed: int, tile_ids_np: np.ndarray):
    """Device sweep over the coverage; returns (sketches u32, seconds)."""
    from porw_sketch.kernels import run_sketch_sweep

    tile_ids = torch.from_numpy(tile_ids_np.astype(np.int64))
    if device == "cuda":
        tile_ids = tile_ids.to("cuda")
        torch.cuda.synchronize()
        start = time.perf_counter()
        out = run_sketch_sweep(buf_t, slot_seed, tile_ids, copy_to_host=False)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        return out.cpu().numpy().view(np.uint32), elapsed
    start = time.perf_counter()
    out = run_sketch_sweep(buf_t, slot_seed, tile_ids, copy_to_host=True)
    return out, time.perf_counter() - start


def run(payload, *, challenge_hex: str, coverage_fraction: float, seed: int, attest: str = "none") -> dict:
    from .payload import Payload  # noqa: F401  (type reference)

    torch, device = _select_device()
    if torch is None:
        raise SystemExit("PyTorch is required (see gpu/triton/ENVIRONMENT.md)")
    if device == "cpu" and os.environ.get("TRITON_INTERPRET") != "1":
        raise SystemExit(
            "No CUDA device: set TRITON_INTERPRET=1 for a CPU correctness run"
        )

    rng = np.random.default_rng(seed)
    challenge = bytes.fromhex(challenge_hex.removeprefix("0x"))
    if len(challenge) != 32:
        raise SystemExit("challenge must be 32 bytes (64 hex chars)")
    device_id = _device_id_from(payload.name)
    slot_seed = commit.derive_slot_seed(challenge, device_id)

    n_tiles = payload.n_tiles
    all_tiles = payload.buf.reshape(n_tiles, TILE_BYTES)

    # Coverage set (strictly ascending). Full coverage = dense residency claim;
    # a subset models MoE/partial residency and exercises non-inclusion.
    if coverage_fraction >= 1.0:
        coverage = np.arange(n_tiles, dtype=np.int64)
    else:
        k = max(2, int(n_tiles * coverage_fraction))
        coverage = np.sort(rng.choice(n_tiles, size=min(k, n_tiles), replace=False)).astype(np.int64)
    coverage_bytes = int(coverage.size) * TILE_BYTES

    # --- residency + device sweep -------------------------------------------
    buf_t = _resident_buffer(torch, device, payload.buf)
    vram_bytes = payload.bytes_total if device == "cuda" else 0
    sketches, sweep_s = _sweep_sketches(torch, device, buf_t, slot_seed, coverage)

    # Reference cross-check: every covered tile's sketch matches NumPy exactly,
    # recomputed at the tile's real coverage index (not index 0).
    ref = np.array(
        [commit.sketch_one_tile(slot_seed, int(t), all_tiles[t].tobytes()) for t in coverage],
        dtype=np.uint32,
    )
    sweep_matches_reference = bool(np.array_equal(sketches, ref))

    # --- commitments --------------------------------------------------------
    weights_leaves = [commit.weights_leaf(int(t), all_tiles[t].tobytes()) for t in range(n_tiles)]
    weights_root = commit.merkle_root(weights_leaves)
    model_id = weights_root  # content address of the model

    partials_leaves = [
        commit.partials_leaf(int(coverage[i]), int(sketches[i])) for i in range(coverage.size)
    ]
    partials_root = commit.merkle_root(partials_leaves)

    report: dict = {
        "scheme": "aigg:porw:sketch-tile:v2",
        "device": device,
        "model": payload.summary(),
        "model_id": "0x" + model_id.hex(),
        "challenge": "0x" + challenge.hex(),
        "device_id": "0x" + device_id.hex(),
        "slot_seed": slot_seed,
        "coverage_tiles": int(coverage.size),
        "coverage_bytes": coverage_bytes,
        "weights_root": "0x" + weights_root.hex(),
        "partials_root": "0x" + partials_root.hex(),
        "sweep_seconds": round(sweep_s, 6),
        "sweep_matches_reference": sweep_matches_reference,
    }
    if device == "cuda" and sweep_s > 0:
        report["vram_resident_bytes"] = vram_bytes
        report["sweep_throughput_gib_s"] = round(coverage_bytes / sweep_s / (1 << 30), 3)

    # --- committed opening (inclusion) --------------------------------------
    audit_pos = int(rng.integers(0, coverage.size))
    audit_tile = int(coverage[audit_pos])
    opening_ok = commit.verify_committed_opening(
        partials_root,
        coverage.size,
        slot_seed,
        audit_tile,
        int(sketches[audit_pos]),
        commit.merkle_proof(partials_leaves, audit_pos),
        audit_pos,
    )
    report["opening"] = {"audited_tile": audit_tile, "position": audit_pos, "verified": opening_ok}

    # --- fraud proof --------------------------------------------------------
    # A tile fraud proof opens the CANONICAL tile bytes from the weights root
    # and the committed sketch from the partials root, then recomputes. Fraud =
    # a prover that committed a sketch which does not match the honest sketch of
    # its own committed weight bytes (it stored a cheaper summary, not the
    # bytes). We show both a truthful and a lying partials commitment over the
    # same, honest weights root.
    fraud_pos = int(rng.integers(0, coverage.size))
    fraud_tile = int(coverage[fraud_pos])
    canonical_bytes = all_tiles[fraud_tile].tobytes()
    weights_proof = commit.merkle_proof(weights_leaves, fraud_tile)

    # Honest partials commitment -> NoFraud.
    honest_verdict = commit.fraud_verdict(
        slot_seed, partials_root, weights_root, coverage.size, n_tiles,
        fraud_tile, canonical_bytes, int(sketches[fraud_pos]), fraud_pos,
        commit.merkle_proof(partials_leaves, fraud_pos), weights_proof,
    )
    # Lying partials commitment (corrupt just this tile's committed sketch) ->
    # Fraud: the bytes still open against the honest weights root, but the
    # committed sketch no longer matches their recomputation.
    lied_sketch = int((int(sketches[fraud_pos]) + 1) & 0xFFFFFFFF)
    lied_leaves = list(partials_leaves)
    lied_leaves[fraud_pos] = commit.partials_leaf(fraud_tile, lied_sketch)
    lied_root = commit.merkle_root(lied_leaves)
    tampered_verdict = commit.fraud_verdict(
        slot_seed, lied_root, weights_root, coverage.size, n_tiles,
        fraud_tile, canonical_bytes, lied_sketch, fraud_pos,
        commit.merkle_proof(lied_leaves, fraud_pos), weights_proof,
    )
    report["fraud_proof"] = {
        "tile": fraud_tile,
        "honest_verdict": honest_verdict,
        "tampered_verdict": tampered_verdict,
    }

    # --- non-inclusion (only meaningful with a coverage gap) ----------------
    gap = _find_gap(coverage)
    if gap is not None:
        li, challenged, ri_tile, ri_pos = gap
        ni_ok = commit.verify_non_inclusion(
            partials_root,
            coverage.size,
            challenged,
            {"tile_idx": int(coverage[li]), "s_tile": int(sketches[li]), "index": li},
            {"tile_idx": ri_tile, "s_tile": int(sketches[ri_pos]), "index": ri_pos},
            commit.merkle_proof(partials_leaves, li),
            commit.merkle_proof(partials_leaves, ri_pos),
        )
        report["non_inclusion"] = {"challenged_tile": challenged, "verified": ni_ok}
    else:
        report["non_inclusion"] = {"challenged_tile": None, "verified": None,
                                   "note": "full coverage: no uncovered tile to challenge"}

    # --- optional TEE-CPU execution attestation (composition layer) ---------
    # PoRW above proves residency; this binds an execution transcript (over the
    # SAME model_id) into a CPU-TEE attestation. Mock stage only — see attest.py.
    if attest == "mock":
        from .attest import ExecutionTranscript, MockCpuTeeAdapter
        import hashlib as _hl

        request_digest = _hl.blake2b(b"demo-request:sketch-the-fly-brain", digest_size=32).digest()
        response_digest = _hl.blake2b(
            b"demo-response:" + model_id + partials_root, digest_size=32
        ).digest()
        transcript = ExecutionTranscript(model_id, challenge, request_digest, response_digest)
        adapter = MockCpuTeeAdapter()
        proof, quote = adapter.attest(transcript)
        attest_ok = adapter.verify(proof, quote, transcript)
        # Rebinding to a different model must fail (the residency<->execution tie).
        wrong = ExecutionTranscript(bytes(32), challenge, request_digest, response_digest)
        rebind_rejected = not adapter.verify(proof, quote, wrong)
        report["execution_attestation"] = {
            **proof.summary(),
            "binds_verified": attest_ok,
            "rebind_to_other_model_rejected": rebind_rejected,
            "transcript_digest": "0x" + transcript.digest().hex(),
        }
    else:
        report["execution_attestation"] = None

    residency_ok = bool(
        sweep_matches_reference
        and opening_ok
        and honest_verdict == "no_fraud"
        and tampered_verdict == "fraud"
        and report["non_inclusion"]["verified"] in (True, None)
    )
    exec_att = report["execution_attestation"]
    execution_ok = exec_att is None or (
        exec_att["binds_verified"] and exec_att["rebind_to_other_model_rejected"]
    )
    report["residency_ok"] = residency_ok
    report["all_checks_pass"] = residency_ok and execution_ok
    return report


def _find_gap(coverage: np.ndarray):
    """Return (left_pos, challenged_tile, right_tile, right_pos) for the first
    adjacent covered pair with a gap between them, or None."""
    for i in range(coverage.size - 1):
        if coverage[i + 1] > coverage[i] + 1:
            return i, int(coverage[i]) + 1, int(coverage[i + 1]), i + 1
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", help="path to a real weight checkpoint (.safetensors/.npy/.npz/raw)")
    ap.add_argument("--name", default="flywire-adult-brain")
    ap.add_argument("--neurons", type=int, default=None, help="synthetic neuron count")
    ap.add_argument("--synapses", type=int, default=None, help="synthetic synapse count")
    ap.add_argument("--coverage-fraction", type=float, default=1.0)
    ap.add_argument("--challenge", default="00" * 31 + "2a", help="32-byte hex challenge")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--attest", choices=("none", "mock"), default="none",
                    help="add a TEE-CPU execution-proof layer (mock stage)")
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args(argv)

    from .payload import synthesize, from_checkpoint, FLYWIRE_NEURONS, FLYWIRE_SYNAPSES

    if args.checkpoint:
        payload = from_checkpoint(args.checkpoint, args.name)
    else:
        payload = synthesize(
            args.name,
            neurons=args.neurons or FLYWIRE_NEURONS,
            synapses=args.synapses or FLYWIRE_SYNAPSES,
        )

    report = run(
        payload,
        challenge_hex=args.challenge,
        coverage_fraction=args.coverage_fraction,
        seed=args.seed,
        attest=args.attest,
    )

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_summary(report)
    return 0 if report["all_checks_pass"] else 1


def _print_summary(r: dict) -> None:
    m = r["model"]
    print(f"PoRW end-to-end demo — {r['scheme']}  [{r['device']}]")
    print(f"  model         {m['name']}  ({m['source']})")
    print(f"  neurons/syn   {m['neurons']:,} / {m['synapses']:,}")
    print(f"  payload       {m['n_tiles']:,} tiles  {m['mib_total']} MiB")
    print(f"  model id      {r['model_id']}")
    print(f"  challenge     {r['challenge']}  -> slot_seed {r['slot_seed']}")
    print(f"  coverage      {r['coverage_tiles']:,} tiles  {r['coverage_bytes']:,} bytes")
    print(f"  device sweep  {r['sweep_seconds']}s  ref-match={r['sweep_matches_reference']}", end="")
    if "sweep_throughput_gib_s" in r:
        print(f"  {r['sweep_throughput_gib_s']} GiB/s (resident {r['vram_resident_bytes']:,} B)")
    else:
        print()
    o = r["opening"]; f = r["fraud_proof"]; ni = r["non_inclusion"]
    print(f"  opening       tile {o['audited_tile']} -> verified={o['verified']}")
    print(f"  fraud proof   tile {f['tile']} -> honest={f['honest_verdict']} tampered={f['tampered_verdict']}")
    print(f"  non-inclusion challenged={ni['challenged_tile']} -> verified={ni['verified']}")
    ea = r.get("execution_attestation")
    if ea is not None:
        hw = "hardware" if ea["is_hardware"] else "MOCK (not hardware)"
        print(f"  exec attest   {ea['verified_by']} [{hw}]  image={ea['image_measurement'][:18]}...")
        print(f"                binds={ea['binds_verified']}  rebind-rejected={ea['rebind_to_other_model_rejected']}")
    print(f"  residency     {'OK' if r['residency_ok'] else 'FAIL'}")
    print(f"  ALL CHECKS    {'PASS' if r['all_checks_pass'] else 'FAIL'}")


if __name__ == "__main__":
    raise SystemExit(main())
