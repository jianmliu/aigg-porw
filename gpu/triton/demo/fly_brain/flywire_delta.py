"""FLYDELTAv1 delta payloads (Python twin of web/porw-browser/delta.js): a fine-tune, an ablation or a synthetic
individual of a released FLYBRAINv2 brain as a small edit list bound to the base's model_id.

  MAGIC "FLYDELTAv1\\0\\0" | base model_id (32 B) | u64 neurons | u32 ops | u16 name_len | name
  | u16 base_da_len | base_da | ops: 10 B each: u32 pre | u32 post | i16 w      (sorted by (post, pre), unique)
  w != 0 sets the record (insert or replace); w == 0 deletes it (the base must have it). Neurons are unchanged.

  python flywire_delta.py diff  --base base.bin --target target.bin --out x.delta [--name NAME] [--base-da gnfd://...]
  python flywire_delta.py make  --base base.bin --ops ops.json --name NAME --out x.delta [--base-da ...]   ops.json: [[pre, post, w], ...]
  python flywire_delta.py apply --base base.bin --delta x.delta --out target.bin
  python flywire_delta.py info  --delta x.delta
apply writes exactly what flywire_export.py would (records sorted by (post, pre), 4 KiB padding), and every command
writes/prints a manifest with the base and result model ids (keccak weights Merkle root over 4 KiB tiles)."""
import argparse, hashlib, json, struct, sys
from pathlib import Path
import numpy as np
try: from Crypto.Hash import keccak as _keccak
except ImportError: _keccak = None
MAGIC_V2 = b"FLYBRAINv2\x00\x00"; MAGIC_DELTA = b"FLYDELTAv1\x00\x00"; TILE = 4096; REC = 10
def keccak256(b: bytes) -> bytes:
    if _keccak is None: raise SystemExit("pip install pycryptodome (keccak-256 for model ids)")
    h = _keccak.new(digest_bits=256); h.update(b); return h.digest()
def model_id(payload: bytes) -> bytes:
    """keccak weights Merkle root: leaf = keccak(LE64 tile_index || tile), odd node duplicated (verify.js merkleRoot)"""
    n = len(payload) // TILE; lvl = [keccak256(struct.pack("<Q", t) + payload[t * TILE:(t + 1) * TILE]) for t in range(n)]
    if not lvl: return keccak256(b"")
    while len(lvl) > 1: lvl = [keccak256(lvl[i] + (lvl[i + 1] if i + 1 < len(lvl) else lvl[i])) for i in range(0, len(lvl), 2)]
    return lvl[0]
