import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import * as V from "./verify.js";

const fx = JSON.parse(fs.readFileSync(process.env.KECCAK_FIXTURE || new URL("../../spec-cache/conformance/porw/sketch-tile-keccak-v1.json", import.meta.url), "utf8"));
const k = await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url)));
let fails = 0; const check = (name, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + name); if (!ok) fails++; };

// keccak256 vs noble on assorted inputs (incl. multi-block)
for (const n of [0, 1, 135, 136, 137, 4104, 10000]) { const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff); check(`keccak256(${n} B) == noble`, V.eq(k.keccak256(b), V.keccak(b))); }
check("scheme digest matches fixture", V.hex(V.schemeDigest()) === fx.scheme.digest_keccak256);

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
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`); process.exit(fails ? 1 : 0);
