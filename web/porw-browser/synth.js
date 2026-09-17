// Deterministic fly-brain payload synthesizer in JS — same binary layout as
// demo/fly_brain/payload.py (MAGIC, u64 neurons, u64 synapses, u16 name len, name,
// neuron records x8 B, synapse records x10 B, zero-padded to 4 KiB tiles), with
// fmix32-based content so tests need no Python. Not the Python stand-in's bytes.
const MAGIC = new TextEncoder().encode("FLYBRAINv1\0\0");
const fmix32 = (h) => { h >>>= 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h >>> 0; };
export function synthesizePayload(name, neurons, synapses) {
  const nameB = new TextEncoder().encode(name);
  const raw = 30 + nameB.length + neurons * 8 + synapses * 10;
  const len = Math.ceil(raw / 4096) * 4096;
  const b = new Uint8Array(len); const dv = new DataView(b.buffer);
  b.set(MAGIC, 0); dv.setBigUint64(12, BigInt(neurons), true); dv.setBigUint64(20, BigInt(synapses), true); dv.setUint16(28, nameB.length, true); b.set(nameB, 30);
  let seed = 0; for (const c of nameB) seed = fmix32(seed ^ c);
  let off = 30 + nameB.length;
  for (let i = 0; i < neurons; i++, off += 8) { dv.setUint16(off, fmix32(seed + i * 4 + 1) & 127, true); dv.setUint16(off + 2, fmix32(seed + i * 4 + 2) & 0xffff, true); dv.setUint16(off + 4, fmix32(seed + i * 4 + 3) & 0xffff, true); dv.setUint16(off + 6, fmix32(seed + i * 4 + 4) & 0xffff, true); }
  for (let s = 0; s < synapses; s++, off += 10) { dv.setUint32(off, fmix32(seed ^ (s * 3 + 1)) % neurons, true); dv.setUint32(off + 4, fmix32(seed ^ (s * 3 + 2)) % neurons, true); dv.setUint16(off + 8, fmix32(seed ^ (s * 3 + 3)) & 0xffff, true); }
  return b;
}