def decode_payload(buf: bytes):
    if buf[:12] != MAGIC_V2: raise ValueError("not FLYBRAINv2")
    n, ns, nl = struct.unpack_from("<QQH", buf, 12); off = 30 + nl; name = buf[30:off].decode(); ids = buf[off:off + n * 8]; off += n * 8
    rec = np.frombuffer(buf, dtype=np.uint8, count=ns * REC, offset=off).reshape(ns, REC)
    pre = rec[:, 0:4].copy().view("<u4").reshape(-1).astype(np.int64); post = rec[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64); w = rec[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
    return dict(n=n, name=name, ids=ids, pre=pre, post=post, w=w)
def encode_records(pre, post, w):
    rec = np.zeros((len(w), REC), dtype=np.uint8); rec[:, 0:4] = pre.astype("<u4").view(np.uint8).reshape(-1, 4); rec[:, 4:8] = post.astype("<u4").view(np.uint8).reshape(-1, 4); rec[:, 8:10] = w.astype("<i2").view(np.uint8).reshape(-1, 2); return rec.tobytes()
def encode_payload(n: int, ids: bytes, name: str, pre, post, w) -> bytes:
    order = np.lexsort((pre, post)); pre, post, w = pre[order], post[order], w[order]
    name_b = name.encode(); raw = MAGIC_V2 + struct.pack("<QQH", n, len(w), len(name_b)) + name_b + ids + encode_records(pre, post, w)
    return raw + b"\x00" * ((-len(raw)) % TILE)
def encode_delta(base_model_id: bytes, n: int, name: str, base_da: str, pre, post, w) -> bytes:
    pre, post, w = (np.asarray(x, dtype=np.int64) for x in (pre, post, w)); order = np.lexsort((pre, post)); pre, post, w = pre[order], post[order], w[order]
    key = post * n + pre
    if len(key) and (np.any(np.diff(key) <= 0)): raise ValueError("duplicate op")
    if np.any((pre < 0) | (pre >= n) | (post < 0) | (post >= n)): raise ValueError("op out of range")
    if np.any((w < -32768) | (w > 32767)): raise ValueError("weight out of i16")
    name_b, da_b = name.encode(), base_da.encode()
    return MAGIC_DELTA + base_model_id + struct.pack("<QIH", n, len(w), len(name_b)) + name_b + struct.pack("<H", len(da_b)) + da_b + encode_records(pre, post, w)
def decode_delta(buf: bytes):
    if buf[:12] != MAGIC_DELTA: raise ValueError("not FLYDELTAv1")
    base_id = buf[12:44]; n, ops, nl = struct.unpack_from("<QIH", buf, 44); off = 58; name = buf[off:off + nl].decode(); off += nl
    dl, = struct.unpack_from("<H", buf, off); off += 2; base_da = buf[off:off + dl].decode(); off += dl
    if off + ops * REC != len(buf): raise ValueError("delta length mismatch")
    rec = np.frombuffer(buf, dtype=np.uint8, count=ops * REC, offset=off).reshape(ops, REC)
    pre = rec[:, 0:4].copy().view("<u4").reshape(-1).astype(np.int64); post = rec[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64); w = rec[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
    key = post * n + pre
    if np.any((pre >= n) | (post >= n)): raise ValueError("op out of range")
    if len(key) and np.any(np.diff(key) <= 0): raise ValueError("ops must be sorted by (post, pre) and unique")
    return dict(base_model_id=base_id, n=n, name=name, base_da=base_da, pre=pre, post=post, w=w)
def apply_delta(base: bytes, delta: bytes) -> bytes:
    B = decode_payload(base); D = decode_delta(delta)
    if B["n"] != D["n"]: raise ValueError(f"neuron count mismatch: base {B['n']}, delta {D['n']}")
    mid = model_id(base)
    if mid != D["base_model_id"]: raise ValueError(f"base model id mismatch: base 0x{mid.hex()}, delta binds 0x{D['base_model_id'].hex()}")
    n = B["n"]; bkey = B["post"] * n + B["pre"]; dkey = D["post"] * n + D["pre"]
    if np.any(np.diff(bkey) <= 0): raise ValueError("base records must be sorted by (post, pre) and unique")
    hit = np.isin(dkey, bkey); dele = D["w"] == 0
    if np.any(dele & ~hit): i = int(np.argmax(dele & ~hit)); raise ValueError(f"delete of a record the base lacks: pre {D['pre'][i]} post {D['post'][i]}")
    keep = ~np.isin(bkey, dkey); ins = ~dele
    pre = np.concatenate([B["pre"][keep], D["pre"][ins]]); post = np.concatenate([B["post"][keep], D["post"][ins]]); w = np.concatenate([B["w"][keep], D["w"][ins]])
    return encode_payload(n, B["ids"], D["name"], pre, post, w)
def diff_payloads(base: bytes, target: bytes, name=None, base_da="") -> bytes:
    B = decode_payload(base); T = decode_payload(target)
    if B["n"] != T["n"]: raise ValueError("neuron count differs")
    if B["ids"] != T["ids"]: raise ValueError("root ids differ")
    n = B["n"]; bkey = B["post"] * n + B["pre"]; tkey = T["post"] * n + T["pre"]
    bw = dict(zip(bkey.tolist(), B["w"].tolist())); tw = dict(zip(tkey.tolist(), T["w"].tolist()))
    ops = [(k, 0) for k in bw if k not in tw] + [(k, v) for k, v in tw.items() if bw.get(k) != v]
    key = np.array([k for k, _ in ops], dtype=np.int64); w = np.array([v for _, v in ops], dtype=np.int64)
    return encode_delta(model_id(base), n, name if name is not None else T["name"], base_da, key % n, key // n, w)
def manifest(delta: bytes, base: bytes, applied: bytes | None = None) -> dict:
    D = decode_delta(delta); m = dict(format="FLYDELTAv1", name=D["name"], bytes=len(delta), ops=int(len(D["w"])), deletes=int((D["w"] == 0).sum()), sets=int((D["w"] != 0).sum()), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    if applied is not None: m["result"] = dict(model_id="0x" + model_id(applied).hex(), sha256=hashlib.sha256(applied).hexdigest(), bytes=len(applied), tiles=len(applied) // TILE, synapse_records=int(decode_payload(applied)["w"].size))
    return m
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("diff"); d.add_argument("--base", type=Path, required=True); d.add_argument("--target", type=Path, required=True); d.add_argument("--out", type=Path, required=True); d.add_argument("--name"); d.add_argument("--base-da", default="")
    m = sub.add_parser("make"); m.add_argument("--base", type=Path, required=True); m.add_argument("--ops", type=Path, required=True); m.add_argument("--name", required=True); m.add_argument("--out", type=Path, required=True); m.add_argument("--base-da", default="")
    a = sub.add_parser("apply"); a.add_argument("--base", type=Path, required=True); a.add_argument("--delta", type=Path, required=True); a.add_argument("--out", type=Path, required=True)
    i = sub.add_parser("info"); i.add_argument("--delta", type=Path, required=True)
    x = ap.parse_args()
    if x.cmd == "info": print(json.dumps(manifest(x.delta.read_bytes(), None), indent=1)); return
    base = x.base.read_bytes()
    if x.cmd == "diff": delta = diff_payloads(base, x.target.read_bytes(), x.name, x.base_da)
    elif x.cmd == "make": ops = np.array(json.loads(x.ops.read_text()), dtype=np.int64).reshape(-1, 3); delta = encode_delta(model_id(base), decode_payload(base)["n"], x.name, x.base_da, ops[:, 0], ops[:, 1], ops[:, 2])
    else: delta = x.delta.read_bytes()
    applied = apply_delta(base, delta)
    if x.cmd == "apply": x.out.write_bytes(applied); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    else: x.out.write_bytes(delta); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    print(json.dumps(man, indent=1))
if __name__ == "__main__": main()
