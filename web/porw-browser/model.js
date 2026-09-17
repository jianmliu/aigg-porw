// Fly-brain payload layout (demo/fly_brain/payload.py) and integer SpMV wrappers.
const MAGIC = "FLYBRAINv1\0\0";
export function decodeHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 12));
  if (magic !== MAGIC) throw new Error("bad payload magic");
  const neurons = Number(dv.getBigUint64(12, true)), synapses = Number(dv.getBigUint64(20, true));
  const nameLen = dv.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen));
  const synOffset = 30 + nameLen + neurons * 8;
  if (synOffset + synapses * 10 > bytes.byteLength) throw new Error("payload truncated");
  return { name, neurons, synapses, synOffset };
}
export function attachSpmv(k, e) {
  k.spmvStimulus = (n, seed) => { const p = k.alloc(n * 4); e.porw_spmv_stimulus(p, n >>> 0, seed >>> 0); return p; };
  // runs `steps` propagation steps in place; returns pointer to the final activation array (u32[n])
  k.spmvRun = (bufPtr, hdr, actPtr, steps) => {
    const m = k.mark();
    const n = hdr.neurons; const tmp = k.alloc(n * 4); const acc = k.alloc(n * 8);
    let cur = actPtr, nxt = tmp;
    for (let s = 0; s < steps; s++) {
      const rc = e.porw_spmv_step(bufPtr + hdr.synOffset, hdr.synapses >>> 0, cur, nxt, acc, n >>> 0);
      if (rc !== 0) { k.release(m); throw new Error("spmv rc=" + rc); }
      [cur, nxt] = [nxt, cur];
    }
    if (cur !== actPtr) k.u32(actPtr, n).set(k.u32(cur, n)); // final result into caller's array
    k.release(m);
    return actPtr;
  };
  return k;
}
