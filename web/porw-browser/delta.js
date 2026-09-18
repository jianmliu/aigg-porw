// Delta payloads (FLYDELTAv1): a fine-tune, an ablation or a synthetic individual of a released FLYBRAINv2
// brain as a small edit list bound to the base's model_id, instead of a second 28 MB payload.
//
//   MAGIC "FLYDELTAv1\0\0" | base model_id (32 B) | u64 neurons | u32 ops | u16 name_len | name
//   | u16 base_da_len | base_da (UTF-8 pointer of the base, may be empty) | ops: 10 B each: u32 pre | u32 post | i16 w
//   ops sorted by (post, pre), unique. w != 0 sets the record (insert or replace); w == 0 deletes it (the base must have it).
//
// apply(base, delta) rebuilds the target payload exactly as flywire_export.py would write it (header with the delta's
// name, the base's root ids, records sorted by (post, pre), zero padding to 4 KiB tiles), so the target's model_id is the
// Merkle root of the applied bytes — the same commitment a directly published payload would carry. Neurons cannot be
// added or removed in v1. Python twin: demo/fly_brain/flywire_delta.py.
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as V from "./verify.js";
import { decodeHeader } from "./model.js";
import { hash64, hash64Words, nbTable, rOf, sampleFromTable, DEFAULT_R_TABLE } from "./sample.js";
export const MAGIC_DELTA = "FLYDELTAv1\0\0", MAGIC_DELTA2 = "FLYDELTAv2\0\0", MAGIC_DELTA3 = "FLYDELTAv3\0\0"; const MAGIC_V2 = "FLYBRAINv2\0\0"; const TILE = V.TILE_BYTES; const REC = 10;
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
/** model_id of a payload: keccak weights Merkle root over its 4 KiB tiles */
export function modelIdOf(bytes) { const n = Math.floor(bytes.length / TILE); const lv = []; for (let t = 0; t < n; t++) lv.push(V.weightsLeaf(t, bytes.subarray(t * TILE, (t + 1) * TILE))); return V.merkleRoot(lv); }
/** keccak of the delta bytes: the delta's own identity */
export const deltaId = (bytes) => keccak_256(bytes);
const readRec = (dv, off) => ({ pre: dv.getUint32(off, true), post: dv.getUint32(off + 4, true), w: dv.getInt16(off + 8, true) });
const writeRec = (dv, off, r) => { dv.setUint32(off, r.pre >>> 0, true); dv.setUint32(off + 4, r.post >>> 0, true); dv.setInt16(off + 8, r.w, true); };
const cmp = (a, b) => (a.post - b.post) || (a.pre - b.pre);
export function decodeDelta(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 60 || new TextDecoder("latin1").decode(bytes.subarray(0, 12)) !== MAGIC_DELTA) throw new Error("bad delta magic");
  const baseModelId = bytes.slice(12, 44); const neurons = Number(dv.getBigUint64(44, true)); const ops = dv.getUint32(52, true); const nameLen = dv.getUint16(56, true);
  let off = 58; const name = dec(bytes.subarray(off, off + nameLen)); off += nameLen; const daLen = dv.getUint16(off, true); off += 2; const baseDA = dec(bytes.subarray(off, off + daLen)); off += daLen;
  if (off + ops * REC !== bytes.length) throw new Error("delta length mismatch");
  const list = new Array(ops); for (let i = 0; i < ops; i++) list[i] = readRec(dv, off + i * REC);
  for (let i = 0; i < ops; i++) { if (list[i].pre >= neurons || list[i].post >= neurons) throw new Error(`op ${i}: neuron index out of range`); if (i && cmp(list[i - 1], list[i]) >= 0) throw new Error(`op ${i}: ops must be sorted by (post, pre) and unique`); }
  return { baseModelId, neurons, name, baseDA, ops: list };
}
export function encodeDelta({ baseModelId, neurons, name, baseDA = "", ops }) {
  if (baseModelId.length !== 32) throw new Error("baseModelId must be 32 bytes");
  const sorted = ops.map((o) => ({ pre: o.pre >>> 0, post: o.post >>> 0, w: o.w | 0 })).sort(cmp);
  for (let i = 0; i < sorted.length; i++) { const o = sorted[i]; if (o.pre >= neurons || o.post >= neurons) throw new Error("op out of range"); if (o.w < -32768 || o.w > 32767) throw new Error("weight out of i16"); if (i && cmp(sorted[i - 1], o) === 0) throw new Error("duplicate op"); }
  const nameB = enc(name), daB = enc(baseDA); if (nameB.length > 65535 || daB.length > 65535) throw new Error("name/pointer too long");
  const out = new Uint8Array(58 + nameB.length + 2 + daB.length + sorted.length * REC); const dv = new DataView(out.buffer);
  out.set(enc(MAGIC_DELTA), 0); out.set(baseModelId, 12); dv.setBigUint64(44, BigInt(neurons), true); dv.setUint32(52, sorted.length, true); dv.setUint16(56, nameB.length, true);
  let off = 58; out.set(nameB, off); off += nameB.length; dv.setUint16(off, daB.length, true); off += 2; out.set(daB, off); off += daB.length;
  for (let i = 0; i < sorted.length; i++) writeRec(dv, off + i * REC, sorted[i]);
  return out;
}
/** records of a v2 payload as {pre, post, w} in file order (sorted by (post, pre) for published payloads) */
export function records(bytes) { const h = decodeHeader(bytes); if (h.version !== 2) throw new Error("FLYBRAINv2 required"); const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out = new Array(h.synapses); for (let i = 0; i < h.synapses; i++) out[i] = readRec(dv, h.synOffset + i * REC); return out; }
/** write a v2 payload from a header's neurons (root ids copied from `base`), a name and records already sorted by (post, pre) */
export function encodePayload(base, name, recs) {
  const h = decodeHeader(base); const nameB = enc(name); const hdrLen = 30 + nameB.length; const bodyLen = hdrLen + h.neurons * 8 + recs.length * REC; const len = bodyLen + ((TILE - (bodyLen % TILE)) % TILE);
  const out = new Uint8Array(len); const dv = new DataView(out.buffer);
  out.set(enc(MAGIC_V2), 0); dv.setBigUint64(12, BigInt(h.neurons), true); dv.setBigUint64(20, BigInt(recs.length), true); dv.setUint16(28, nameB.length, true); out.set(nameB, 30);
  out.set(base.subarray(h.neuronOffset, h.neuronOffset + h.neurons * 8), hdrLen); const off = hdrLen + h.neurons * 8;
  for (let i = 0; i < recs.length; i++) writeRec(dv, off + i * REC, recs[i]);
  return out;
}
/**
 * Apply a delta to its base payload. Checks the base's model_id against the delta header unless `baseModelId` is
 * passed (already verified by the caller); throws on a delete of a record the base does not have.
 */
