// Deterministic fly-brain payload synthesizer in JS — same binary layout as
// demo/fly_brain/payload.py (MAGIC, u64 neurons, u64 synapses, u16 name len, name,
// neuron records x8 B, synapse records x10 B, zero-padded to 4 KiB tiles), with
// fmix32-based content so tests need no Python. Not the Python stand-in's bytes.
const MAGIC = new TextEncoder().encode("FLYBRAINv1\0\0");
const fmix32 = (h) => { h >>>= 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h >>> 0; };
export function synthesizePayload(name, neurons, synapses, { sortByPost = true } = {}) {
  const nameB = new TextEncoder().encode(name);
  const raw = 30 + nameB.length + neurons * 8 + synapses * 10;
  const len = Math.ceil(raw / 4096) * 4096;
  const b = new Uint8Array(len); const dv = new DataView(b.buffer);
  b.set(MAGIC, 0); dv.setBigUint64(12, BigInt(neurons), true); dv.setBigUint64(20, BigInt(synapses), true); dv.setUint16(28, nameB.length, true); b.set(nameB, 30);
  let seed = 0; for (const c of nameB) seed = fmix32(seed ^ c);
  let off = 30 + nameB.length;
  for (let i = 0; i < neurons; i++, off += 8) { dv.setUint16(off, fmix32(seed + i * 4 + 1) & 127, true); dv.setUint16(off + 2, fmix32(seed + i * 4 + 2) & 0xffff, true); dv.setUint16(off + 4, fmix32(seed + i * 4 + 3) & 0xffff, true); dv.setUint16(off + 6, fmix32(seed + i * 4 + 4) & 0xffff, true); }
  const recs = []; for (let s = 0; s < synapses; s++) recs.push([fmix32(seed ^ (s * 3 + 1)) % neurons, fmix32(seed ^ (s * 3 + 2)) % neurons, fmix32(seed ^ (s * 3 + 3)) & 0xffff]);
  if (sortByPost) recs.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  for (const [pre, post, w] of recs) { dv.setUint32(off, pre, true); dv.setUint32(off + 4, post, true); dv.setUint16(off + 8, w, true); off += 10; }
  return b;
}

// Payload v2 synthesizer (FLYBRAINv2: u64 root-id neuron records, i16 signed synapse counts,
// records sorted by (post, pre)) — a dense-enough random graph for the integer-LIF tests.
// The real brain comes from demo/fly_brain/flywire_export.py; this is only test scaffolding.
const MAGIC_V2 = new TextEncoder().encode("FLYBRAINv2\0\0");
export function synthesizePayloadV2(name, neurons, synapses, { inhibitoryPct = 35, maxCount = 60 } = {}) {
  const nameB = new TextEncoder().encode(name);
  const raw = 30 + nameB.length + neurons * 8 + synapses * 10;
  const len = Math.ceil(raw / 4096) * 4096;
  const b = new Uint8Array(len); const dv = new DataView(b.buffer);
  b.set(MAGIC_V2, 0); dv.setBigUint64(12, BigInt(neurons), true); dv.setBigUint64(20, BigInt(synapses), true); dv.setUint16(28, nameB.length, true); b.set(nameB, 30);
  let seed = 0; for (const c of nameB) seed = fmix32(seed ^ c);
  let off = 30 + nameB.length;
  for (let i = 0; i < neurons; i++, off += 8) dv.setBigUint64(off, 720575940600000000n + BigInt(fmix32(seed + i * 7 + 3)), true); // FlyWire-style ids
  const inhib = new Uint8Array(neurons); for (let i = 0; i < neurons; i++) inhib[i] = fmix32(seed ^ (i * 5 + 1)) % 100 < inhibitoryPct ? 1 : 0; // Dale: sign per PRE neuron
  const seen = new Set(); const recs = [];
  for (let s = 0; recs.length < synapses; s++) {
    const pre = fmix32(seed ^ (s * 3 + 1)) % neurons, post = fmix32(seed ^ (s * 3 + 2)) % neurons; if (pre === post) continue;
    const key = post * neurons + pre; if (seen.has(key)) continue; seen.add(key);
    const cnt = 5 + (fmix32(seed ^ (s * 3 + 3)) % (maxCount - 4));
    recs.push([pre, post, inhib[pre] ? -cnt : cnt]);
  }
  recs.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  for (const [pre, post, w] of recs) { dv.setUint32(off, pre, true); dv.setUint32(off + 4, post, true); dv.setInt16(off + 8, w, true); off += 10; }
  return b;
}
