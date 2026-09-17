"""PoRW CPU-DRAM residency experiment on the fruit-fly-brain model.

The CPU analog of the native-GPU benchmark: hold the fly-brain weights resident
and locked in DRAM, measure the DRAM sketch bandwidth that underpins the
residency argument, and run the full PoRW proof loop over the resident buffer.

  1. materialize the fly-brain weight bytes and lock them resident (mlock);
  2. derive the public per-device slot seed from a challenge;
  3. stream-sketch the whole model over DRAM, timed -> GiB/s (and a pure-read
     baseline), cross-checked bit-for-bit against the NumPy reference;
  4. turn the measured rate into the PoRW bandwidth envelope for a slot;
  5. commit (weights root = model id, partials root) and verify a committed
     opening + a tile fraud proof (honest -> NoFraud, lying -> Fraud).

What it proves: the exact model bytes were resident (locked) in DRAM and the
host could stream-audit them at the measured bandwidth under a fresh challenge.
What it does not prove: inference execution (out of PoRW scope). A CPU TEE
supplies the execution half — see ../../demo/fly_brain/ROADMAP-tee-cpu.md.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[2]))  # gpu/triton

from porw_sketch import commit
from porw_sketch.spec import TILE_BYTES
from demo.fly_brain.payload import synthesize, from_checkpoint, FLYWIRE_NEURONS, FLYWIRE_SYNAPSES
from experiments.cpu_memory import residency as R


def run(payload, *, challenge_hex: str, slot_ms: float, repeats: int, chunk_tiles: int) -> dict:
    challenge = bytes.fromhex(challenge_hex.removeprefix("0x"))
    if len(challenge) != 32:
        raise SystemExit("challenge must be 32 bytes (64 hex chars)")
    import hashlib

    device_id = hashlib.blake2b(("device:" + payload.name).encode(), digest_size=32).digest()
    slot_seed = commit.derive_slot_seed(challenge, device_id)

    buf = np.ascontiguousarray(payload.buf)
    n_tiles = payload.n_tiles

    rss_before = R.max_rss_bytes()
    locked = R.mlock(buf)
    rss_after = R.max_rss_bytes()

    bw = R.measure_dram_bandwidth(buf, slot_seed, repeats=repeats, chunk_tiles=chunk_tiles)

    # Full-coverage residency claim: sketch every tile.
    sketches = R.sketch_stream(buf, slot_seed, chunk_tiles).astype(np.uint32)
    # Reference cross-check on a sample of tiles (full recompute is redundant
    # with sketch_stream's own equality test, so sample to keep the run quick).
    tiles = buf.reshape(n_tiles, TILE_BYTES)
    sample = np.unique(np.linspace(0, n_tiles - 1, num=min(64, n_tiles)).astype(int))
    ref_ok = all(
        int(sketches[t]) == commit.sketch_one_tile(slot_seed, int(t), tiles[t].tobytes())
        for t in sample
    )

    coverage_bytes = n_tiles * TILE_BYTES
    # The residency physical ceiling is the memory *streaming* bandwidth (can
    # the device read every covered byte within the slot), i.e. the pure-read
    # rate — NOT the reference sketch's compute rate, which is a separate,
    # unoptimized-implementation metric reported below.
    env = R.envelope(coverage_bytes, bw.baseline_read_gib_s, slot_ms)

    # Commit.
    t_commit = time.perf_counter()
    weights_leaves = [commit.weights_leaf(int(t), tiles[t].tobytes()) for t in range(n_tiles)]
    weights_root = commit.merkle_root(weights_leaves)
    partials_leaves = [commit.partials_leaf(int(t), int(sketches[t])) for t in range(n_tiles)]
    partials_root = commit.merkle_root(partials_leaves)
    commit_s = time.perf_counter() - t_commit
    model_id = weights_root

    # Audit: a committed opening + honest/lying fraud verdicts on one tile.
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
    lied_root = commit.merkle_root(lied_leaves)
    tampered = commit.fraud_verdict(
        slot_seed, lied_root, weights_root, n_tiles, n_tiles, audit_tile,
        canonical, lied, audit_tile, commit.merkle_proof(lied_leaves, audit_tile), wproof,
    )

    if locked:
        R.munlock(buf)

    report = {
        "experiment": "porw-cpu-dram-residency",
        "scheme": "aigg:porw:sketch-tile:v2",
        "model": payload.summary(),
        "model_id": "0x" + model_id.hex(),
        "challenge": "0x" + challenge.hex(),
        "slot_seed": slot_seed,
        "residency": {
            "resident_bytes": int(buf.nbytes),
            "mlocked": locked,
            "max_rss_delta_bytes": int(rss_after - rss_before),
        },
        "dram_bandwidth": {
            # residency ceiling: pure streaming read of every resident byte
            "read_gib_s": bw.baseline_read_gib_s,
            # reference verification cost: the unoptimized NumPy sketch rate
            # (compute/allocation-bound, not memory-bound — an optimized CPU
            # SIMD kernel would be far higher; this is the reference impl)
            "reference_sketch_gib_s_median": bw.gib_s_median,
            "reference_sketch_gib_s_best": bw.gib_s_best,
            "reference_sketch_seconds_median": bw.seconds_median,
            "repeats": bw.repeats,
        },
        "envelope": env,
        "weights_root": "0x" + weights_root.hex(),
        "partials_root": "0x" + partials_root.hex(),
        "commit_seconds": round(commit_s, 3),
        "sweep_matches_reference": bool(ref_ok),
        "opening_verified": bool(opening_ok),
        "fraud_honest_verdict": honest,
        "fraud_tampered_verdict": tampered,
    }
    report["all_checks_pass"] = bool(
        ref_ok and opening_ok and honest == "no_fraud" and tampered == "fraud"
        and env["coverage_fits_slot"]
    )
    return report


def _print(r: dict) -> None:
    m = r["model"]; res = r["residency"]; bw = r["dram_bandwidth"]; env = r["envelope"]
    print(f"PoRW CPU-DRAM residency experiment — {r['scheme']}")
    print(f"  model         {m['name']}  ({m['source']})")
    print(f"  neurons/syn   {m['neurons']:,} / {m['synapses']:,}")
    print(f"  payload       {m['n_tiles']:,} tiles  {m['mib_total']} MiB")
    print(f"  model id      {r['model_id']}")
    print(f"  resident      {res['resident_bytes']:,} B  mlocked={res['mlocked']}")
    print(f"  DRAM read     {bw['read_gib_s']} GiB/s  (residency ceiling)")
    print(f"  ref sketch    {bw['reference_sketch_gib_s_median']} GiB/s  (unoptimized NumPy reference)")
    print(f"  envelope      slot {env['slot_ms']}ms -> {env['max_model_mib_per_slot']} MiB/slot  fits={env['coverage_fits_slot']}")
    print(f"  commit        {r['commit_seconds']}s  ref-match={r['sweep_matches_reference']}")
    print(f"  opening       verified={r['opening_verified']}")
    print(f"  fraud proof   honest={r['fraud_honest_verdict']} tampered={r['fraud_tampered_verdict']}")
    print(f"  ALL CHECKS    {'PASS' if r['all_checks_pass'] else 'FAIL'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", help="real weight checkpoint (.safetensors/.npy/.npz/raw)")
    ap.add_argument("--name", default="flywire-adult-brain")
    ap.add_argument("--neurons", type=int, default=None)
    ap.add_argument("--synapses", type=int, default=None)
    ap.add_argument("--slot-ms", type=float, default=100.0)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--chunk-tiles", type=int, default=4096)
    ap.add_argument("--challenge", default="00" * 31 + "2a")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

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
        slot_ms=args.slot_ms,
        repeats=args.repeats,
        chunk_tiles=args.chunk_tiles,
    )
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print(report)
    return 0 if report["all_checks_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