export function applyDelta(base, deltaBytes, { baseModelId = null, resolve = null, cache = undefined } = {}) {
  if (isDelta2(deltaBytes) || new TextDecoder("latin1").decode(deltaBytes.subarray(0, 12)) === MAGIC_DELTA3) return applyProcedural(base, deltaBytes, { baseModelId, resolve, cache });
  const d = decodeDelta(deltaBytes); const h = decodeHeader(base); if (h.version !== 2) throw new Error("FLYBRAINv2 base required");
  if (h.neurons !== d.neurons) throw new Error(`neuron count mismatch: base ${h.neurons}, delta ${d.neurons}`);
  const mid = baseModelId || modelIdOf(base); if (!V.eq(mid, d.baseModelId)) throw new Error(`base model id mismatch: base ${V.hex(mid)}, delta binds ${V.hex(d.baseModelId)}`);
  const src = records(base); for (let i = 1; i < src.length; i++) if (cmp(src[i - 1], src[i]) >= 0) throw new Error("base records must be sorted by (post, pre) and unique");
  const out = []; let i = 0, j = 0; const ops = d.ops;
  while (i < src.length || j < ops.length) {
    const c = i >= src.length ? 1 : j >= ops.length ? -1 : cmp(src[i], ops[j]);
    if (c < 0) out.push(src[i++]);
    else if (c > 0) { if (ops[j].w === 0) throw new Error(`delete of a record the base lacks: pre ${ops[j].pre} post ${ops[j].post}`); out.push(ops[j++]); }
    else { if (ops[j].w !== 0) out.push(ops[j]); i++; j++; }
  }
  return encodePayload(base, d.name, out);
}
/** the delta that turns `base` into `target` (same neurons and root ids); name and pointer go into the header */
export function diffPayloads(base, target, { name = null, baseDA = "" } = {}) {
  const hb = decodeHeader(base), ht = decodeHeader(target); if (hb.neurons !== ht.neurons) throw new Error("neuron count differs");
  if (!V.eq(base.subarray(hb.neuronOffset, hb.neuronOffset + hb.neurons * 8), target.subarray(ht.neuronOffset, ht.neuronOffset + ht.neurons * 8))) throw new Error("root ids differ");
  const a = records(base).sort(cmp), b = records(target).sort(cmp); const ops = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const c = i >= a.length ? 1 : j >= b.length ? -1 : cmp(a[i], b[j]);
    if (c < 0) { ops.push({ pre: a[i].pre, post: a[i].post, w: 0 }); i++; }
    else if (c > 0) { ops.push(b[j++]); }
    else { if (a[i].w !== b[j].w) ops.push(b[j]); i++; j++; }
  }
  return encodeDelta({ baseModelId: modelIdOf(base), neurons: hb.neurons, name: name ?? ht.name, baseDA, ops });
}

