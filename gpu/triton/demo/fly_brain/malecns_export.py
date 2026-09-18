"""Export the male Drosophila CNS connectome (Janelia FlyEM MaleCNS v1.0) as a FLYBRAINv2 payload — the male base.

Same layout and conventions as flywire_export.py, so the payload loads in the same node and runs aigg:exec:int-lif:v1:
  MAGIC "FLYBRAINv2\\0\\0" | u64 neurons | u64 synapses | u16 name_len | name
  neuron records 8 B: u64 body id                                  — index i = i-th body id in ascending order
  synapse records 10 B: u32 pre | u32 post | i16 weight            — sorted by (post, pre)
  zero padding to a whole number of 4 KiB tiles

Sources (flat-connectome release, https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/):
  connectome-weights-male-cns-v1.0-minconf-0.5.feather   body_pre, body_post, weight (one row per connected pair)
  body-annotations-male-cns-v1.0-minconf-0.5.feather     bodyId, superclass, type, flywireType, ...
  body-neurotransmitters-male-cns-v1.0.feather           body, consensus_nt, celltype_predicted_nt, predicted_nt, ...

Rules (each is recorded in the manifest):
  neurons  = annotation rows with a non-null `superclass` (166,700 in v1.0: the release's neurons, i.e. everything that is
             not an unresolved fragment or a non-neuronal object). The weights table itself spans 88 M bodies, almost all
             of them fragments.
  synapses = rows of the weights table with both ends in the neuron set and weight >= --min-syn (default 5, as the female
             export); self-connections are kept, as flywire_export.py keeps them.
  sign     = the PRE neuron's transmitter (Dale): consensus_nt, else the cell type's prediction, else the neuron's own
             prediction, else excitatory. Inhibitory = gaba, glutamate (the convention of the female export, Shiu et al.
             2024) and histamine (photoreceptors; the FlyWire predictions have no histamine class, this release does).
  weight   = clip(count, 0, 32767) * sign.

  python malecns_export.py --edges connectome-weights-...feather --annotations body-annotations-...feather \\
      --neurotransmitters body-neurotransmitters-...feather --out malecns-v1.0-min5.bin [--min-syn 5] [--name NAME]
"""
import argparse, hashlib, json, struct, time
from pathlib import Path
import numpy as np
import pyarrow as pa, pyarrow.compute as pc, pyarrow.feather as pf

MAGIC_V2 = b"FLYBRAINv2\x00\x00"; TILE = 4096
DEFAULT_INHIBITORY = ("gaba", "glutamate", "histamine")

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""): h.update(chunk)
    return h.hexdigest()

