"""Real FlyWire (FAFB v783) connectome -> PoRW payload v2 (`FLYBRAINv2`).

Sources (public, CC-BY-4.0):
  * Zenodo 10676866 "FlyWire Whole-brain Connectome Connectivity Data" (Dorkenwald et al. 2024):
      proofread_connections_783.feather  (pre_pt_root_id, post_pt_root_id, neuropil, syn_count,
                                          gaba_avg, ach_avg, glut_avg, oct_avg, ser_avg, da_avg)
      proofread_root_ids_783.npy         (the 139,255 proofread neurons)
  * flyconnectome/flywire_annotations Supplemental_file1_neuron_annotations.tsv (Schlegel et al. 2024):
      root_id, top_nt (per-neuron neurotransmitter prediction, Eckstein et al. 2024)

Layout (header identical to v1 so the residency/CSR tooling is shared):
  MAGIC "FLYBRAINv2\\0\\0" | u64 neurons | u64 synapses | u16 name_len | name
  neuron records  8 B : u64 FlyWire root id (index i -> root id; the payload is self-describing)
  synapse records 10 B: u32 pre | u32 post | i16 weight   — sorted by (post, pre)
  zero padding to a whole number of 4 KiB tiles

weight = sign(nt of the PRE neuron) * synapse count aggregated over neuropils, after the
min-count filter (default 5, the FlyWire/Codex and Shiu et al. 2024 convention).
Signs: gaba, glutamate -> -1; acetylcholine, dopamine, serotonin, octopamine, unknown -> +1
(Shiu et al. 2024). Neuron-level top_nt is used (Dale's law); a neuron without an
annotation falls back to the connection table's synapse-weighted neurotransmitter averages
(argmax over gaba/ach/glut/oct/ser/da), then to excitatory.

This is the model bytes a PoRW MEP pins (model_id = weights Merkle root of the tiles). The
export is deterministic: the same inputs and parameters always give the same bytes.
"""
from __future__ import annotations

import argparse, csv, hashlib, json, struct, time
from pathlib import Path

import numpy as np

MAGIC_V2 = b"FLYBRAINv2\x00\x00"
TILE = 4096
INHIBITORY = {"gaba", "glutamate"}
KNOWN = {"acetylcholine", "gaba", "glutamate", "dopamine", "serotonin", "octopamine"}


