// Independent verifier-side implementation of the keccak PoRW scheme (noble keccak).
// Never uses the wasm kernel: a second implementation the node's outputs are checked against.
import { keccak_256 } from "@noble/hashes/sha3.js";

export const SCHEME_ID = "aigg:porw:sketch-tile-keccak:v2";
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
/** the 32-byte word of an instance address (20 bytes or 0x-hex), as abi.encode pads it */
export const instanceWord = (a) => { const b = typeof a === "string" ? unhex(a) : a; if (b.length !== 20) throw new Error("instance must be a 20-byte address"); const w = new Uint8Array(32); w.set(b, 12); return w; };
/** the sketch seed of a claim: keccak(challenge || instance word), first four bytes LE. The instance is the one the claim
 *  RESOLVES to (the bonded wallet behind a session key), not a field the claimant fills in: N identities cost N scans. */
export const slotSeedWord = (challenge32, word32) => new DataView(keccak(cat(challenge32, word32)).buffer).getUint32(0, true); // the raw two-word hash (conformance fixtures)
export const slotSeed = (challenge32, instance) => slotSeedWord(challenge32, instanceWord(instance));
export function merkleRoot(leaves) { // array of Uint8Array(32)
  if (leaves.length === 0) return keccak(new Uint8Array(0));
  let lvl = leaves.slice();
  while (lvl.length > 1) { const nx = []; for (let i = 0; i < lvl.length; i += 2) nx.push(parent(lvl[i], i + 1 < lvl.length ? lvl[i + 1] : lvl[i])); lvl = nx; }
  return lvl[0];
}
/** inclusion proof for leaf `index` (duplicate-last tree, same rule as merkleVerifyCounted) */
export function merkleProof(leaves, index) {
  const proof = []; let lvl = leaves.slice(), i = index;
  while (lvl.length > 1) { const sib = (i ^ 1) < lvl.length ? lvl[i ^ 1] : lvl[i]; proof.push(sib); const nx = []; for (let j = 0; j < lvl.length; j += 2) nx.push(parent(lvl[j], j + 1 < lvl.length ? lvl[j + 1] : lvl[j])); lvl = nx; i >>= 1; }
  return proof;
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

// ---- execution-dispute commitments (independent definitions) ----
export const CLAMP_Q16 = 65536, CSR_CHUNK = 64;
export const actLeaf = (i, act) => keccak(cat(le32(i), le32(act)));
export const rowStartLeaf = (i, v) => keccak(cat(le32(i), le32(v)));
export const csrChunkLeaf = (c, recordsBytes) => keccak(cat(le32(c), recordsBytes));
export const synapseRootOf = (csrRoot, rowRoot) => keccak(cat(csrRoot, rowRoot));
export const stimulusAct = (i, seed) => (fmix32((Math.imul(i, GOLDEN32) + seed) >>> 0) % 100 === 0 ? CLAMP_Q16 : 0);
export const rowActivation = (lastSum) => { const v = lastSum >> 16n; return Number(v > BigInt(CLAMP_Q16) ? BigInt(CLAMP_Q16) : v); };
export const record = (bytes) => { const dv = new DataView(bytes.buffer, bytes.byteOffset, 10); return { pre: dv.getUint32(0, true), post: dv.getUint32(4, true), w: dv.getUint16(8, true) }; };

/** CSR commitments over a payload's synapse records, in pure JS -- the same tree the node builds in wasm.
 *  An auditor needs this to derive a mep_id from public bytes alone: scheme sketch-tile-keccak:v2 binds the
 *  CSR structure into the id, so nobody can register a brain under a synapseRoot that does not match it.
 *  Records are 10 bytes (u32 pre, u32 post, u16 w), ordered by post neuron (stable); csrRoot is over
 *  `CSR_CHUNK`-record chunks in that order, rowRoot over rowStart[0..neurons]. */
export function csrCommitments(synBytes, synapses, neurons) {
  const dv = new DataView(synBytes.buffer, synBytes.byteOffset, synapses * 10);
  const post = new Uint32Array(synapses);
  for (let i = 0; i < synapses; i++) post[i] = dv.getUint32(i * 10 + 4, true);
  const order = Array.from({ length: synapses }, (_, i) => i).sort((a, b) => post[a] - post[b] || a - b);
  const rowStart = new Uint32Array(neurons + 1);
  for (let i = 0; i < synapses; i++) rowStart[post[i] + 1]++;
  for (let i = 0; i < neurons; i++) rowStart[i + 1] += rowStart[i];
  const nChunks = Math.ceil(synapses / CSR_CHUNK), csrLeaves = [];
  for (let c = 0; c < nChunks; c++) {
    const lo = c * CSR_CHUNK, hi = Math.min(lo + CSR_CHUNK, synapses), buf = new Uint8Array((hi - lo) * 10);
    for (let k = lo; k < hi; k++) buf.set(synBytes.subarray(order[k] * 10, order[k] * 10 + 10), (k - lo) * 10);
    csrLeaves.push(csrChunkLeaf(c, buf));
  }
  const rowLeaves = []; for (let i = 0; i <= neurons; i++) rowLeaves.push(rowStartLeaf(i, rowStart[i]));
  const csrRoot = merkleRoot(csrLeaves), rowRoot = merkleRoot(rowLeaves);
  return { csrRoot, rowRoot, synapseRoot: synapseRootOf(csrRoot, rowRoot), rowStart, order };
}

/** the full MEP-defining profile of a payload, derived from its bytes alone (no wasm kernel) */
export function profileOf(payloadBytes, hdr) {
  const n = Math.floor(payloadBytes.length / TILE_BYTES), lv = [];
  for (let t = 0; t < n; t++) lv.push(weightsLeaf(t, payloadBytes.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES)));
  const c = csrCommitments(payloadBytes.subarray(hdr.synOffset, hdr.synOffset + hdr.synapses * 10), hdr.synapses, hdr.neurons);
  return { modelId: merkleRoot(lv), tiles: n, neurons: hdr.neurons, synapses: hdr.synapses, ...c };
}