// ------------------------------------------------------------------ FLYDELTAv2: procedural individuals ----------
// MAGIC "FLYDELTAv2\0\0" | base model_id (32 B) | u64 neurons | u64 seed | u16 min_syn | u32 mean_ratio_q16 | u16 r_rows
// | rows: u32 c_from | u16 r_q8 | u32 ops | u16 name_len | name | u16 base_da_len | base_da | ops (10 B each)
// apply: every base record's count c = |w| is resampled (sample.js), records with c' < min_syn dropped, sign kept,
// then the explicit ops (set / insert / lenient delete), then the payload is written as for v1.
export const isDelta2 = (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 12)) === MAGIC_DELTA2;
export function decodeDelta2(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 76 || !isDelta2(bytes)) throw new Error("bad delta2 magic");
  const baseModelId = bytes.slice(12, 44); const neurons = Number(dv.getBigUint64(44, true)); const seed = dv.getBigUint64(52, true); const minSyn = dv.getUint16(60, true); const meanRatioQ16 = dv.getUint32(62, true); const nrows = dv.getUint16(66, true);
  let off = 68; const rTable = []; for (let i = 0; i < nrows; i++) { rTable.push([dv.getUint32(off, true), dv.getUint16(off + 4, true)]); off += 6; }
  for (let i = 1; i < nrows; i++) if (rTable[i - 1][0] >= rTable[i][0]) throw new Error("r table rows must ascend"); if (!nrows || rTable[0][0] !== 1) throw new Error("r table must start at c=1");
  const nops = dv.getUint32(off, true); off += 4; const nameLen = dv.getUint16(off, true); off += 2; const name = dec(bytes.subarray(off, off + nameLen)); off += nameLen; const daLen = dv.getUint16(off, true); off += 2; const baseDA = dec(bytes.subarray(off, off + daLen)); off += daLen;
  if (off + nops * REC !== bytes.length) throw new Error("delta length mismatch");
  const ops = new Array(nops); for (let i = 0; i < nops; i++) ops[i] = readRec(dv, off + i * REC);
  for (let i = 0; i < nops; i++) { if (ops[i].pre >= neurons || ops[i].post >= neurons) throw new Error(`op ${i}: neuron index out of range`); if (i && cmp(ops[i - 1], ops[i]) >= 0) throw new Error(`op ${i}: ops must be sorted by (post, pre) and unique`); }
  return { baseModelId, neurons, seed, minSyn, meanRatioQ16, rTable, name, baseDA, ops };
}
export function encodeDelta2({ baseModelId, neurons, seed, name, baseDA = "", minSyn = 5, meanRatioQ16 = 65536, rTable = DEFAULT_R_TABLE, ops = [] }) {
  if (baseModelId.length !== 32) throw new Error("baseModelId must be 32 bytes"); if (!rTable.length || rTable[0][0] !== 1) throw new Error("r table must start at c=1");
  for (let i = 1; i < rTable.length; i++) if (rTable[i - 1][0] >= rTable[i][0]) throw new Error("r table rows must ascend");
  const sorted = ops.map((o) => ({ pre: o.pre >>> 0, post: o.post >>> 0, w: o.w | 0 })).sort(cmp);
  for (let i = 0; i < sorted.length; i++) { const o = sorted[i]; if (o.pre >= neurons || o.post >= neurons) throw new Error("op out of range"); if (i && cmp(sorted[i - 1], o) === 0) throw new Error("duplicate op"); }
  const nameB = enc(name), daB = enc(baseDA); const out = new Uint8Array(68 + 6 * rTable.length + 4 + 2 + nameB.length + 2 + daB.length + sorted.length * REC); const dv = new DataView(out.buffer);
  out.set(enc(MAGIC_DELTA2), 0); out.set(baseModelId, 12); dv.setBigUint64(44, BigInt(neurons), true); dv.setBigUint64(52, BigInt(seed), true); dv.setUint16(60, minSyn, true); dv.setUint32(62, meanRatioQ16 >>> 0, true); dv.setUint16(66, rTable.length, true);
  let off = 68; for (const [cFrom, rq] of rTable) { dv.setUint32(off, cFrom >>> 0, true); dv.setUint16(off + 4, rq, true); off += 6; }
  dv.setUint32(off, sorted.length, true); off += 4; dv.setUint16(off, nameB.length, true); off += 2; out.set(nameB, off); off += nameB.length; dv.setUint16(off, daB.length, true); off += 2; out.set(daB, off); off += daB.length;
  for (let i = 0; i < sorted.length; i++) writeRec(dv, off + i * REC, sorted[i]);
  return out;
}
/** resampled counts for the base records (Int32Array of |w|) under (seed, meanRatio, rTable): one CDF table per distinct count */
export function sampleCounts(recs, seed, meanRatioQ16, rTable) {
  const seedLo = Number(seed & 0xffffffffn) >>> 0, seedHi = Number(seed >> 32n) >>> 0; const tables = new Map(); const out = new Int32Array(recs.length);
  for (let i = 0; i < recs.length; i++) {
    const c = Math.abs(recs[i].w); let t = tables.get(c); if (!t) { t = nbTable(c, rOf(c, rTable), meanRatioQ16); tables.set(c, t); }
    out[i] = Math.min(32767, sampleFromTable(t, hash64(seedLo, seedHi, recs[i].pre, recs[i].post)));
  }
  return out;
}
export function applyDelta2(base, deltaBytes, opts = {}) { return applyProcedural(base, deltaBytes, opts); }
// ------------------------------------------------------------------ FLYDELTAv3: same-base cross ----------------
// The child of two individuals of the SAME base (their procedural deltas, by keccak id; 32 zero bytes = the published base).
// Inheritance acts on genotypes = the count of every base record before the min_syn threshold: per inheritance unit
// (0 record | 1 pre neuron | 2 post neuron) one hash bit picks parent A or B; then each record mutates with probability
// mut_rate (a fresh v2 draw around the BASE count, so the population is stationary); phenotype = counts >= min_syn, then ops.
// MAGIC "FLYDELTAv3\0\0" | base model_id | u64 neurons | parent A id | parent B id | u64 seed | u8 granularity | u8 0 | u16 min_syn
// | u32 mut_rate_q32 | u32 mean_ratio_q16 | u16 r_rows | rows | u32 ops | u16 name_len | name | u16 da_len | da | ops
export const GRANULARITY = { record: 0, pre: 1, post: 2 }; const DOM_PICK = 0x5049434b, DOM_MUT = 0x4d555421, DOM_DRAW = 0x44524157;
export const isDelta3 = (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 12)) === MAGIC_DELTA3;
export const isProcedural = (bytes) => isDelta2(bytes) || isDelta3(bytes);
const isZero = (id) => id.every((x) => x === 0);
export function decodeDelta3(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (bytes.length < 146 || !isDelta3(bytes)) throw new Error("bad delta3 magic");
  const baseModelId = bytes.slice(12, 44); const neurons = Number(dv.getBigUint64(44, true)); const parentA = bytes.slice(52, 84), parentB = bytes.slice(84, 116); const seed = dv.getBigUint64(116, true);
  const granularity = dv.getUint8(124); if (granularity > 2) throw new Error("bad granularity"); const minSyn = dv.getUint16(126, true); const mutRateQ32 = dv.getUint32(128, true); const meanRatioQ16 = dv.getUint32(132, true); const nrows = dv.getUint16(136, true);
  let off = 138; const rTable = []; for (let i = 0; i < nrows; i++) { rTable.push([dv.getUint32(off, true), dv.getUint16(off + 4, true)]); off += 6; }
  for (let i = 1; i < nrows; i++) if (rTable[i - 1][0] >= rTable[i][0]) throw new Error("r table rows must ascend"); if (!nrows || rTable[0][0] !== 1) throw new Error("r table must start at c=1");
  const nops = dv.getUint32(off, true); off += 4; const nameLen = dv.getUint16(off, true); off += 2; const name = dec(bytes.subarray(off, off + nameLen)); off += nameLen; const daLen = dv.getUint16(off, true); off += 2; const baseDA = dec(bytes.subarray(off, off + daLen)); off += daLen;
  if (off + nops * REC !== bytes.length) throw new Error("delta length mismatch");
  const ops = new Array(nops); for (let i = 0; i < nops; i++) ops[i] = readRec(dv, off + i * REC);
  for (let i = 0; i < nops; i++) { if (ops[i].pre >= neurons || ops[i].post >= neurons) throw new Error(`op ${i}: neuron index out of range`); if (i && cmp(ops[i - 1], ops[i]) >= 0) throw new Error(`op ${i}: ops must be sorted by (post, pre) and unique`); }
  return { baseModelId, neurons, parentA, parentB, seed, granularity, minSyn, mutRateQ32, meanRatioQ16, rTable, name, baseDA, ops };
}
export function encodeDelta3({ baseModelId, neurons, parentA, parentB, seed, name, baseDA = "", granularity = 0, minSyn = 5, mutRateQ32 = 2 ** 29, meanRatioQ16 = 65536, rTable = DEFAULT_R_TABLE, ops = [] }) {
  if (baseModelId.length !== 32 || parentA.length !== 32 || parentB.length !== 32) throw new Error("ids must be 32 bytes"); if (![0, 1, 2].includes(granularity)) throw new Error("bad granularity");
  if (!rTable.length || rTable[0][0] !== 1) throw new Error("r table must start at c=1"); for (let i = 1; i < rTable.length; i++) if (rTable[i - 1][0] >= rTable[i][0]) throw new Error("r table rows must ascend");
  const sorted = ops.map((o) => ({ pre: o.pre >>> 0, post: o.post >>> 0, w: o.w | 0 })).sort(cmp); for (let i = 0; i < sorted.length; i++) { const o = sorted[i]; if (o.pre >= neurons || o.post >= neurons) throw new Error("op out of range"); if (i && cmp(sorted[i - 1], o) === 0) throw new Error("duplicate op"); }
  const nameB = enc(name), daB = enc(baseDA); const out = new Uint8Array(138 + 6 * rTable.length + 4 + 2 + nameB.length + 2 + daB.length + sorted.length * REC); const dv = new DataView(out.buffer);
  out.set(enc(MAGIC_DELTA3), 0); out.set(baseModelId, 12); dv.setBigUint64(44, BigInt(neurons), true); out.set(parentA, 52); out.set(parentB, 84); dv.setBigUint64(116, BigInt(seed), true); dv.setUint8(124, granularity); dv.setUint8(125, 0);
  dv.setUint16(126, minSyn, true); dv.setUint32(128, mutRateQ32 >>> 0, true); dv.setUint32(132, meanRatioQ16 >>> 0, true); dv.setUint16(136, rTable.length, true);
  let off = 138; for (const [cFrom, rq] of rTable) { dv.setUint32(off, cFrom >>> 0, true); dv.setUint16(off + 4, rq, true); off += 6; }
  dv.setUint32(off, sorted.length, true); off += 4; dv.setUint16(off, nameB.length, true); off += 2; out.set(nameB, off); off += nameB.length; dv.setUint16(off, daB.length, true); off += 2; out.set(daB, off); off += daB.length;
  for (let i = 0; i < sorted.length; i++) writeRec(dv, off + i * REC, sorted[i]);
  return out;
}
/** genotype = the count of every base record (before min_syn) of a procedural delta. `resolve(idHex)` returns an ancestor's delta bytes. */
export function genotype(src, baseMid, deltaBytes, { resolve = null, cache = new Map(), asParent = false } = {}) {
  const id = V.hex(deltaId(deltaBytes)); if (cache.has(id)) return cache.get(id);
  const v3 = isDelta3(deltaBytes); if (!v3 && !isDelta2(deltaBytes)) throw new Error("a genotype needs a procedural delta (v2 or v3)"); const d = v3 ? decodeDelta3(deltaBytes) : decodeDelta2(deltaBytes);
  if (!V.eq(baseMid, d.baseModelId)) throw new Error(`base model id mismatch: base ${V.hex(baseMid)}, delta binds ${V.hex(d.baseModelId)}`); if (asParent && d.ops.length) throw new Error("a parent must carry no explicit ops");
  let g;
  if (!v3) g = sampleCounts(src, d.seed, d.meanRatioQ16, d.rTable);
  else {
    const par = (pid) => { if (isZero(pid)) { const c = new Int32Array(src.length); for (let i = 0; i < src.length; i++) c[i] = Math.abs(src[i].w); return c; } const b = resolve && resolve(V.hex(pid)); if (!b) throw new Error(`parent delta ${V.hex(pid)} not provided`); return genotype(src, baseMid, b, { resolve, cache, asParent: true }); };
    const gA = par(d.parentA), gB = par(d.parentB); const lo = Number(d.seed & 0xffffffffn) >>> 0, hi = Number(d.seed >> 32n) >>> 0; const dom = (x) => [(lo ^ x) >>> 0, (hi ^ x) >>> 0]; const [pl, ph] = dom(DOM_PICK), [ml, mh] = dom(DOM_MUT), [dl, dh] = dom(DOM_DRAW); const FF = 0xffffffff; g = new Int32Array(src.length); const tables = new Map();
    for (let i = 0; i < src.length; i++) {
      const r = src[i]; const [ka, kb] = d.granularity === 0 ? [r.pre, r.post] : d.granularity === 1 ? [r.pre, FF] : [FF, r.post];
      let c = (hash64Words(pl, ph, ka, kb)[0] >>> 31) === 0 ? gA[i] : gB[i];
      if (hash64Words(ml, mh, r.pre, r.post)[0] < d.mutRateQ32) { const m = Math.abs(r.w); let t = tables.get(m); if (!t) { t = nbTable(m, rOf(m, d.rTable), d.meanRatioQ16); tables.set(m, t); } c = Math.min(32767, sampleFromTable(t, hash64(dl, dh, r.pre, r.post))); } // a mutation is a fresh draw around the BASE count: the population stays stationary
      g[i] = c;
    }
  }
  cache.set(id, g); return g;
}
/** v2 / v3: genotype -> phenotype (counts >= min_syn, base signs) -> explicit ops -> payload */
export function applyProcedural(base, deltaBytes, { baseModelId = null, resolve = null, cache = new Map() } = {}) {
  const h = decodeHeader(base); if (h.version !== 2) throw new Error("FLYBRAINv2 base required"); const d = isDelta3(deltaBytes) ? decodeDelta3(deltaBytes) : decodeDelta2(deltaBytes);
  if (h.neurons !== d.neurons) throw new Error(`neuron count mismatch: base ${h.neurons}, delta ${d.neurons}`);
  const mid = baseModelId || modelIdOf(base); const src = records(base); const g = genotype(src, mid, deltaBytes, { resolve, cache });
  let out = []; for (let i = 0; i < src.length; i++) if (g[i] >= d.minSyn) out.push({ pre: src[i].pre, post: src[i].post, w: src[i].w < 0 ? -g[i] : g[i] });
  if (d.ops.length) { const opKey = new Map(d.ops.map((o) => [o.post * h.neurons + o.pre, o])); out = out.filter((r) => !opKey.has(r.post * h.neurons + r.pre)); for (const o of d.ops) if (o.w !== 0) out.push(o); }
  out.sort(cmp); return encodePayload(base, d.name, out);
}
