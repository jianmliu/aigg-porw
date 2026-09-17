// Independent verifier-side implementation of the keccak PoRW scheme (noble keccak).
// Never uses the wasm kernel: a second implementation the node's outputs are checked against.
import { keccak_256 } from "@noble/hashes/sha3.js";

export const SCHEME_ID = "aigg:porw:sketch-tile-keccak:v1";
export const TILE_BYTES = 4096, TILE_WORDS = 1024;
const GOLDEN32 = 0x9e3779b9, M1 = 0x85ebca6b, M2 = 0xc2b2ae35;

export const keccak = (b) => keccak_256(b);
export const schemeDigest = () => keccak(new TextEncoder().encode(SCHEME_ID));
export const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/../g).map((h) => parseInt(h, 16)));
export const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const le64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };

export const fmix32 = (h) => { h >>>= 0; h ^= h >>> 16; h = Math.imul(h, M1) >>> 0; h ^= h >>> 13; h = Math.imul(h, M2) >>> 0; h ^= h >>> 16; return h >>> 0; };
export function sketchTile(slotSeed, tileIdx, tile) {
  const r = fmix32(fmix32((slotSeed ^ tileIdx) >>> 0));
  const w = new Uint32Array(tile.buffer, tile.byteOffset, TILE_WORDS); // LE host assumed (all browsers/Node)
  let acc = 0, jg = 0;
  for (let j = 0; j < TILE_WORDS; j++) { const c = (fmix32((r + jg) >>> 0) | 1) >>> 0; acc = (acc + Math.imul(c, w[j])) >>> 0; jg = (jg + GOLDEN32) >>> 0; }
  return acc >>> 0;
}
export const weightsLeaf = (tileIdx, tile) => keccak(cat(le64(tileIdx), tile));
export const partialsLeaf = (tileIdx, sTile) => keccak(cat(le64(tileIdx), le32(sTile)));
export const parent = (l, r) => keccak(cat(l, r));
export const slotSeed = (challenge32, device32) => new DataView(keccak(cat(challenge32, device32)).buffer).getUint32(0, true);
export function merkleRoot(leaves) { // array of Uint8Array(32)
  if (leaves.length === 0) return keccak(new Uint8Array(0));
  let lvl = leaves.slice();
  while (lvl.length > 1) { const nx = []; for (let i = 0; i < lvl.length; i += 2) nx.push(parent(lvl[i], i + 1 < lvl.length ? lvl[i + 1] : lvl[i])); lvl = nx; }
  return lvl[0];
}
export function merkleVerifyCounted(root, leaf, index, count, proof) {
  if (count === 0 || index >= count) return false;
  let acc = leaf, w = count, p = 0, i = index;
  while (w > 1) {
    if (p >= proof.length) return false;
    const sib = proof[p];
    if ((i & 1) === 0) { if (i + 1 === w && !eq(sib, acc)) return false; acc = parent(acc, sib); } else acc = parent(sib, acc);
    i >>>= 1; w = (w + 1) >>> 1; p++;
  }
  return p === proof.length && eq(acc, root);
}
export const splitLeaves = (bytes) => { const out = []; for (let i = 0; i < bytes.length; i += 32) out.push(bytes.subarray(i, i + 32)); return out; };
