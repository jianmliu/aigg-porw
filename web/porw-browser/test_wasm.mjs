import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import * as V from "./verify.js";

const fx = JSON.parse(fs.readFileSync(process.env.KECCAK_FIXTURE || new URL("../../spec-cache/conformance/porw/sketch-tile-keccak-v1.json", import.meta.url), "utf8"));
const k = await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url)));
let fails = 0; const check = (name, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + name); if (!ok) fails++; };

// keccak256 vs noble on assorted inputs (incl. multi-block)
for (const n of [0, 1, 135, 136, 137, 4104, 10000]) { const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff); check(`keccak256(${n} B) == noble`, V.eq(k.keccak256(b), V.keccak(b))); }
// The commitment primitives below are the v1 conformance vectors and they still hold byte for byte: v2 changed
// what the MESH signs (the residency claim's fields, and where steps/stride live), not how bytes are committed.
// The scheme digest is a domain separator for the claim, so it moves; the spec repo should publish the same
// primitive vector set under the v2 id.
check("scheme id is sketch-tile-keccak:v2", V.SCHEME_ID === "aigg:porw:sketch-tile-keccak:v2" && V.eq(V.schemeDigest(), V.keccak(new TextEncoder().encode(V.SCHEME_ID))));
check("v1 primitive vectors still apply (only the claim encoding changed)", fx.scheme.id === "aigg:porw:sketch-tile-keccak:v1");

// fixture reference buffer: byte i = ((i*2654435761 mod 2^64) >> 7) & 0xff
const nT = fx.reference_buffer.n_tiles, buf = new Uint8Array(nT * TILE_BYTES);
for (let i = 0n; i < BigInt(buf.length); i++) buf[Number(i)] = Number((((i * 2654435761n) & 0xffffffffffffffffn) >> 7n) & 0xffn);
const sd = fx.slot_seed_derivation;
check("slot_seed (wasm) == fixture", k.slotSeed(V.unhex(sd.global_challenge), V.unhex(sd.device_id)) === sd.slot_seed);
check("slot_seed (noble) == fixture", V.slotSeed(V.unhex(sd.global_challenge), V.unhex(sd.device_id)) === sd.slot_seed);

// sketches: wasm kernel vs fixture vs noble scalar
const bp = k.put(buf); const outP = k.alloc(nT * 4);
for (const c of fx.sketches) {
  k.sketch(bp, nT, 0, c.slot_seed, outP); const got = Array.from(k.u32(outP, nT));
  check(`sketches seed=${c.slot_seed} (wasm) == fixture`, JSON.stringify(got) === JSON.stringify(c.per_tile));
  const ref = Array.from({ length: nT }, (_, t) => V.sketchTile(c.slot_seed, t, buf.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES)));
  check(`sketches seed=${c.slot_seed} (noble scalar) == fixture`, JSON.stringify(ref) === JSON.stringify(c.per_tile));
}

// weights leaves + root
const wl = k.weightsLeaves(bp, nT, 0); const wlv = V.splitLeaves(wl);
check("weights leaves (wasm) == noble", wlv.every((l, t) => V.eq(l, V.weightsLeaf(t, buf.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES)))));
if (fx.weights_tree.leaves) check("weights leaves == fixture", wlv.every((l, t) => V.hex(l) === fx.weights_tree.leaves[t]));
check("weights root (wasm) == fixture", V.hex(k.merkleRoot(wl)) === fx.weights_tree.root);
check("weights root (noble) == fixture", V.hex(V.merkleRoot(wlv)) === fx.weights_tree.root);

// tampered scenario: partials over coverage [1,3] with committed values
const ts = fx.tampered_commitment_scenario;
const cov = Uint32Array.from(ts.coverage), committed = Uint32Array.from(ts.committed_s_tiles);
const pl = k.partialsLeaves(committed, 0, cov); const plv = V.splitLeaves(pl);
check("partials leaves == fixture", plv.every((l, i) => V.hex(l) === ts.partials_leaves[i]));
check("partials root (wasm) == fixture", V.hex(k.merkleRoot(pl)) === ts.partials_root);

