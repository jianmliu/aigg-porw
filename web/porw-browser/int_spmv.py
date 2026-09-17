"""Independent integer reference for the browser node's SpMV (numpy int64).

Same fixed-point semantics as spmv_wasm.c; used to prove cross-implementation
determinism: the browser (wasm) and this reference must produce identical
activation vectors, hence identical keccak digests.
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "gpu" / "triton"))
from porw_sketch.spec import fmix32, GOLDEN32, M32
from demo.fly_brain.payload import synthesize, decode_synapses

ONE = 65536

def stimulus(n, seed):
    i = np.arange(n, dtype=np.uint64)
    return np.where(fmix32((i * GOLDEN32 + seed) & M32) % 100 == 0, ONE, 0).astype(np.int64)

def step(pre, post, w_u16, act):
    acc = np.zeros(act.size, dtype=np.int64)
    np.add.at(acc, post.astype(np.int64), w_u16.astype(np.int64) * act[pre.astype(np.int64)])
    return np.minimum(acc >> 16, ONE).astype(np.int64)

def run(payload, seed, steps):
    c = decode_synapses(payload)
    w_u16 = (c.weight * 65535.0).round().astype(np.uint16)  # decode_synapses scaled by /65535; recover raw u16
    act = stimulus(c.neurons, seed)
    for _ in range(steps):
        act = step(c.pre, c.post, w_u16, act)
    return act.astype("<u4")

if __name__ == "__main__":
    name, neurons, synapses, seed, steps, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    p = synthesize(name, neurons=neurons, synapses=synapses)
    Path(out + ".bin").write_bytes(p.buf.tobytes())
    act = run(p, seed, steps)
    from blake3 import blake3  # digest transport only; keccak of the same bytes is computed on the JS side too
    json.dump({"neurons": neurons, "synapses": synapses, "seed": seed, "steps": steps,
               "act_blake3": "0x" + blake3(act.tobytes()).hexdigest(), "act_sum": int(act.sum()), "act_nonzero": int((act > 0).sum()),
               "act_head": act[:8].tolist()}, open(out + ".json", "w"))
    print("payload", p.bytes_total, "bytes; act nonzero", int((act > 0).sum()), "sum", int(act.sum()))
