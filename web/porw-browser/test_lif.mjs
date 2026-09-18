// `aigg:exec:int-lif:v1` — determinism across implementations, node commitments, and the execution dispute.
//   node test_lif.mjs [real-flywire-v2.bin ref.json]   (the real export + numpy reference, if present)
import fs from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import { makeMep } from "./mep.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
import * as L from "./lif.js";
import * as Vf from "./verifier.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const hexs = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// numpy's leaf-preimage layout (i, v, g, refr | flags<<16, count) x u32 LE, sha256 over all neurons
const preimageSha = (stateBytes, n) => { const dv = new DataView(stateBytes.buffer, stateBytes.byteOffset); const out = new Uint8Array(n * 20); const o = new DataView(out.buffer);
  for (let i = 0; i < n; i++) { o.setUint32(i * 20, i, true); o.setUint32(i * 20 + 4, dv.getUint32(i * 16, true), true); o.setUint32(i * 20 + 8, dv.getUint32(i * 16 + 4, true), true); o.setUint32(i * 20 + 12, dv.getUint32(i * 16 + 8, true), true); o.setUint32(i * 20 + 16, dv.getUint32(i * 16 + 12, true), true); }
  return "0x" + hexs(sha256(out)); };

// ---- 1. the real brain vs the numpy reference (bit-identical trajectories) ----
const realPath = process.argv[2], refPath = process.argv[3];
if (realPath && fs.existsSync(realPath) && refPath && fs.existsSync(refPath)) {
  const payload = new Uint8Array(fs.readFileSync(realPath)); const ref = JSON.parse(fs.readFileSync(refPath));
  const k = await loadKernelFromBytes(wasm); const e = k.exports; const hdr = decodeHeader(payload); const n = hdr.neurons;
  check(`real export decodes: v2, ${n} neurons, ${hdr.synapses} records`, hdr.version === 2 && n === ref.neurons);
  const bufPtr = k.put(payload); let cur = k.alloc(n * 16), nxt = k.alloc(n * 16); const acc = k.alloc(n * 8);
  const stim = e.porw_lif_state0_canonical(cur, n, ref.seed); check(`canonical stimulus set: ${stim} neurons (numpy ${ref.stimulated})`, stim === ref.stimulated);
  let allEq = preimageSha(k.u8(cur, n * 16), n) === ref.state_sha256[0]; let tInfer = 0, tRows = 0;
  const rs = k.alloc((n + 1) * 4), perm = k.alloc(hdr.synapses * 4), cursor = k.alloc(n * 4); e.porw_csr_build(bufPtr + hdr.synOffset, hdr.synapses, n, rs, perm, cursor);
  const sorted = e.porw_csr_is_identity(perm, hdr.synapses) === 1; check("real export records are post-sorted (publication convention)", sorted);
  const rowsOut = k.alloc(n * 16); let rowsEq = true;
  for (let s = 1; s <= ref.steps; s++) {
    let t0 = performance.now(); if (e.porw_lif_step(bufPtr + hdr.synOffset, hdr.synapses, cur, nxt, acc, n, s, ref.seed) !== 0) throw new Error("step"); tInfer += performance.now() - t0;
    t0 = performance.now(); if (e.porw_lif_step_rows_direct(bufPtr + hdr.synOffset, rs, cur, rowsOut, n, 0, n, s, ref.seed) !== 0) throw new Error("rows"); tRows += performance.now() - t0;
    if (Buffer.compare(Buffer.from(k.u8(rowsOut, n * 16)), Buffer.from(k.u8(nxt, n * 16))) !== 0) rowsEq = false;
    if (preimageSha(k.u8(nxt, n * 16), n) !== ref.state_sha256[s]) { allEq = false; console.log("   mismatch at step", s); break; }
    [cur, nxt] = [nxt, cur];
  }
  check(`wasm scatter trajectory == numpy reference for ${ref.steps} steps (${(ref.steps / 10).toFixed(1)} ms of brain time)`, allEq);
  check("wasm post-sorted row kernel == scatter kernel (bit-identical states)", rowsEq);
  const counts = k.alloc(n * 4); e.porw_lif_counts(cur, n, counts); const c = k.u32(counts, n); let tot = 0, act = 0; for (const x of c) { tot += x; if (x) act++; }
  check(`spike totals match numpy: ${tot} spikes, ${act} active neurons`, tot === ref.total_spikes && act === ref.active_neurons);
  console.log(`   real brain: scatter ${(tInfer / ref.steps).toFixed(1)} ms/step, post-sorted rows ${(tRows / ref.steps).toFixed(1)} ms/step (single thread)`);
} else console.log("  (skip) real export / numpy reference not given");