def load_top_nt(annotations_tsv: Path) -> dict[int, str]:
    out = {}
    with open(annotations_tsv, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            nt = (row.get("top_nt") or "").strip().lower()
            if nt:
                out[int(row["root_id"])] = nt
    return out


def export(connections: Path, root_ids: Path, annotations: Path | None, out: Path, name: str,
           min_syn: int = 5, max_neurons: int | None = None) -> dict:
    import pyarrow.feather as pf
    t0 = time.time()
    ids = np.load(root_ids).astype(np.uint64)
    ids = np.unique(ids)  # sorted, contiguous index i -> root id
    if max_neurons:
        ids = ids[:max_neurons]
    n = ids.size
    NT_COLS = ["gaba_avg", "ach_avg", "glut_avg", "oct_avg", "ser_avg", "da_avg"]
    NT_NAMES = ["gaba", "acetylcholine", "glutamate", "octopamine", "serotonin", "dopamine"]
    tbl = pf.read_table(connections, columns=["pre_pt_root_id", "post_pt_root_id", "syn_count"] + NT_COLS)
    pre_r = tbl.column("pre_pt_root_id").to_numpy().astype(np.uint64)
    post_r = tbl.column("post_pt_root_id").to_numpy().astype(np.uint64)
    cnt = tbl.column("syn_count").to_numpy().astype(np.int64)
    avgs = np.stack([tbl.column(c).to_numpy().astype(np.float64) for c in NT_COLS], axis=1)
    rows_in = pre_r.size
    # map root ids -> index; drop connections touching non-proofread (or excluded) neurons
    pre_i = np.searchsorted(ids, pre_r); post_i = np.searchsorted(ids, post_r)
    ok = (pre_i < n) & (post_i < n)
    ok &= (ids[np.minimum(pre_i, n - 1)] == pre_r) & (ids[np.minimum(post_i, n - 1)] == post_r)
    pre_i, post_i, cnt, avgs = pre_i[ok], post_i[ok], cnt[ok], avgs[ok]
    # aggregate across neuropils per (pre, post): counts summed, nt averages count-weighted
    key = post_i.astype(np.int64) * n + pre_i.astype(np.int64)
    order = np.argsort(key, kind="stable")
    key, cnt, avgs = key[order], cnt[order], avgs[order]
    uniq, start = np.unique(key, return_index=True)
    agg = np.add.reduceat(cnt, start)
    wavg = np.add.reduceat(avgs * cnt[:, None], start, axis=0)
    keep = agg >= min_syn
    uniq, agg, wavg = uniq[keep], agg[keep], wavg[keep]
    post = (uniq // n).astype(np.uint32); pre = (uniq % n).astype(np.uint32)
    # neurotransmitter of the PRE neuron: neuron-level top_nt (Dale), else connection-level argmax, else excitatory
    top = load_top_nt(annotations) if annotations else {}
    nt_code = np.full(n, -1, dtype=np.int64)  # index into NT_NAMES, -1 unknown
    code_of = {nm: k for k, nm in enumerate(NT_NAMES)}
    for i, rid in enumerate(ids.tolist()):
        c = code_of.get(top.get(rid, ""), -1)
        nt_code[i] = c
    pre_code = nt_code[pre]
    conn_code = np.argmax(wavg, axis=1)
    has_conn = wavg.max(axis=1) > 0
    use_neuron = pre_code >= 0
    code = np.where(use_neuron, pre_code, np.where(has_conn, conn_code, -1))
    src = {"neuron_top_nt": int(use_neuron.sum()), "connection_nt_argmax": int((~use_neuron & has_conn).sum()), "default_excitatory": int((code < 0).sum())}
    inhib = np.isin(code, [code_of["gaba"], code_of["glutamate"]])
    sign = np.where(inhib, -1, 1).astype(np.int64)
    w = np.clip(agg, 0, 32767) * sign
    # write payload
    name_b = name.encode()
    hdr = MAGIC_V2 + struct.pack("<QQH", n, uniq.size, len(name_b)) + name_b
    neurons = ids.astype("<u8").tobytes()
    rec = np.zeros((uniq.size, 10), dtype=np.uint8)
    rec[:, 0:4] = pre.astype("<u4").view(np.uint8).reshape(-1, 4)
    rec[:, 4:8] = post.astype("<u4").view(np.uint8).reshape(-1, 4)
    rec[:, 8:10] = w.astype("<i2").view(np.uint8).reshape(-1, 2)
    raw = hdr + neurons + rec.tobytes()
    raw += b"\x00" * ((-len(raw)) % TILE)
    out.write_bytes(raw)
    manifest = {
        "name": name, "format": "FLYBRAINv2", "bytes": len(raw), "tiles": len(raw) // TILE,
        "neurons": int(n), "synapse_records": int(uniq.size), "connection_rows_in": int(rows_in),
        "min_syn": min_syn, "total_synapses_kept": int(agg.sum()), "excitatory_records": int((sign > 0).sum()), "inhibitory_records": int((sign < 0).sum()),
        "sign_source": src, "max_abs_weight": int(np.abs(w).max()) if w.size else 0,
        "max_in_degree": int(np.bincount(post, minlength=n).max()) if w.size else 0,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "sources": {"connections": connections.name, "root_ids": root_ids.name, "annotations": annotations.name if annotations else None,
                    "zenodo": "10.5281/zenodo.10676866", "license": "CC-BY-4.0"},
        "sign_rule": "pre-neuron top_nt (Dale); gaba/glutamate -> -1, else +1 (Shiu et al. 2024)",
        "export_seconds": round(time.time() - t0, 1),
    }
    Path(str(out) + ".manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--connections", type=Path, required=True)
    ap.add_argument("--root-ids", type=Path, required=True)
    ap.add_argument("--annotations", type=Path, default=None)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--name", default="flywire-fafb-v783")
    ap.add_argument("--min-syn", type=int, default=5)
    ap.add_argument("--max-neurons", type=int, default=None, help="prefix of the sorted root-id list (small test exports)")
    a = ap.parse_args()
    m = export(a.connections, a.root_ids, a.annotations, a.out, a.name, a.min_syn, a.max_neurons)
    print(json.dumps(m, indent=2))


if __name__ == "__main__":
    main()
