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

FLYDELTAv3 is a cross: the child of two individuals of the SAME base (their deltas, by keccak id; 32 zero bytes = the
published base itself). Inheritance acts on genotypes = the count of every base record before the min_syn threshold:
  per inheritance unit (record | pre neuron | post neuron) one hash bit picks parent A or B; then each record mutates with
  probability mut_rate (a fresh v2 draw around the BASE count, so the population is stationary); phenotype = counts >= min_syn.
  MAGIC "FLYDELTAv3\0\0" | base model_id | u64 neurons | parent A id (32 B) | parent B id (32 B) | u64 seed | u8 granularity
  | u8 layout | u16 min_syn | u32 mut_rate_q32 | u32 mean_ratio_q16 | u16 r_rows | rows | u32 ops | u16 name_len | name | u16 da_len | da | ops
  Parents must carry no explicit ops (their genotype would not be base-indexed). Ancestors are resolved by delta id.
  layout 0 = compact (records below min_syn dropped, the rest re-packed). layout 1 = IN PLACE: every base record stays at the
  base's byte offset, a record the individual lacks has weight 0, the name has the base's byte length; so record j of a child
  is a function of record j of the base and of its parents' payloads (recompute_record) -- the property that lets a wrong
  declared model_id be shown wrong from one record (proposals/flydelta-inplace). In-place lineages are closed: parents are the
  base or in-place crosses with min_syn <= the child's; no explicit ops. A founder = base x base with mut_rate 1.0
  (mut_rate_q32 = 0xFFFFFFFF means "every record mutates"): a fresh draw everywhere.
  python flywire_delta.py make3 --base base.bin --parent-a a.delta --parent-b b.delta|base --seed N --name NAME --out c.delta
                                [--granularity record|pre|post] [--mut-rate 0.125] [--layout compact|inplace] [--parents more.delta ...]
  python flywire_delta.py make3 --base base.bin --founder --layout inplace --seed N --name NAME --out f.delta   (the name is fitted to the base's length)
  python flywire_delta.py apply --base base.bin --delta c.delta --out c.bin --parents a.delta b.delta [...ancestors]

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
    h1 = fmix32((((pre * GOLDEN32) + post) & M32) ^ (seed & M32)); a = fmix32(h1 ^ ((seed >> 32) & M32)); b = fmix32((((post * GOLDEN32) + pre) & M32) ^ a ^ 0x85EBCA6B); return (a << 32) | b   # both seed words reach the high word; the low word hashes the swapped key
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
def _hash64_vec(seed, a_key, b_key):
    def fm(h):
        h = h & M32; h ^= h >> np.uint64(16); h = (h * np.uint64(0x85EBCA6B)) & np.uint64(M32); h ^= h >> np.uint64(13); h = (h * np.uint64(0xC2B2AE35)) & np.uint64(M32); h ^= h >> np.uint64(16); return h
    a_key = np.asarray(a_key).astype(np.uint64); b_key = np.asarray(b_key).astype(np.uint64); M = np.uint64(M32)
    h1 = fm((((a_key * np.uint64(GOLDEN32)) + b_key) & M) ^ np.uint64(seed & M32)); a = fm(h1 ^ np.uint64((seed >> 32) & M32)); b = fm((((b_key * np.uint64(GOLDEN32)) + a_key) & M) ^ a ^ np.uint64(0x85EBCA6B)); return (a << np.uint64(32)) | b
def sample_with_u(c, U, mr, rows):
    """counts drawn for means c (int64 array) from uniforms U (uint64): one CDF table per distinct c, vectorised search"""
    out = np.zeros(len(c), dtype=np.int64)
    for cv in np.unique(c):
        idx = np.nonzero(c == cv)[0]; tab = nb_table(int(cv), r_of(int(cv), rows), mr)
        out[idx] = np.minimum(np.searchsorted(tab, U[idx], side="right"), len(tab) - 1)   # smallest k with cum_k > U
    return np.minimum(out, 32767)
def sample_counts(pre, post, c, seed, mr, rows): return sample_with_u(c, _hash64_vec(seed, pre, post), mr, rows)
# ---------------------------------------------------------------- FLYDELTAv3: same-base cross --------------------
MAGIC_DELTA3 = b"FLYDELTAv3\x00\x00"; ZERO_ID = b"\x00" * 32; GRAN = {"record": 0, "pre": 1, "post": 2}; LAYOUT = {"compact": 0, "inplace": 1}; MUT_ALWAYS = 0xFFFFFFFF
DOM_PICK, DOM_MUT, DOM_DRAW = 0x5049434B, 0x4D555421, 0x44524157   # seed-domain separation: XORed into both words of the seed
def _dom(seed, d): return seed ^ (d << 32) ^ d
def delta_id(delta: bytes) -> bytes: return keccak256(delta)
def encode_delta3(base_model_id, n, name, base_da, parent_a, parent_b, seed, granularity=0, min_syn=5, mut_rate_q32=1 << 29, mean_ratio_q16=65536, r_table=None, ops=None, layout=0):
    rows = r_table or DEFAULT_R_TABLE
    if any(rows[i][0] >= rows[i + 1][0] for i in range(len(rows) - 1)) or rows[0][0] != 1: raise ValueError("r table rows must start at c=1 and ascend")
    if layout not in (0, 1) or (layout == 1 and ops is not None and len(ops[2])): raise ValueError("bad layout, or explicit ops in an in-place delta")
    if len(parent_a) != 32 or len(parent_b) != 32 or granularity not in (0, 1, 2) or not 0 <= mut_rate_q32 < (1 << 32): raise ValueError("bad cross parameters")
    if ops is None: ops = (np.zeros(0, np.int64),) * 3
    pre, post, w = (np.asarray(x, dtype=np.int64) for x in ops); order = np.lexsort((pre, post)); pre, post, w = pre[order], post[order], w[order]
    if len(w) and np.any(np.diff(post * n + pre) <= 0): raise ValueError("duplicate op")
    name_b, da_b = name.encode(), base_da.encode()
    hdr = MAGIC_DELTA3 + base_model_id + struct.pack("<Q", n) + parent_a + parent_b + struct.pack("<QBBHIIH", seed, granularity, layout, min_syn, mut_rate_q32, mean_ratio_q16, len(rows)) + b"".join(struct.pack("<IH", cf, rq) for cf, rq in rows)
    return hdr + struct.pack("<I", len(w)) + struct.pack("<H", len(name_b)) + name_b + struct.pack("<H", len(da_b)) + da_b + encode_records(pre, post, w)
def decode_delta3(buf):
    if buf[:12] != MAGIC_DELTA3: raise ValueError("not FLYDELTAv3")
    base_id = buf[12:44]; n, = struct.unpack_from("<Q", buf, 44); pa, pb = buf[52:84], buf[84:116]
    seed, gran, layout, min_syn, mut, mr, nrows = struct.unpack_from("<QBBHIIH", buf, 116); off = 116 + 22
    if gran not in (0, 1, 2): raise ValueError("bad granularity")
    if layout not in (0, 1): raise ValueError("bad layout")
    rows = [struct.unpack_from("<IH", buf, off + 6 * i) for i in range(nrows)]; off += 6 * nrows
    ops, = struct.unpack_from("<I", buf, off); off += 4; nl, = struct.unpack_from("<H", buf, off); off += 2; name = buf[off:off + nl].decode(); off += nl
    dl, = struct.unpack_from("<H", buf, off); off += 2; base_da = buf[off:off + dl].decode(); off += dl
    if off + ops * REC != len(buf): raise ValueError("delta length mismatch")
    rec = np.frombuffer(buf, dtype=np.uint8, count=ops * REC, offset=off).reshape(ops, REC)
    pre = rec[:, 0:4].copy().view("<u4").reshape(-1).astype(np.int64); post = rec[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64); w = rec[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
    if len(w) and np.any(np.diff(post * n + pre) <= 0): raise ValueError("ops must be sorted by (post, pre) and unique")
    if layout == 1 and ops: raise ValueError("an in-place delta carries no explicit ops")
    return dict(base_model_id=base_id, n=n, parent_a=pa, parent_b=pb, seed=seed, granularity=gran, layout=layout, min_syn=min_syn, mut_rate_q32=mut, mean_ratio_q16=mr, r_table=rows, name=name, base_da=base_da, pre=pre, post=post, w=w)
def genotype(B, base_mid, delta, parents=None, cache=None, as_parent=False, child=None):
    """count of every base record for a procedural delta (compact: before min_syn; in-place: the payload's own |weights|, already
    thresholded -- picking commutes with thresholding, so both layouts express the same child). parents: {delta id -> bytes}"""
    parents = parents or {}; cache = {} if cache is None else cache; did = delta_id(delta)
    magic = delta[:12]; D = decode_delta2(delta) if magic == MAGIC_DELTA2 else decode_delta3(delta) if magic == MAGIC_DELTA3 else None
    if D is None: raise ValueError("a genotype needs a procedural delta (v2 or v3)")
    if D["n"] != B["n"]: raise ValueError(f"neuron count mismatch: base {B['n']}, delta {D['n']}")
    if D["base_model_id"] != base_mid: raise ValueError(f"base model id mismatch: base 0x{base_mid.hex()}, delta binds 0x{D['base_model_id'].hex()}")
    if as_parent and len(D["w"]): raise ValueError("a parent must carry no explicit ops")
    if child is not None:
        if D.get("layout", 0) != child["layout"]: raise ValueError("a lineage keeps one layout: " + ("an in-place child needs in-place parents" if child["layout"] else "a compact child needs compact parents"))
        if child["layout"] == 1 and D["min_syn"] > child["min_syn"]: raise ValueError(f"an in-place child's min_syn ({child['min_syn']}) must be >= its parents' ({D['min_syn']})")
    if did in cache: return cache[did]
    c = np.abs(B["w"])
    if magic == MAGIC_DELTA2: g = sample_counts(B["pre"], B["post"], c, D["seed"], D["mean_ratio_q16"], D["r_table"])
    else:
        def par(pid):
            if pid == ZERO_ID: return c
            if pid not in parents: raise ValueError(f"parent delta 0x{pid.hex()} not provided")
            return genotype(B, base_mid, parents[pid], parents, cache, as_parent=True, child=D)
        gA, gB = par(D["parent_a"]), par(D["parent_b"]); seed = D["seed"]; FF = np.full(len(c), M32, dtype=np.int64)
        ka, kb = (B["pre"], B["post"]) if D["granularity"] == 0 else (B["pre"], FF) if D["granularity"] == 1 else (FF, B["post"])
        from_a = (_hash64_vec(_dom(seed, DOM_PICK), ka, kb) >> np.uint64(63)) == 0; g = np.where(from_a, gA, gB)
        mut = np.ones(len(c), dtype=bool) if D["mut_rate_q32"] == MUT_ALWAYS else (_hash64_vec(_dom(seed, DOM_MUT), B["pre"], B["post"]) >> np.uint64(32)) < np.uint64(D["mut_rate_q32"])
        if mut.any(): g = g.copy(); g[mut] = sample_with_u(c[mut], _hash64_vec(_dom(seed, DOM_DRAW), B["pre"][mut], B["post"][mut]), D["mean_ratio_q16"], D["r_table"])   # a mutation is a fresh draw around the BASE count: the population stays stationary
        if D["layout"] == 1: g = np.where(g >= D["min_syn"], g, 0)
    cache[did] = g; return g
def recompute_record(D, pre, post, c, a, b):
    """record-local rule of a cross (the scalar twin of the vectorised genotype): c = |base weight|, a / b = the parents' values.
    In-place: a, b are the parents' payload |weights| and the result is thresholded -- committed bytes in, committed bytes out."""
    seed = D["seed"]; ka, kb = (pre, post) if D["granularity"] == 0 else (pre, M32) if D["granularity"] == 1 else (M32, post)
    v = a if (hash64(_dom(seed, DOM_PICK), ka, kb) >> 63) == 0 else b
    if D["mut_rate_q32"] == MUT_ALWAYS or (hash64(_dom(seed, DOM_MUT), pre, post) >> 32) < D["mut_rate_q32"]:
        tab = nb_table(int(c), r_of(int(c), D["r_table"]), D["mean_ratio_q16"]); v = min(32767, min(int(np.searchsorted(tab, np.uint64(hash64(_dom(seed, DOM_DRAW), pre, post)), side="right")), len(tab) - 1))
    return 0 if D.get("layout", 0) == 1 and v < D["min_syn"] else int(v)
def base_name_length(base: bytes) -> int: return struct.unpack_from("<H", base, 28)[0]
def fit_name(name: str, length: int) -> str:
    b = name.encode()[:length]
    while b and (b[-1] & 0xC0) == 0x80: b = b[:-1]
    return b.decode(errors="ignore") + "_" * (length - len(b))
def apply_procedural(base, delta, parents=None):
    B = decode_payload(base); mid = model_id(base); g = genotype(B, mid, delta, parents); D = decode_delta2(delta) if delta[:12] == MAGIC_DELTA2 else decode_delta3(delta)
    if D.get("layout", 0) == 1:   # in place: the base's bytes with this name and these weights; nothing moves
        nl = base_name_length(base); name_b = D["name"].encode()
        if len(name_b) != nl: raise ValueError(f"an in-place name must have the base name's byte length ({nl}), got {len(name_b)}: use fit_name")
        out = bytearray(base); out[30:30 + nl] = name_b; off = 30 + nl + B["n"] * 8
        rec = np.frombuffer(out, dtype=np.uint8, count=len(g) * REC, offset=off).reshape(-1, REC); rec[:, 8:10] = (np.sign(B["w"]) * g).astype("<i2").view(np.uint8).reshape(-1, 2)   # g is already thresholded
        return bytes(out)
    n = B["n"]; keep = g >= D["min_syn"]; pre, post, w = B["pre"][keep], B["post"][keep], np.sign(B["w"])[keep] * g[keep]
    if len(D["w"]):   # explicit ops after sampling: set / insert / lenient delete
        bkey = post * n + pre; dkey = D["post"] * n + D["pre"]; keepb = ~np.isin(bkey, dkey); ins = D["w"] != 0
        pre = np.concatenate([pre[keepb], D["pre"][ins]]); post = np.concatenate([post[keepb], D["post"][ins]]); w = np.concatenate([w[keepb], D["w"][ins]])
    return encode_payload(n, B["ids"], D["name"], pre, post, w)
def apply_delta2(base, delta): return apply_procedural(base, delta)
def apply_any(base, delta, parents=None): return apply_procedural(base, delta, parents) if delta[:12] in (MAGIC_DELTA2, MAGIC_DELTA3) else apply_delta(base, delta)

def manifest(delta: bytes, base: bytes, applied: bytes | None = None) -> dict:
    if delta[:12] == MAGIC_DELTA3:
        D = decode_delta3(delta); m = dict(format="FLYDELTAv3", name=D["name"], bytes=len(delta), parent_a="0x" + D["parent_a"].hex(), parent_b="0x" + D["parent_b"].hex(), seed=D["seed"], granularity=[k for k, v in GRAN.items() if v == D["granularity"]][0], layout=[k for k, v in LAYOUT.items() if v == D["layout"]][0], mut_rate=("always" if D["mut_rate_q32"] == MUT_ALWAYS else D["mut_rate_q32"] / 2 ** 32), min_syn=D["min_syn"], mean_ratio_q16=D["mean_ratio_q16"], r_table=[list(r) for r in D["r_table"]], ops=int(len(D["w"])), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    elif delta[:12] == MAGIC_DELTA2:
        D = decode_delta2(delta); m = dict(format="FLYDELTAv2", name=D["name"], bytes=len(delta), seed=D["seed"], min_syn=D["min_syn"], mean_ratio_q16=D["mean_ratio_q16"], r_table=[list(r) for r in D["r_table"]], ops=int(len(D["w"])), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    else:
        D = decode_delta(delta); m = dict(format="FLYDELTAv1", name=D["name"], bytes=len(delta), ops=int(len(D["w"])), deletes=int((D["w"] == 0).sum()), sets=int((D["w"] != 0).sum()), neurons=D["n"], base_model_id="0x" + D["base_model_id"].hex(), base_da=D["base_da"], delta_id="0x" + keccak256(delta).hex(), sha256=hashlib.sha256(delta).hexdigest())
    if applied is not None: m["result"] = dict(model_id="0x" + model_id(applied).hex(), sha256=hashlib.sha256(applied).hexdigest(), bytes=len(applied), tiles=len(applied) // TILE, synapse_records=int(decode_payload(applied)["w"].size))
    return m
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("diff"); d.add_argument("--base", type=Path, required=True); d.add_argument("--target", type=Path, required=True); d.add_argument("--out", type=Path, required=True); d.add_argument("--name"); d.add_argument("--base-da", default="")
    m = sub.add_parser("make"); m.add_argument("--base", type=Path, required=True); m.add_argument("--ops", type=Path, required=True); m.add_argument("--name", required=True); m.add_argument("--out", type=Path, required=True); m.add_argument("--base-da", default="")
    a = sub.add_parser("apply"); a.add_argument("--base", type=Path, required=True); a.add_argument("--delta", type=Path, required=True); a.add_argument("--out", type=Path, required=True); a.add_argument("--parents", type=Path, nargs="*", default=[], help="ancestor deltas of a v3 cross")
    m3 = sub.add_parser("make3"); m3.add_argument("--base", type=Path, required=True); m3.add_argument("--parent-a", default=None, help="delta file, or 'base'"); m3.add_argument("--parent-b", default=None); m3.add_argument("--founder", action="store_true", help="base x base with every record mutating: a fresh individual"); m3.add_argument("--layout", choices=list(LAYOUT), default="compact"); m3.add_argument("--seed", type=int, required=True); m3.add_argument("--name", required=True); m3.add_argument("--out", type=Path, required=True)
    m3.add_argument("--granularity", choices=list(GRAN), default="record"); m3.add_argument("--mut-rate", type=float, default=0.125); m3.add_argument("--min-syn", type=int, default=5); m3.add_argument("--mean-ratio", type=float, default=1.0); m3.add_argument("--r-table", type=Path); m3.add_argument("--base-da", default=""); m3.add_argument("--parents", type=Path, nargs="*", default=[], help="further ancestors needed to apply"); m3.add_argument("--no-apply", action="store_true")
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
    elif x.cmd == "make3":
        if x.founder: x.parent_a = x.parent_b = "base"; x.mut_rate = 1.0
        if not x.parent_a or not x.parent_b: raise SystemExit("make3 needs --parent-a and --parent-b, or --founder")
        if x.layout == "inplace": x.name = fit_name(x.name, base_name_length(base))
        pid = lambda v: (ZERO_ID, None) if v == "base" else (lambda b: (delta_id(b), b))(Path(v).read_bytes()); (ia, ba), (ib, bb) = pid(x.parent_a), pid(x.parent_b); rows = [tuple(r) for r in json.loads(x.r_table.read_text())] if x.r_table else None
        delta = encode_delta3(model_id(base), decode_payload(base)["n"], x.name, x.base_da, ia, ib, x.seed, GRAN[x.granularity], x.min_syn, min(int(round(x.mut_rate * 2 ** 32)), 2 ** 32 - 1), int(round(x.mean_ratio * 65536)), rows, None, LAYOUT[x.layout])
        x.parents = list(x.parents) + [Path(v) for v in (x.parent_a, x.parent_b) if v != "base"]
        if x.no_apply: x.out.write_bytes(delta); man = manifest(delta, base); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1)); print(json.dumps(man, indent=1)); return
    else: delta = x.delta.read_bytes()
    parents = {delta_id(b): b for b in (Path(f).read_bytes() for f in getattr(x, "parents", []))}
    applied = apply_any(base, delta, parents)
    if x.cmd == "apply": x.out.write_bytes(applied); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    else: x.out.write_bytes(delta); man = manifest(delta, base, applied); Path(str(x.out) + ".manifest.json").write_text(json.dumps(man, indent=1))
    print(json.dumps(man, indent=1))
if __name__ == "__main__": main()