// ---- 2. node commitments + claim + redundant re-execution on a synthetic v2 brain ----
const payload = synthesizePayloadV2("lif-test", 5000, 150000); const steps = 100, stride = 10, seed = 3; const ch = new Uint8Array(32).fill(9);
const stimulusIds = Uint32Array.from({ length: 400 }, (_, j) => j * 11); // an explicit task stimulus set (sorted ids)
const mk = async (priv, lie) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + priv.repeat(32) }); if (lie) nd.execLie = lie; const st = await nd.loadModel("lif-test", payload, { maxSteps: steps }); const r = await nd.challenge(st.mep.mepId, ch, { steps, commitStride: stride, stimulusSeed: seed, stimulusIds }); return { nd, st, r, mep: st.mep.mepId }; };
const A = await mk("11"); const n = A.st.hdr.neurons;
check("MEP pins the LIF exec kind and the model structure -- and nothing about a run", V.eq(A.st.mep.execKind, L.lifExecKind()) && !("steps" in A.st.mep) && !("clampQ16" in A.st.mep) && V.eq(A.st.mep.mepId, makeMep({ name: "lif-test", ...V.profileOf(payload, decodeHeader(payload)), execKind: L.lifExecKind() }).mepId));
const vA = Vf.verifyClaim(A.r, A.st.mep, ch); check("LIF claim verifies (hash, signature)", vA.ok);
const run = { stimulusSeed: seed, steps, execDigest: A.r.result.execDigest };
const re = Vf.reexecuteLif(await loadKernelFromBytes(wasm), payload, run, { stimulusIds }); check("redundant re-execution (no commitments) reproduces the counts digest", re.matches);
check("re-execution with the canonical (wrong) stimulus set does NOT match", !Vf.reexecuteLif(await loadKernelFromBytes(wasm), payload, run).matches);
let tot = 0; for (const x of re.counts) tot += x; check(`activity propagates on the synthetic brain: ${tot} spikes (${A.r.result.stimulated} stimulated)`, tot > A.r.result.stimulated * 2);
// independent recompute of commitments with noble: state_0 root, a mid-run state root, execRoot
{ const s0 = await A.nd.lifStates(A.mep, 0); const leaves = []; for (let i = 0; i < n; i++) leaves.push(L.stateLeaf(i, L.decodeState(s0, i * 16)));
  check("initStateRoot == noble recompute over state_0 (stimulus flags)", V.eq(V.merkleRoot(leaves), A.r.result.initStateRoot));
  const idSet = new Set(stimulusIds); let stimOk = true; for (let i = 0; i < n; i++) { const s = L.decodeState(s0, i * 16); if ((s.flags & 1) !== (idSet.has(i) ? 1 : 0) || s.v || s.g || s.refr || s.count) stimOk = false; } check("state_0 matches the task's stimulus set", stimOk);
  // the verifier computes the same initStateRoot from the task input alone (the task's inputCommit)
  const l0 = []; for (let i = 0; i < n; i++) l0.push(L.stateLeaf(i, { v: 0, g: 0, refr: 0, flags: idSet.has(i) ? 1 : 0, count: 0 })); check("initStateRoot derivable by anyone from the stimulus id list", V.eq(V.merkleRoot(l0), A.r.result.initStateRoot));
  check(`segment roots: ${A.r.result.actRoots.length} == ceil(${steps}/${stride}) -- the stride is the task's, not the MEP's`, A.r.result.actRoots.length === Math.ceil(steps / stride));
  const sm = await A.nd.lifStates(A.mep, 3 * stride); const lv = []; for (let i = 0; i < n; i++) lv.push(L.stateLeaf(i, L.decodeState(sm, i * 16)));
  check(`state root at step ${3 * stride} (replayed from checkpoint) == committed segment root 2`, V.eq(V.merkleRoot(lv), A.r.result.actRoots[2]));
  const seg = await A.nd.lifSegmentRoots(A.mep, 1); check(`per-step roots inside segment 1 end at its committed root (${seg.roots.length} steps)`, V.eq(seg.roots[seg.roots.length - 1], A.r.result.actRoots[1]));
  check("execRoot == merkle(segment roots)", V.eq(A.r.result.execRoot, V.merkleRoot(A.r.result.actRoots))); }
// the JS transition reproduces the wasm trajectory neuron by neuron (row semantics == kernel semantics)
{ const s20 = await A.nd.lifStates(A.mep, 20), s21 = await A.nd.lifStates(A.mep, 21); let ok = true, tested = 0;
  for (let i = 0; i < n; i += 7) { const ps = await A.nd.lifPartialSums(A.mep, 21, i); const exp = L.transition(L.decodeState(s20, i * 16), ps.sums.length ? ps.sums[ps.sums.length - 1] : 0n, i, 21, seed); if (!L.sameState(exp, L.decodeState(s21, i * 16))) ok = false; tested++; }
  check(`JS transition(state_20, last partial sum) == wasm state_21 for ${tested} sampled neurons`, ok); }