// merkle proofs from wasm verified by the independent verifier (+ against fixture proof if present)
const op = ts.opening_committed_tile_3; console.log("  opening fields:", Object.keys(op).join(","));
const pos = ts.coverage.indexOf(3);
const proof = k.merkleProof(pl, pos);
check("partials proof (wasm) verifies (noble, counted)", V.merkleVerifyCounted(V.unhex(ts.partials_root), plv[pos], pos, cov.length, proof));
if (op.proof) check("partials proof == fixture proof", proof.length === op.proof.length && proof.every((p, i) => V.hex(p) === op.proof[i]));
for (let t = 0; t < nT; t++) check(`weights proof tile ${t} verifies`, V.merkleVerifyCounted(V.unhex(fx.weights_tree.root), wlv[t], t, nT, k.merkleProof(wl, t)));
// tamper: wrong leaf must fail
check("tampered leaf rejected", !V.merkleVerifyCounted(V.unhex(fx.weights_tree.root), wlv[1], 0, nT, k.merkleProof(wl, 0)));

// larger tree: odd count, duplicate-last, every index
const N = 133; const leaves = new Uint8Array(N * 32).map((_, i) => (i * 7 + 3) & 0xff); const lv = V.splitLeaves(leaves);
const root = k.merkleRoot(leaves); check("odd-count root (wasm) == noble", V.eq(root, V.merkleRoot(lv)));
let allOk = true; for (let i = 0; i < N; i++) allOk &&= V.merkleVerifyCounted(root, lv[i], i, N, k.merkleProof(leaves, i));
check(`all ${N} proofs verify (duplicate-last)`, allOk);

// cached tree == streaming root/proofs
{ const { attachTrees } = await import("./porw.js"); attachTrees(k);
  const N = 133; const leaves = new Uint8Array(N * 32).map((_, i) => (i * 7 + 3) & 0xff);
  const lp = k.put(leaves); const tree = k.treeBuildInto(lp, N, k.alloc(k.treeNodes(N) * 32));
  check("cached tree root == merkleRoot", V.eq(tree.root, k.merkleRoot(leaves)));
  let same = true; for (let i = 0; i < N; i++) { const a = k.treeProof(tree, i), b = k.merkleProof(leaves, i); same &&= a.length === b.length && a.every((x, j) => V.eq(x, b[j])); }
  check("cached tree proofs == streaming proofs (all indices)", same); }
