"""FLYDELTAv1 delta payloads (Python twin of web/porw-browser/delta.js): a fine-tune, an ablation or a synthetic
individual of a released FLYBRAINv2 brain as a small edit list bound to the base's model_id.

  MAGIC "FLYDELTAv1\\0\\0" | base model_id (32 B) | u64 neurons | u32 ops | u16 name_len | name
  | u16 base_da_len | base_da | ops: 10 B each: u32 pre | u32 post | i16 w      (sorted by (post, pre), unique)
  w != 0 sets the record (insert or replace); w == 0 deletes it (the base must have it). Neurons are unchanged.

  python flywire_delta.py diff  --base base.bin --target target.bin --out x.delta [--name NAME] [--base-da gnfd://...]
  python flywire_delta.py make  --base base.bin --ops ops.json --name NAME --out x.delta [--base-da ...]   ops.json: [[pre, post, w], ...]
  python flywire_delta.py apply --base base.bin --delta x.delta --out target.bin
  python flywire_delta.py info  --delta x.delta
  python flywire_delta.py make2 --base base.bin --seed N --name NAME --out x.delta [--min-syn 5] [--mean-ratio 1.0] [--r-table r.json] [--ops ops.json] [--base-da ...]

FLYDELTAv2 is procedural: instead of an edit list it carries a seed and a noise model, and apply resamples every record's
synapse count as a synthetic individual (deterministic integer arithmetic: hash-driven uniforms, negative-binomial inverse
CDF in fixed point, bit-identical in JS and Python), then drops records below min_syn, then applies an optional explicit
op list (v1 semantics; deletes are lenient: a record the individual lacks is a no-op):

  MAGIC "FLYDELTAv2\0\0" | base model_id (32 B) | u64 neurons | u64 seed | u16 min_syn | u32 mean_ratio_q16 | u16 r_rows
  | rows: u32 c_from | u16 r_q8 (ascending c_from; for a base count c use the last row with c_from <= c; r = r_q8 / 256)
  | u32 ops | u16 name_len | name | u16 base_da_len | base_da | ops (10 B each)
  per record with count c = |w|: mean m = c * mean_ratio, shape r = r(c); U = hash64(seed, pre, post);
  c' = smallest k with CDF_NB(k; m, r) > U / 2^64 (CDF tabulated in Q256 fixed point, see nb_table); sign kept; clamp 32767.

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
# ---------------------------------------------------------------- FLYDELTAv2: procedural individuals ----------
MAGIC_DELTA2 = b"FLYDELTAv2\x00\x00"; GOLDEN32 = 0x9E3779B9; M32 = 0xFFFFFFFF
Q60 = 1 << 60; Q256 = 1 << 256; LN2_Q60 = 799144290325165978   # floor(ln 2 * 2^60)
DEFAULT_R_TABLE = [(1, 423), (2, 479), (3, 677), (5, 806), (8, 1015), (12, 1396), (20, 1991), (35, 2883), (60, 4132), (100, 4412)]  # (c_from, r*256): individual-level NB shape from FlyWire L/R mirror pairs, Var_ind = Var_pair / 2 (flyaudio results/individual/lr_conditional)
def fmix32(h):
    h &= M32; h ^= h >> 16; h = (h * 0x85EBCA6B) & M32; h ^= h >> 13; h = (h * 0xC2B2AE35) & M32; h ^= h >> 16; return h
def hash64(seed, pre, post):
    """64-bit uniform for a (pre, post) record under a 64-bit seed: two fmix32 chains, identity-based (not order-based)"""
    a = fmix32(((pre * GOLDEN32) + post) & M32 ^ (seed & M32)); b = fmix32((a ^ (seed >> 32) ^ 0x85EBCA6B) & M32); return (a << 32) | b
def ln_q60(num, den):
    """floor-ish fixed-point ln(num/den) in Q60 (num, den > 0 integers): x = y * 2^e with y in [1, 2), atanh series, 30 terms"""
    e = num.bit_length() - den.bit_length()
    if (num << (60 if e >= 0 else 60 - e)) < (den << (60 + e if e >= 0 else 60)): e -= 1   # ensure 2^e <= num/den
    Y = (num << (60 - e)) // den if e <= 60 else (num >> (e - 60)) // den   # y in Q60, [1, 2)
    T = ((Y - Q60) << 60) // (Y + Q60); T2 = (T * T) >> 60; p = T; acc = T
    for k in range(1, 31): p = (p * T2) >> 60; acc += p // (2 * k + 1)
    return 2 * acc + e * LN2_Q60
def exp_q256(y):
    """floor-ish fixed-point exp(y) for y <= 0 in Q60, result in Q256; y = n ln2 + f, f in [0, ln2), Taylor 40 terms"""
    n = y // LN2_Q60; f = y - n * LN2_Q60          # Python floor division; n <= 0
    term = Q60; acc = Q60
    for k in range(1, 41): term = (term * f) // (k * Q60); acc += term
    return (acc << (256 - 60)) >> (-n) if n <= 0 else (acc << (256 - 60 + n))
def r_of(c, rows):
    r = rows[0][1]
    for c_from, rq in rows:
        if c <= c_from - 1 and c_from > 1: break
        if c_from <= c: r = rq
    return r
def nb_table(c, R, MR, kmax=None):
    """CDF of the negative binomial with mean m = c*MR/65536 and shape r = R/256 as Q64 integers (numpy uint64):
    entry k = floor(2^64 * P(X <= k)); the table ends when P(k) underflows Q256 past the mean or at kmax."""
    if kmax is None: kmax = min(32767, 8 * c + 256)
    cMR = c * MR; pn, pd = 256 * R, 256 * R + cMR                      # p = r/(r+m) = 256R / (256R + c*MR)
    lnp = ln_q60(pn, pd); y = (R * lnp) // 256                          # r ln p, Q60, <= 0
    P = exp_q256(y); cum = P; out = [cum >> 192]; k = 0
    while k < kmax:
        num = (256 * k + R) * cMR; den = 256 * (k + 1) * pd; P = (P * num) // den; k += 1
        if P == 0 and 65536 * k > cMR: break
        cum += P; out.append(min(cum, Q256 - 1) >> 192)
    out[-1] = (1 << 64) - 1   # the tail beyond the table belongs to the last k by definition (the fixed-point P(0) is exact only to ~1e-9)
    return np.array(out, dtype=np.uint64)
def encode_delta2(base_model_id, n, name, base_da, seed, min_syn=5, mean_ratio_q16=65536, r_table=None, ops=None):
    rows = r_table or DEFAULT_R_TABLE
    if any(rows[i][0] >= rows[i + 1][0] for i in range(len(rows) - 1)) or rows[0][0] != 1: raise ValueError("r table rows must start at c=1 and ascend")
    if ops is None: ops = (np.zeros(0, np.int64),) * 3
    pre, post, w = (np.asarray(x, dtype=np.int64) for x in ops); order = np.lexsort((pre, post)); pre, post, w = pre[order], post[order], w[order]
    if len(w) and np.any(np.diff(post * n + pre) <= 0): raise ValueError("duplicate op")
    name_b, da_b = name.encode(), base_da.encode()
    hdr = MAGIC_DELTA2 + base_model_id + struct.pack("<QQHIH", n, seed, min_syn, mean_ratio_q16, len(rows)) + b"".join(struct.pack("<IH", cf, rq) for cf, rq in rows)
    return hdr + struct.pack("<I", len(w)) + struct.pack("<H", len(name_b)) + name_b + struct.pack("<H", len(da_b)) + da_b + encode_records(pre, post, w)
def decode_delta2(buf):
    if buf[:12] != MAGIC_DELTA2: raise ValueError("not FLYDELTAv2")
    base_id = buf[12:44]; n, seed, min_syn, mr, nrows = struct.unpack_from("<QQHIH", buf, 44); off = 68
    rows = [struct.unpack_from("<IH", buf, off + 6 * i) for i in range(nrows)]; off += 6 * nrows
    ops, = struct.unpack_from("<I", buf, off); off += 4; nl, = struct.unpack_from("<H", buf, off); off += 2; name = buf[off:off + nl].decode(); off += nl
    dl, = struct.unpack_from("<H", buf, off); off += 2; base_da = buf[off:off + dl].decode(); off += dl
    if off + ops * REC != len(buf): raise ValueError("delta length mismatch")
    rec = np.frombuffer(buf, dtype=np.uint8, count=ops * REC, offset=off).reshape(ops, REC)
    pre = rec[:, 0:4].copy().view("<u4").reshape(-1).astype(np.int64); post = rec[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64); w = rec[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
    if len(w) and np.any(np.diff(post * n + pre) <= 0): raise ValueError("ops must be sorted by (post, pre) and unique")
    return dict(base_model_id=base_id, n=n, seed=seed, min_syn=min_syn, mean_ratio_q16=mr, r_table=rows, name=name, base_da=base_da, pre=pre, post=post, w=w)
def sample_counts(pre, post, c, seed, mr, rows):
    """resampled counts for base counts c (int64 array); one CDF table per distinct c, vectorised search"""
    U = np.array([hash64(seed, int(a), int(b)) for a, b in zip(pre.tolist(), post.tolist())], dtype=np.uint64) if len(c) < 200000 else _hash64_vec(seed, pre, post)
    out = np.zeros(len(c), dtype=np.int64)
    for cv in np.unique(c):
        idx = np.nonzero(c == cv)[0]; tab = nb_table(int(cv), r_of(int(cv), rows), mr)
        k = np.searchsorted(tab, U[idx], side="right")            # number of entries <= U  ==  smallest k with cum_k > U
        out[idx] = np.minimum(k, len(tab) - 1)
    return np.minimum(out, 32767)
def _hash64_vec(seed, pre, post):
    def fm(h):
        h = h & M32; h ^= h >> np.uint64(16); h = (h * np.uint64(0x85EBCA6B)) & np.uint64(M32); h ^= h >> np.uint64(13); h = (h * np.uint64(0xC2B2AE35)) & np.uint64(M32); h ^= h >> np.uint64(16); return h
    pre = pre.astype(np.uint64); post = post.astype(np.uint64); M = np.uint64(M32)
    a = fm((((pre * np.uint64(GOLDEN32)) + post) & M) ^ np.uint64(seed & M32)); b = fm((a ^ np.uint64(seed >> 32) ^ np.uint64(0x85EBCA6B)) & M); return (a << np.uint64(32)) | b
def apply_delta2(base, delta):
    B = decode_payload(base); D = decode_delta2(delta)
    if B["n"] != D["n"]: raise ValueError(f"neuron count mismatch: base {B['n']}, delta {D['n']}")
    mid = model_id(base)
    if mid != D["base_model_id"]: raise ValueError(f"base model id mismatch: base 0x{mid.hex()}, delta binds 0x{D['base_model_id'].hex()}")
    n = B["n"]; c = np.abs(B["w"]); sign = np.sign(B["w"])
    c2 = sample_counts(B["pre"], B["post"], c, D["seed"], D["mean_ratio_q16"], D["r_table"]); keep = c2 >= D["min_syn"]
    pre, post, w = B["pre"][keep], B["post"][keep], sign[keep] * c2[keep]
    if len(D["w"]):   # explicit ops after sampling: set / insert / lenient delete
        bkey = post * n + pre; dkey = D["post"] * n + D["pre"]; keepb = ~np.isin(bkey, dkey); ins = D["w"] != 0
        pre = np.concatenate([pre[keepb], D["pre"][ins]]); post = np.concatenate([post[keepb], D["post"][ins]]); w = np.concatenate([w[keepb], D["w"][ins]])
    return encode_payload(n, B["ids"], D["name"], pre, post, w)
def apply_any(base, delta): return apply_delta2(base, delta) if delta[:12] == MAGIC_DELTA2 else apply_delta(base, delta)

def manifest(delta: bytes, base: bytes, applied: bytes | None = None) -> dict:
    if delta[:12] == MAGIC_DELTA2:
        D = decode_delta2(delta); m = dict(format="FLYDELTAv2", name=D["name"], bytes=len(delta), seed=D["seed"], min_syn=D["min_syn"], mean_ratio_q16=D["mean_ratio_q16"], r_table=[list(r) for r in D["r_table"]], ops=int(len(D["w"])), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    else:
        D = decode_delta(delta); m = dict(format="FLYDELTAv1", name=D["name"], bytes=len(delta), ops=int(len(D["w"])), deletes=int((D["w"] == 0).sum()), sets=int((D["w"] != 0).sum()), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    if applied is not None: m["result"] = dict(model_id="0x" + model_id(applied).hex(), sha256=hashlib.sha256(applied).hexdigest(), bytes=len(applied), tiles=len(applied) // TILE, synapse_records=int(decode_payload(applied)["w"].size))
    return m
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("diff"); d.add_argument("--base", type=Path, required=True); d.add_argument("--target", type=Path, required=True); d.add_argument("--out", type=Path, required=True); d.add_argument("--name"); d.add_argument("--base-da", default="")
    m = sub.add_parser("make"); m.add_argument("--base", type=Path, required=True); m.add_argument("--ops", type=Path, required=True); m.add_argument("--name", required=True); m.add_argument("--out", type=Path, required=True); m.add_argument("--base-da", default="")
    a = sub.add_parser("apply"); a.add_argument("--base", type=Path, required=True); a.add_argument("--delta", type=Path, required=True); a.add_argument("--out", type=Path, required=True)
    i = sub.add_parser("info"); i.add_argument("--delta", type=Path, required=True)
    m2 = sub.add_parser("make2"); m2.add_argument("--base", type=Path, required=True); m2.add_argument("--seed", type=int, required=True); m2.add_argument("--name", required=True); m2.add_argument("--out", type=Path, required=True); m2.add_argument("--min-syn", type=int, default=5); m2.add_argument("--mean-ratio", type=float, default=1.0); m2.add_argument("--r-table", type=Path); m2.add_argument("--ops", type=Path); m2.add_argument("--base-da", default=""); m2.add_argument("--no-apply", action="store_true", help="write the delta and its manifest without applying (no result ids)")
    x = ap.parse_args()
    if x.cmd == "info": print(json.dumps(manifest(x.delta.read_bytes(), None), indent=1)); return
    base = x.base.read_bytes()
    if x.cmd == "diff": delta = diff_payloads(base, x.target.read_bytes(), x.name, x.base_da)
    elif x.cmd == "make": ops = np.array(json.loads(x.ops.read_text()), dtype=np.int64).reshape(-1, 3); delta = encode_delta(model_id(base), decode_payload(base)["n"], x.name, x.base_da, ops[:, 0], ops[:, 1], ops[:, 2])
    elif x.cmd == "make2":
        ops = np.array(json.loads(x.ops.read_text()), dtype=np.int64).reshape(-1, 3) if x.ops else None; rows = [tuple(r) for r in json.loads(x.r_table.read_text())] if x.r_table else None
        delta = encode_delta2(model_id(base), decode_payload(base)["n"], x.name, x.base_da, x.seed, x.min_syn, int(round(x.mean_ratio * 65536)), rows, (ops[:, 0], ops[:, 1], ops[:, 2]) if ops is not None else None)
        if x.no_apply: x.out.write_bytes(delta); man = manifest(delta, base); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1)); print(json.dumps(man, indent=1)); return
    else: delta = x.delta.read_bytes()
    applied = apply_any(base, delta)
    if x.cmd == "apply": x.out.write_bytes(applied); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    else: x.out.write_bytes(delta); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    print(json.dumps(man, indent=1))
if __name__ == "__main__": main()