// ---- 3. dispute: a lying executor is caught at the row / at the single term ----
const B = await mk("22", { step: 23, neuron: 123, delta: 5000 }); // neuron 123 is not stimulated (123 % 11 != 0); step 23 is inside segment 2
check("A and B disagree on execRoot", !V.eq(A.r.result.execRoot, B.r.result.execRoot));
const segStar = D.firstDifferingStep(A.r.result.actRoots, B.r.result.actRoots) - 1; check(`first differing segment = 2 (got ${segStar})`, segStar === 2);
const segA = await A.nd.lifSegmentRoots(A.mep, segStar), segB = await B.nd.lifSegmentRoots(B.mep, segStar);
const ref = D.refineSegment({ seg: segStar, stride, steps, prevAgreed: segStar ? A.r.result.actRoots[segStar - 1] : A.r.result.initStateRoot, segRootA: A.r.result.actRoots[segStar], segRootB: B.r.result.actRoots[segStar], rootsA: segA.roots, rootsB: segB.roots });
const sStar = ref.step; check(`segment refinement: first differing step = 23 (got ${sStar}), previous-step root agreed`, sStar === 23 && ref.loser === null && V.eq(ref.prevRoot, segA.roots[1]));
{ const forged = segB.roots.slice(); forged[forged.length - 1] = segA.roots[segA.roots.length - 1]; // B tries to pass off A's chain end: not bound to B's committed root
  const r2 = D.refineSegment({ seg: segStar, stride, steps, prevAgreed: A.r.result.actRoots[segStar - 1], segRootA: A.r.result.actRoots[segStar], segRootB: B.r.result.actRoots[segStar], rootsA: segA.roots, rootsB: forged });
  check("a per-step chain not ending at the committed segment root blames its party", r2.loser === "B"); }
async function bisectAsync(nodeA, nodeB, n) { const { treeWidths } = await import("./porw.js"); const w = treeWidths(n); let level = w.length - 1, idx = 0; let rounds = 0;
  while (level > 0) { const l = 2 * idx, r = l + 1, lw = w[level - 1]; const left = !V.eq(await nodeA(level - 1, l), await nodeB(level - 1, l)); rounds++; if (left) idx = l; else if (r < lw) idx = r; else idx = l; level--; } return { leaf: idx, rounds }; }
const bs = await bisectAsync((l, i) => A.nd.lifNode(A.mep, sStar, l, i), (l, i) => B.nd.lifNode(B.mep, sStar, l, i), n);
check(`state-tree bisection finds neuron 123 in ${bs.rounds} rounds (got ${bs.leaf})`, bs.leaf === 123);
const iStar = bs.leaf;
const rowStart = A.nd.openRowStart(A.mep, iStar), rowEnd = A.nd.openRowStart(A.mep, iStar + 1);
const prevOpen = await A.nd.lifOpenState(A.mep, sStar - 1, iStar); // agreed previous root (A's tree; roots agree)
const base = { n, nChunks: A.st.csr.nChunks, chunk: A.st.csr.chunk, csrRoot: A.r.result.csrRoot, rowRoot: A.r.result.rowRoot, synapseRoot: A.r.result.synapseRoot,
               prevRoot: ref.prevRoot, seed, step: sStar, i: iStar, rowStart, rowEnd, prevOpen };
