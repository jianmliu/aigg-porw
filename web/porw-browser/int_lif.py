"""Independent integer reference for `aigg:exec:int-lif:v1` (numpy int64).

Same fixed-point semantics as lif_wasm.c / lif.js / LifRowCheck.sol. Used to prove
cross-implementation determinism on payload-v2 brains (real FlyWire export or the
synthetic stand-in): the browser (wasm) and this reference must produce identical
state trajectories, hence identical keccak commitments.
"""
import json, struct, sys
from pathlib import Path
import numpy as np

GOLDEN32 = 0x9E3779B9
M32 = 0xFFFFFFFF
DT_TAU_M_Q16, DT_TAU_S_Q16, THRESH_Q16, W_UNIT_Q16, REFRACT, EXT_P_Q32 = 328, 1311, 458752, 18022, 22, 64424509
I32_MAX, I32_MIN = 2**31 - 1, -(2**31)
MAGIC_V2 = b"FLYBRAINv2\x00\x00"

def fmix32(h):
    h = h & M32
    h ^= h >> 16; h = (h * 0x85EBCA6B) & M32; h ^= h >> 13; h = (h * 0xC2B2AE35) & M32; h ^= h >> 16
    return h

def decode_v2(buf: bytes):
    if buf[:12] != MAGIC_V2: raise ValueError("not a FLYBRAINv2 payload")
    n, ns, nl = struct.unpack_from("<QQH", buf, 12)
    off = 30 + nl
    root_ids = np.frombuffer(buf, dtype="<u8", count=n, offset=off)
    off += n * 8
    rec = np.frombuffer(buf, dtype=np.uint8, count=ns * 10, offset=off).reshape(ns, 10)
    pre = rec[:, 0:4].copy().view("<u4").reshape(-1).astype(np.int64)
    post = rec[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64)
    w = rec[:, 8:10].copy().view("<i2").reshape(-1).astype(np.int64)
    return n, root_ids, pre, post, w

def canonical_stim(n, seed):
    i = np.arange(n, dtype=np.uint64)
    return (fmix32((i * GOLDEN32 + seed) & M32) % 1000 == 0)

def ext(n, step, seed):
    i = np.arange(n, dtype=np.uint64)
    return fmix32((fmix32((i * GOLDEN32 + seed) & M32) + step * GOLDEN32) & M32) < EXT_P_Q32

class State:
    def __init__(self, n, stim_mask, silent_mask=None):
        self.v = np.zeros(n, np.int64); self.g = np.zeros(n, np.int64); self.refr = np.zeros(n, np.int64)
        self.stim = stim_mask.astype(bool); self.spiked = np.zeros(n, bool); self.count = np.zeros(n, np.int64)
        self.silent = np.zeros(n, bool) if silent_mask is None else silent_mask.astype(bool)   # flags bit2: never spikes; wins over stim
    def flags(self): return self.stim.astype(np.int64) | (self.spiked.astype(np.int64) << 1) | (self.silent.astype(np.int64) << 2)
    def leaf_bytes(self):  # 20-byte leaf preimages (without keccak), for cross-checking commitments
        n = self.v.size
        out = np.zeros((n, 5), dtype="<u4")
        out[:, 0] = np.arange(n); out[:, 1] = self.v.astype("<i4").view("<u4"); out[:, 2] = self.g.astype("<i4").view("<u4")
        out[:, 3] = (self.refr | (self.flags() << 16)).astype("<u4"); out[:, 4] = self.count
        return out.tobytes()

def step(S: State, pre, post, w, step_idx, seed, w_unit=W_UNIT_Q16):
    n = S.v.size
    # exact integer accumulation via bincount: every product |w| <= 32767 and every row has at most
    # max_in_degree terms, so each partial sum is far below 2^53 and float64 addition is exact
    # (order-independent). ~30x faster than np.add.at; identical state trajectory (501/501 leaf hashes
    # on the seed-7 / 500-step conformance vector).
    assert np.abs(w).max() * np.bincount(post, minlength=n).max() < 2 ** 53
    I = np.bincount(post, weights=(w * S.spiked[pre].astype(np.int64)).astype(np.float64), minlength=n).astype(np.int64)
    g = S.g - ((S.g * DT_TAU_S_Q16) >> 16) + I * w_unit   # the weight unit is a parameter of the kind (per connectome), see lif.js
    g = np.clip(g, I32_MIN, I32_MAX)
    R = State(n, S.stim, S.silent); R.g = g; R.count = S.count.copy()
    e = ext(n, step_idx, seed)
    # silenced (flags bit2): never spikes, v and refr pinned to 0 (arrays start at zero); silence wins over the stimulus
    sl = S.silent
    # stimulated
    st = S.stim & ~sl
    R.spiked[st] = e[st]; R.v[st] = 0; R.refr[st] = 0
    # refractory
    rf = (~st) & (~sl) & (S.refr > 0)
    R.v[rf] = 0; R.refr[rf] = S.refr[rf] - 1
    # free
    fr = (~st) & (~sl) & (S.refr == 0)
    v = S.v[fr] + (((g[fr] - S.v[fr]) * DT_TAU_M_Q16) >> 16)
    sp = v >= THRESH_Q16
    v[sp] = 0
    R.v[fr] = v; R.spiked[fr] = sp; R.refr[fr] = np.where(sp, REFRACT, 0)
    R.count = S.count + R.spiked.astype(np.int64)
    return R

def run(buf, seed, steps, stim_ids=None, silence_ids=None, w_unit=W_UNIT_Q16):
    n, _, pre, post, w = decode_v2(buf)
    mask = canonical_stim(n, seed) if stim_ids is None else np.isin(np.arange(n), stim_ids)
    S = State(n, mask, None if silence_ids is None else np.isin(np.arange(n), silence_ids)); traj = [S]
    for s in range(1, steps + 1):
        S = step(S, pre, post, w, s, seed, w_unit); traj.append(S)
    return traj

if __name__ == "__main__":
    path, seed, steps, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    buf = Path(path).read_bytes()
    traj = run(buf, seed, steps)
    from hashlib import sha256
    json.dump({"seed": seed, "steps": steps, "neurons": int(traj[0].v.size), "stimulated": int(traj[0].stim.sum()),
               "state_sha256": ["0x" + sha256(S.leaf_bytes()).hexdigest() for S in traj],
               "counts_sha256": "0x" + sha256(traj[-1].count.astype("<u4").tobytes()).hexdigest(),
               "total_spikes": int(traj[-1].count.sum()), "active_neurons": int((traj[-1].count > 0).sum())}, open(out, "w"))
    print("neurons", traj[0].v.size, "stimulated", int(traj[0].stim.sum()), "total spikes", int(traj[-1].count.sum()), "active", int((traj[-1].count > 0).sum()))
