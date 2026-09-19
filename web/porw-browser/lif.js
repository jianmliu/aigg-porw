// `aigg:exec:int-lif:v1` — the deterministic integer LIF rule, verifier side (pure JS/BigInt, no wasm).
// Mirrors lif_wasm.c exactly; used by the dispute adjudication and the on-chain LifRowCheck.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fmix32 } from "./verify.js";

export const LIF_KIND_ID = "aigg:exec:int-lif:v1";
export const LIF = Object.freeze({ dtTauMQ16: 328, dtTauSQ16: 1311, threshQ16: 458752, wUnitQ16: 18022, refract: 22, extPQ32: 64424509 });
const GOLDEN32 = 0x9e3779b9;
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const le16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** execKind digest = keccak(abi.encodePacked(string id, uint32 x6 params)) — the parameter set is pinned in the MEP */
/** The kind digest pins every parameter, the weight unit among them. `wUnitQ16` is per connectome: 18022 (0.275 mV per
 *  synapse) was set on FlyWire's synapse counts; a connectome that counts on another scale pins another unit and is
 *  another kind -- same rule, same KIND_ID string, another digest. */
export const lifExecKind = (wUnitQ16 = LIF.wUnitQ16) => keccak_256(cat(new TextEncoder().encode(LIF_KIND_ID), be32(LIF.dtTauMQ16), be32(LIF.dtTauSQ16), be32(LIF.threshQ16), be32(wUnitQ16), be32(LIF.refract), be32(LIF.extPQ32)));

export const ext = (i, step, seed) => fmix32((fmix32((Math.imul(i, GOLDEN32) + seed) >>> 0) + Math.imul(step, GOLDEN32)) >>> 0) < LIF.extPQ32 ? 1 : 0;
export const canonicalStim = (i, seed) => (fmix32((Math.imul(i, GOLDEN32) + seed) >>> 0) % 1000 === 0 ? 1 : 0);

/** state = { v, g, refr, flags, count } (v, g signed 32-bit numbers) */
export const stateLeaf = (i, s) => keccak_256(cat(le32(i), le32(s.v | 0), le32(s.g | 0), le16(s.refr), le16(s.flags), le32(s.count)));
export const decodeState = (bytes, off = 0) => { const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 16); return { v: dv.getInt32(0, true), g: dv.getInt32(4, true), refr: dv.getUint16(8, true), flags: dv.getUint16(10, true), count: dv.getUint32(12, true) }; };
export const encodeState = (s) => { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setInt32(0, s.v, true); dv.setInt32(4, s.g, true); dv.setUint16(8, s.refr, true); dv.setUint16(10, s.flags, true); dv.setUint32(12, s.count, true); return b; };
export const spiked = (s) => (s.flags & 2) ? 1 : 0;
const I32_MAX = 2147483647n, I32_MIN = -2147483648n;

/** transition(S, I) with I a BigInt (signed synapse-count units). Returns the next state. */
export function transition(S, I, i, step, seed, wUnitQ16 = LIF.wUnitQ16) {
  let g = BigInt(S.g); g = g - ((g * BigInt(LIF.dtTauSQ16)) >> 16n) + I * BigInt(wUnitQ16);
  if (g > I32_MAX) g = I32_MAX; if (g < I32_MIN) g = I32_MIN;
  let v, refr, spike;
  if (S.flags & 4) { spike = 0; v = 0n; refr = 0; } // silenced (bit2): never spikes, and silence wins over the stimulus
  else if (S.flags & 1) { spike = ext(i, step, seed); v = 0n; refr = 0; }
  else if (S.refr > 0) { spike = 0; v = 0n; refr = S.refr - 1; }
  else { v = BigInt(S.v) + (((g - BigInt(S.v)) * BigInt(LIF.dtTauMQ16)) >> 16n); if (v >= BigInt(LIF.threshQ16)) { spike = 1; v = 0n; refr = LIF.refract; } else { spike = 0; refr = 0; } }
  return { v: Number(v), g: Number(g), refr, flags: (S.flags & 5) | (spike << 1), count: (S.count + spike) >>> 0 };
}
export const sameState = (a, b) => a.v === b.v && a.g === b.g && a.refr === b.refr && a.flags === b.flags && a.count === b.count;
/** signed 10-byte record */
export const recordSigned = (bytes) => { const dv = new DataView(bytes.buffer, bytes.byteOffset, 10); return { pre: dv.getUint32(0, true), post: dv.getUint32(4, true), w: dv.getInt16(8, true) }; };
/** execDigest of a LIF run = keccak(LE32 n || counts LE32[n]) */
export const countsDigest = (countsU32) => keccak_256(cat(le32(countsU32.length), new Uint8Array(countsU32.buffer, countsU32.byteOffset, countsU32.byteLength)));