const party = async (P) => ({ claimed: (await P.nd.lifOpenState(P.mep, sStar, iStar)).state, sums: (await P.nd.lifPartialSums(P.mep, sStar, iStar)).sums });
const pa = await party(A), pb = await party(B);
check("B's claimed state is bound to a different leaf than A's", !V.eq(L.stateLeaf(iStar, pa.claimed), L.stateLeaf(iStar, pb.claimed)));
{ const kStar = rowStart.value; const chunkOpen = A.nd.openCsrChunk(A.mep, Math.floor(kStar / base.chunk));
  const rec = L.recordSigned(chunkOpen.records.subarray((kStar - chunkOpen.k0) * 10, (kStar - chunkOpen.k0) * 10 + 10)); const preOpen = await A.nd.lifOpenState(A.mep, sStar - 1, rec.pre);
  const v = D.adjudicateLif({ ...base, chunkOpen, preOpen, partyA: pa, partyB: pb });
  check(`scenario 1 (lie in the state): loser = B by the LIF row check (${v.reason})`, v.loser === "B" && v.checks.rowA && !v.checks.rowB); }
{ const len = pa.sums.length; check(`neuron ${iStar} has in-degree ${len} > 2`, len > 2);
  const jLie = Math.floor(len / 2); const lied = pa.sums.slice(); for (let j = jLie; j < len; j++) lied[j] += 40n; // consistent lie: claimed state follows from the lied sums
  const partyB = { claimed: L.transition(prevOpen.state, lied[len - 1], iStar, sStar, seed), sums: lied };
  check("the consistent liar's claimed state differs from the honest one (the lie matters)", !L.sameState(partyB.claimed, pa.claimed));
  const kStar = rowStart.value + jLie; const chunkOpen = A.nd.openCsrChunk(A.mep, Math.floor(kStar / base.chunk));
  const rec = L.recordSigned(chunkOpen.records.subarray((kStar - chunkOpen.k0) * 10, (kStar - chunkOpen.k0) * 10 + 10)); const preOpen = await A.nd.lifOpenState(A.mep, sStar - 1, rec.pre);
  const v = D.adjudicateLif({ ...base, chunkOpen, preOpen, partyA: pa, partyB });
  check(`scenario 2 (lie in the partial sums): loser = B at the divergent term (${v.reason})`, v.loser === "B" && v.checks.kStar === kStar && v.checks.chunkProof && v.checks.preProof);
  const v2 = D.adjudicateLif({ ...base, chunkOpen, preOpen, partyA: partyB, partyB: pa }); check("swapped roles: still blames the liar", v2.loser === "A"); }
const A2 = await mk("33"); check("two honest executors: identical segment roots and digest", D.firstDifferingStep(A.r.result.actRoots, A2.r.result.actRoots) === null && V.eq(A.r.result.execDigest, A2.r.result.execDigest));
console.log(`per-slot timings (A, single thread, ${n} neurons, ${steps} steps): ${JSON.stringify(A.r.timings)}`);
// fixtures for the Solidity row-check test: transition vectors covering every branch of the rule
if (process.argv[4]) {
  const vec = []; const want = { stim: 2, refr: 2, spike: 2, sub: 2, neg: 2 };
  for (let s = 21; s <= steps && Object.values(want).some((x) => x > 0); s += 3) {
    const sp = await A.nd.lifStates(A.mep, s - 1), sn = await A.nd.lifStates(A.mep, s);
    for (let i = 0; i < n && Object.values(want).some((x) => x > 0); i++) { const S = L.decodeState(sp, i * 16), R = L.decodeState(sn, i * 16);
      const ps = await A.nd.lifPartialSums(A.mep, s, i); const I = ps.sums.length ? ps.sums[ps.sums.length - 1] : 0n;
      const kind = S.flags & 1 ? "stim" : S.refr > 0 ? "refr" : (R.flags & 2) ? "spike" : I < 0n ? "neg" : (I > 0n ? "sub" : null); if (!kind || !want[kind]) continue; want[kind]--;
      vec.push({ kind, i, step: s, seed, I: I.toString(), before: S, after: R, leafAfter: V.hex(L.stateLeaf(i, R)) }); } }
  fs.writeFileSync(process.argv[4], JSON.stringify({ execKind: V.hex(L.lifExecKind()), params: L.LIF, vectors: vec }, null, 1));
  const st = (x) => `LifRowCheck.State(${x.v}, ${x.g}, ${x.refr}, ${x.flags}, ${x.count})`;
  const sol = `// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
// GENERATED by web/porw-browser/test_lif.mjs from a real node run (synthetic v2 brain) — do not edit.
import "../../src/mesh/LifRowCheck.sol";

library LifVectors {
    bytes32 constant EXEC_KIND = ${V.hex(L.lifExecKind())};
    uint32 constant N = ${vec.length};
    struct Vec { uint32 i; uint32 step; uint32 seed; int64 I; LifRowCheck.State before; LifRowCheck.State after_; bytes32 leafAfter; string kind; }
    function get(uint32 j) internal pure returns (Vec memory v) {
${vec.map((x, j) => `        if (j == ${j}) return Vec(${x.i}, ${x.step}, ${x.seed}, ${x.I}, ${st(x.before)}, ${st(x.after)}, ${x.leafAfter}, "${x.kind}");`).join("\n")}
        revert("vec");
    }
}
`;
  fs.writeFileSync(new URL("../../contracts/evm/test/fixtures/LifVectors.sol", import.meta.url), sol);
  console.log(`   wrote ${vec.length} transition vectors (${vec.map((v) => v.kind).join(",")}) -> ${process.argv[4]} + LifVectors.sol`);
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