// ---- dispute commitments: act/rowstart leaves == noble; CSR build; partial sums; CSR step == scatter step ----
{ const { synthesizePayload } = await import("./synth.js"); const { decodeHeader } = await import("./model.js");
  const e = k.exports; const p = synthesizePayload("csr-test", 3000, 30000); const hdr = decodeHeader(p);
  const bp = k.put(p); const n = hdr.neurons, ns = hdr.synapses; const syn = bp + hdr.synOffset;
  const rs = k.alloc((n + 1) * 4), perm = k.alloc(ns * 4), cur = k.alloc(n * 4);
  check("csr build rc=0", e.porw_csr_build(syn, ns, n, rs, perm, cur) === 0);
  const R = k.u32(rs, n + 1), P = k.u32(perm, ns), S = p.subarray(hdr.synOffset);
  const post = (kk) => new DataView(S.buffer, S.byteOffset + P[kk] * 10, 10).getUint32(4, true);
  let sorted = true, covered = new Set(); for (let kk = 0; kk < ns; kk++) { if (kk && post(kk) < post(kk - 1)) sorted = false; covered.add(P[kk]); }
  check("perm sorts synapses by post and is a permutation", sorted && covered.size === ns && R[0] === 0 && R[n] === ns);
  let rowsOk = true; for (let i = 0; i < n; i++) for (let kk = R[i]; kk < R[i + 1]; kk++) if (post(kk) !== i) rowsOk = false;
  check("rowStart ranges hold exactly neuron i's incoming synapses", rowsOk);
  // scatter step vs CSR-ordered step: bit-identical activations
  const a0 = k.alloc(n * 4); e.porw_spmv_stimulus(a0, n, 1); const a1 = k.alloc(n * 4), a2 = k.alloc(n * 4), acc = k.alloc(n * 8);
  check("scatter step rc=0", e.porw_spmv_step(syn, ns, a0, a1, acc, n) === 0);
  check("csr step rc=0", e.porw_spmv_step_csr(syn, perm, rs, a0, a2, n) === 0);
  check("CSR-ordered step == scatter step (bit-identical)", V.eq(k.u8(a1, n * 4), k.u8(a2, n * 4)));
  // partial sums: last running sum over a neuron's range == its accumulator; act_out = min(acc>>16, 65536)
  const i = 42, k0 = R[i], k1 = R[i + 1]; const ps = k.alloc(Math.max(1, k1 - k0) * 8);
  check("partial sums rc=0", e.porw_csr_partial_sums(syn, perm, a0, n, k0, k1, ps) === 0);
  const sums = new BigUint64Array(k.memory.buffer, ps, k1 - k0); const last = k1 > k0 ? sums[k1 - k0 - 1] : 0n;
  check(`partial sums consistent with activation (neuron ${i}, in-degree ${k1 - k0})`, Number(last >> 16n > 65536n ? 65536n : last >> 16n) === k.u32(a1, n)[i]);
  // leaves vs noble
  const al = k.alloc(n * 32); e.porw_act_leaves(a1, n, 0, al);
  const le32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  let okA = true; const A1 = k.u32(a1, n); for (let j = 0; j < n; j += 97) okA &&= V.eq(k.u8(al + j * 32, 32), V.keccak(new Uint8Array([...le32(j), ...le32(A1[j])])));
  check("act leaves == noble keccak(LE32 i || LE32 act)", okA);
  const rl = k.alloc((n + 1) * 32); e.porw_rowstart_leaves(rs, n + 1, 0, rl);
  let okR = true; for (let j = 0; j <= n; j += 101) okR &&= V.eq(k.u8(rl + j * 32, 32), V.keccak(new Uint8Array([...le32(j), ...le32(R[j])])));
  check("rowStart leaves == noble", okR);
  const CH = 64, nc = Math.ceil(ns / CH); const cl = k.alloc(nc * 32);
  check("csr chunk leaves rc=0", e.porw_csr_chunk_leaves(syn, perm, ns, CH, 0, nc, cl) === 0);
  let okC = true; for (const c of [0, 7, nc - 1]) { const k0c = c * CH, k1c = Math.min(k0c + CH, ns); const parts = [le32(c)]; for (let kk = k0c; kk < k1c; kk++) parts.push(S.subarray(P[kk] * 10, P[kk] * 10 + 10)); okC &&= V.eq(k.u8(cl + c * 32, 32), V.keccak(new Uint8Array(parts.flatMap((x) => [...x])))); }
  check("csr chunk leaves == noble (first, middle, last/short chunk)", okC); }
{ const e = k.exports; let ok = true;
  for (const [N, m] of [[133, 3], [1024, 4], [1025, 5], [7, 1], [2, 1], [1, 0]]) {
    const leaves = new Uint8Array(N * 32).map((_, i) => (i * 13 + N) & 0xff); const lp = k.put(leaves); const tp = k.alloc(k.treeNodes(N) * 32);
    const nb = Math.ceil(N / (1 << m)); ok &&= e.porw_merkle_tree_build_blocks(lp, N, tp, m, 0, nb) === 0 && e.porw_merkle_tree_build_upper(tp, N, m) === 0;
    const root = new Uint8Array(k.u8(tp + (k.treeNodes(N) - 1) * 32, 32)); ok &&= V.eq(root, k.merkleRoot(leaves));
    const tree = { ptr: tp, n: N }; for (let i = 0; i < N; i++) { const a = k.treeProof(tree, i), b = k.merkleProof(leaves, i); ok &&= a.length === b.length && a.every((x, j) => V.eq(x, b[j])); } }
  check("block-parallel tree build == streaming (roots + all proofs, incl. odd sizes and partial last block)", ok); }
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`); process.exit(fails ? 1 : 0);