def export(edges: Path, annotations: Path, neurotransmitters: Path | None, out: Path, name: str, min_syn: int = 5, inhibitory=DEFAULT_INHIBITORY, hash_sources: bool = True):
    t0 = time.time()
    ann = pf.read_table(annotations, columns=["bodyId", "superclass"]).to_pandas()
    ids = np.sort(ann.loc[ann["superclass"].notna(), "bodyId"].to_numpy().astype(np.uint64)); n = ids.size
    if np.unique(ids).size != n: raise ValueError("duplicate body ids in the annotation table")
    # weights table: threshold first (152 M rows -> a few million), then keep pairs inside the neuron set
    tbl = pf.read_table(edges, columns=["body_pre", "body_post", "weight"]); rows_in = tbl.num_rows
    tbl = tbl.filter(pc.greater_equal(tbl["weight"], min_syn)); rows_thr = tbl.num_rows
    pre_b = tbl["body_pre"].to_numpy().astype(np.uint64); post_b = tbl["body_post"].to_numpy().astype(np.uint64); cnt = tbl["weight"].to_numpy().astype(np.int64); del tbl
    pre_i = np.searchsorted(ids, pre_b); post_i = np.searchsorted(ids, post_b)
    ok = (pre_i < n) & (post_i < n); ok &= (ids[np.minimum(pre_i, n - 1)] == pre_b) & (ids[np.minimum(post_i, n - 1)] == post_b)
    pre_i, post_i, cnt = pre_i[ok], post_i[ok], cnt[ok]
    key = post_i.astype(np.int64) * n + pre_i.astype(np.int64)
    if np.unique(key).size != key.size: raise ValueError("the weights table has duplicate (pre, post) rows")
    order = np.argsort(key, kind="stable"); pre_i, post_i, cnt = pre_i[order], post_i[order], cnt[order]
    # transmitter of the PRE neuron
    nt_code = np.full(n, "", dtype=object); src = {"consensus_nt": 0, "celltype_predicted_nt": 0, "predicted_nt": 0, "default_excitatory": 0}
    if neurotransmitters is not None:
        nt = pf.read_table(neurotransmitters, columns=["body", "consensus_nt", "celltype_predicted_nt", "predicted_nt"]).to_pandas()
        nt = nt[np.isin(nt["body"].to_numpy().astype(np.uint64), ids)]; pos = np.searchsorted(ids, nt["body"].to_numpy().astype(np.uint64))
        clean = lambda s: s.fillna("").astype(str).str.strip().str.lower().replace({"unclear": "", "unknown": "", "nan": "", "none": ""})
        for col in ["consensus_nt", "celltype_predicted_nt", "predicted_nt"]:
            v = clean(nt[col]).to_numpy(); take = (v != "") & (nt_code[pos] == ""); nt_code[pos[take]] = v[take]; src[col] = int(take.sum())
    src["default_excitatory"] = int((nt_code == "").sum())
    inhib_neuron = np.isin(nt_code, list(inhibitory)); sign = np.where(inhib_neuron[pre_i], -1, 1).astype(np.int64)
    w = np.clip(cnt, 0, 32767) * sign
    # write
    name_b = name.encode(); hdr = MAGIC_V2 + struct.pack("<QQH", n, w.size, len(name_b)) + name_b
    rec = np.zeros((w.size, 10), dtype=np.uint8)
    rec[:, 0:4] = pre_i.astype("<u4").view(np.uint8).reshape(-1, 4); rec[:, 4:8] = post_i.astype("<u4").view(np.uint8).reshape(-1, 4); rec[:, 8:10] = w.astype("<i2").view(np.uint8).reshape(-1, 2)
    raw = hdr + ids.astype("<u8").tobytes() + rec.tobytes(); raw += b"\x00" * ((-len(raw)) % TILE); out.write_bytes(raw)
    connected = np.zeros(n, dtype=bool); connected[pre_i] = True; connected[post_i] = True
    vals, counts = np.unique(nt_code[nt_code != ""], return_counts=True)
    manifest = {
        "name": name, "format": "FLYBRAINv2", "bytes": len(raw), "tiles": len(raw) // TILE, "neurons": int(n), "synapse_records": int(w.size), "sha256": hashlib.sha256(raw).hexdigest(),
        "dataset": "Janelia FlyEM MaleCNS v1.0 (flat connectome, minconf 0.5)", "sex": "male", "coverage": "brain and ventral nerve cord",
        "rules": {"neurons": "annotation rows with non-null superclass", "min_syn": min_syn, "inhibitory_nt": list(inhibitory), "sign": "pre neuron: consensus_nt, else celltype_predicted_nt, else predicted_nt, else excitatory", "weight": "clip(count, 0, 32767) * sign", "order": "records sorted by (post, pre); neuron index = rank of body id"},
        "counts": {"weights_rows_in": int(rows_in), "rows_at_threshold": int(rows_thr), "rows_between_neurons": int(w.size), "synapses_total": int(cnt.sum()), "inhibitory_records": int((sign < 0).sum()), "inhibitory_neurons": int(inhib_neuron.sum()), "neurons_with_a_record": int(connected.sum()), "max_count": int(cnt.max()), "clipped": int((cnt > 32767).sum()), "self_connections": int((pre_i == post_i).sum())},
        "transmitter_source": src, "transmitters": {str(k): int(v) for k, v in zip(vals, counts)},
        "sources": {p.name: ({"bytes": p.stat().st_size, "sha256": sha256_file(p)} if hash_sources else {"bytes": p.stat().st_size}) for p in [edges, annotations] + ([neurotransmitters] if neurotransmitters else [])},
        "export_seconds": round(time.time() - t0, 1),
    }
    Path(str(out) + ".manifest.json").write_text(json.dumps(manifest, indent=2)); return manifest

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--edges", type=Path, required=True); ap.add_argument("--annotations", type=Path, required=True); ap.add_argument("--neurotransmitters", type=Path, default=None)
    ap.add_argument("--out", type=Path, required=True); ap.add_argument("--name", default=None); ap.add_argument("--min-syn", type=int, default=5)
    ap.add_argument("--inhibitory", default=",".join(DEFAULT_INHIBITORY), help="comma-separated transmitters treated as inhibitory"); ap.add_argument("--no-source-hash", action="store_true")
    a = ap.parse_args(); name = a.name or f"malecns-v1.0-min{a.min_syn}"
    m = export(a.edges, a.annotations, a.neurotransmitters, a.out, name, a.min_syn, tuple(x.strip().lower() for x in a.inhibitory.split(",") if x.strip()), not a.no_source_hash)
    print(json.dumps(m, indent=2))

if __name__ == "__main__": main()
