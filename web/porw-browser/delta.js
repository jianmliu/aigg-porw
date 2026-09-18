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
export const MAGIC_DELTA = "FLYDELTAv1\0\0"; const MAGIC_V2 = "FLYBRAINv2\0\0"; const TILE = V.TILE_BYTES; const REC = 10;
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
export function applyDelta(base, deltaBytes, { baseModelId = null } = {}) {
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
