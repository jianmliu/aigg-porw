// FLYDELTAv1 delta payloads: diff/apply round trip on synthetic v2 brains (bytes and model_id identical to a directly
// written target), edit semantics (set / insert / delete), strictness (base binding, neuron count, order, unknown delete),
// and the node loading a delta model with the same MEP as the target payload. Optionally the real brain:
//   node test_delta.mjs [flywire-783-min5.bin target.bin]   (apply(diff(base, target)) must reproduce target)
import fs from "node:fs";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import * as V from "./verify.js";
import { applyDelta, diffPayloads, decodeDelta, encodeDelta, records, encodePayload, modelIdOf, deltaId, encodeDelta2, decodeDelta2, applyDelta2, sampleCounts, encodeDelta3, decodeDelta3, genotype, GRANULARITY } from "./delta.js";
import { nbTable, hash64, hash64Words, lnQ60, expQ256, DEFAULT_R_TABLE } from "./sample.js";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; } };
const n = 3000, ns = 30000;
const base = synthesizePayloadV2("synthetic-base", n, ns);
// a target: same neurons/root ids, records edited: 50 deleted, 50 reweighted, 50 inserted (new pairs)
const recs = records(base); const cmp = (a, b) => (a.post - b.post) || (a.pre - b.pre); const have = new Set(recs.map((r) => r.post * n + r.pre));
const edited = recs.slice(); for (let i = 0; i < 50; i++) edited.splice(i * 37, 1); for (let i = 0; i < 50; i++) edited[i * 101].w = i - 25 || 7;
let added = 0, seed = 12345; while (added < 50) { seed = (seed * 1103515245 + 12345) >>> 0; const pre = seed % n, post = (seed >>> 12) % n; if (pre === post || have.has(post * n + pre)) continue; have.add(post * n + pre); edited.push({ pre, post, w: (added % 2 ? 1 : -1) * (added + 1) }); added++; }
edited.sort(cmp); const target = encodePayload(base, "synthetic-target", edited);
check(`target payload written directly: ${edited.length} records (${ns} - 50 + 50), ${target.length / 4096} tiles`, decodeHeader(target).synapses === ns && target.length % 4096 === 0);
// diff -> apply round trip
const delta = diffPayloads(base, target, { baseDA: "gnfd://aigg-brains/synthetic-base.bin" }); const d = decodeDelta(delta);
check(`delta: ${d.ops.length} ops (50 deletes + 50 sets + 50 inserts), ${delta.length} bytes vs ${target.length} for the payload, bound to the base model_id`, d.ops.length === 150 && d.ops.filter((o) => o.w === 0).length === 50 && V.eq(d.baseModelId, modelIdOf(base)) && d.baseDA.startsWith("gnfd://") && d.name === "synthetic-target");
const applied = applyDelta(base, delta);
check("apply(diff(base, target)) == target byte for byte", V.eq(applied, target));
check("model_id of the applied bytes == model_id of the directly written target", V.eq(modelIdOf(applied), modelIdOf(target)));
check("delta id is the keccak of the delta bytes (32 B)", deltaId(delta).length === 32);
// empty delta with the base's name reproduces the base exactly
const empty = encodeDelta({ baseModelId: modelIdOf(base), neurons: n, name: decodeHeader(base).name, ops: [] });
check("empty delta reproduces the base byte for byte", V.eq(applyDelta(base, empty), base));
// strictness
const mid = modelIdOf(base); const other = synthesizePayloadV2("other", n, ns);
check("rejects a delta bound to another base (model id mismatch)", throws(() => applyDelta(other, delta), /base model id mismatch/));
check("rejects a neuron-count mismatch", throws(() => applyDelta(synthesizePayloadV2("small", n - 1, 100), encodeDelta({ baseModelId: mid, neurons: n, name: "x", ops: [] })), /neuron count/));
check("rejects unsorted / duplicate ops on decode", throws(() => { const b = encodeDelta({ baseModelId: mid, neurons: n, name: "x", ops: [{ pre: 1, post: 2, w: 3 }, { pre: 0, post: 2, w: 3 }] }); const dv = new DataView(b.buffer); const off = b.length - 20; const a = b.slice(off, off + 10); b.set(b.subarray(off + 10, off + 20), off); b.set(a, off + 10); decodeDelta(b); }, /sorted/));
check("rejects a delete of a record the base lacks", throws(() => { let pre = 0, post = 1; while (have.has(post * n + pre)) pre++; applyDelta(base, encodeDelta({ baseModelId: mid, neurons: n, name: "x", ops: [{ pre, post, w: 0 }] })); }, /base lacks/));
check("rejects an out-of-range neuron index", throws(() => encodeDelta({ baseModelId: mid, neurons: n, name: "x", ops: [{ pre: n, post: 0, w: 1 }] }), /out of range/));
check("rejects a duplicate op", throws(() => encodeDelta({ baseModelId: mid, neurons: n, name: "x", ops: [{ pre: 1, post: 2, w: 3 }, { pre: 1, post: 2, w: 4 }] }), /duplicate/));
// the node: loading (base, delta) yields the same MEP / model_id as loading the target payload
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const A = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) }), B = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "22".repeat(32) });
const stA = await A.loadModel("synthetic-target", target, { steps: 20, exec: "lif", commitStride: 10 }); const stB = await B.loadDelta(base, delta, { steps: 20, exec: "lif", commitStride: 10 });
check("node.loadDelta(base, delta): same model_id, mepId and synapseRoot as loading the target payload", V.eq(stA.modelId, stB.modelId) && V.eq(stA.mep.mepId, stB.mep.mepId) && V.eq(stA.csr.synapseRoot, stB.csr.synapseRoot) && stB.delta && V.eq(stB.delta.baseModelId, mid));
const rA = await A.challenge(stA.mep.mepId, new Uint8Array(32), { stimulusSeed: 3 }), rB = await B.challenge(stB.mep.mepId, new Uint8Array(32), { stimulusSeed: 3 });
check("and the same execution digest", V.eq(rA.result.execDigest, rB.result.execDigest));

// ---- FLYDELTAv2: procedural individuals ----
{
  const Q60 = 1n << 60n; const near = (a, b, tol) => Math.abs(Number(a) / Number(b) - 1) < tol;
  check("fixed-point ln(1/2) and exp(ln(1/2)) round trip", near(lnQ60(1n, 2n), -799144290325165978n, 1e-12) && near(expQ256(lnQ60(1n, 2n)), (1n << 256n) / 2n, 1e-9));
  const t = nbTable(5, 236, 65536); const p0 = Number(t[0]) / 2 ** 64; // NB(mean 5, r 0.92): P(0) = (r/(r+m))^r
  check(`NB(5, r=236/256) table: P(0) ${p0.toFixed(4)} == (r/(r+m))^r, monotone, ends at 1`, near(p0, Math.pow(0.921875 / 5.921875, 0.921875), 1e-6) && t.every((v, i) => !i || v >= t[i - 1]) && t[t.length - 1] === 2n ** 64n - 1n);
  const d2 = encodeDelta2({ baseModelId: mid, neurons: n, seed: 7n, name: "synthetic-ind7", baseDA: "gnfd://x/y" }); const D2 = decodeDelta2(d2);
  check(`v2 delta is ${d2.length} bytes (seed, min_syn 5, ${D2.rTable.length}-row r table, no ops)`, d2.length < 200 && D2.seed === 7n && D2.minSyn === 5 && D2.rTable.length === DEFAULT_R_TABLE.length);
  const i7 = applyDelta(base, d2), i7b = applyDelta2(base, d2), i8 = applyDelta(base, encodeDelta2({ baseModelId: mid, neurons: n, seed: 8n, name: "synthetic-ind8" }));
  check("apply is deterministic (same seed twice) and seed-dependent", V.eq(i7, i7b) && !V.eq(i7, i8) && decodeHeader(i7).name === "synthetic-ind7");
  const rb = records(base), r7 = records(i7); const key = (r) => r.post * n + r.pre; const bm = new Map(rb.map((r) => [key(r), r.w]));
  check(`individual keeps signs and drops records below min_syn: ${r7.length} of ${rb.length} records kept, all >= 5, signs as base`, r7.every((r) => Math.abs(r.w) >= 5 && Math.sign(r.w) === Math.sign(bm.get(key(r)))) && r7.length < rb.length);
  const c = sampleCounts(rb, 7n, 65536, DEFAULT_R_TABLE); let sum = 0, sumB = 0; for (let i = 0; i < rb.length; i++) { sum += c[i]; sumB += Math.abs(rb[i].w); }
  check(`resampled total count within 10% of the base total (${sum} vs ${sumB}): mean ratio 1`, Math.abs(sum / sumB - 1) < 0.1);
  const one = encodeDelta2({ baseModelId: mid, neurons: n, seed: 7n, name: "m1", minSyn: 1 }); check("min_syn 1 keeps every record with c' >= 1 (more than min_syn 5)", records(applyDelta(base, one)).length > r7.length);
  const del = r7[0]; const ops2 = encodeDelta2({ baseModelId: mid, neurons: n, seed: 7n, name: "ops", ops: [{ pre: del.pre, post: del.post, w: 0 }, { pre: (del.pre + 1) % n, post: del.post, w: 99 }] }); const ro = records(applyDelta(base, ops2));
  check("explicit ops apply after sampling: delete + insert honoured, sorted output", !ro.some((r) => r.pre === del.pre && r.post === del.post) && ro.some((r) => r.pre === (del.pre + 1) % n && r.post === del.post && r.w === 99) && ro.every((r, i) => !i || (r.post - ro[i - 1].post) || (r.pre - ro[i - 1].pre) > 0));
  let absent = { pre: 0, post: 1 }; while (bm.has(key(absent))) absent.pre++; check("a v2 delete of a record the individual lacks is a no-op (lenient)", !throws(() => applyDelta(base, encodeDelta2({ baseModelId: mid, neurons: n, seed: 7n, name: "len", ops: [{ ...absent, w: 0 }] }))));
  check("v2 rejects a foreign base and a bad r table", throws(() => applyDelta(other, d2), /base model id mismatch/) && throws(() => encodeDelta2({ baseModelId: mid, neurons: n, seed: 1n, name: "x", rTable: [[2, 100]] }), /start at c=1/));
  const C = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "33".repeat(32) }); const stC = await C.loadDelta(base, d2, { steps: 20, exec: "lif", commitStride: 10 }); const stD = await A.loadModel("synthetic-ind7", i7, { steps: 20, exec: "lif", commitStride: 10 });
  check("node.loadDelta(base, v2 delta): model_id / mepId of the sampled individual, delta version recorded", V.eq(stC.modelId, stD.modelId) && V.eq(stC.mep.mepId, stD.mep.mepId) && stC.delta.version === 2 && stC.delta.seed === 7n);
}

// ---- FLYDELTAv3: same-base cross ----
{
  let same = 0; for (let i = 0; i < 4000; i++) if (hash64Words(5, 0, i, (i * 7919) % n)[0] === hash64Words(5, 1, i, (i * 7919) % n)[0]) same++;
  check("hash64: seeds differing only in the high word give different high words of the uniform", same < 5);
  const src = records(base); const mk2 = (seed) => encodeDelta2({ baseModelId: mid, neurons: n, seed, name: "F" + seed, minSyn: 1 }); const f1 = mk2(1n), f2 = mk2(2n), f3 = mk2(3n);
  const byId = new Map([f1, f2, f3].map((b) => [V.hex(deltaId(b)), b])); const resolve = (id) => byId.get(id); const reg = (b) => { byId.set(V.hex(deltaId(b)), b); return b; };
  const cross = (a, b, seed, o = {}) => reg(encodeDelta3({ baseModelId: mid, neurons: n, parentA: deltaId(a), parentB: deltaId(b), seed, name: "X" + seed, minSyn: 1, ...o }));
  const c1 = cross(f1, f2, 101n), c2 = cross(f1, f2, 102n); const D3 = decodeDelta3(c1);
  check(`v3 delta is ${c1.length} bytes: two parent ids, seed, granularity, mutation rate 1/8`, c1.length < 260 && V.eq(D3.parentA, deltaId(f1)) && V.eq(D3.parentB, deltaId(f2)) && D3.granularity === 0 && D3.mutRateQ32 === 2 ** 29);
  const cache = new Map(); const G = (d) => genotype(src, mid, d, { resolve, cache }); const dist = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(Math.log((x[i] + 1) / (y[i] + 1))); return s / x.length; };
  const gF1 = G(f1), gF2 = G(f2), gF3 = G(f3), gC1 = G(c1), gC2 = G(c2);
  const dPC = (dist(gC1, gF1) + dist(gC1, gF2)) / 2, dSib = dist(gC1, gC2), dUn = dist(gC1, gF3), dFF = dist(gF1, gF2);
  check(`kinship gradient: parent-child ${dPC.toFixed(3)} < siblings ${dSib.toFixed(3)} < unrelated ${dUn.toFixed(3)} ~ founders ${dFF.toFixed(3)}`, dPC < dSib && dSib < dUn && Math.abs(dUn / dFF - 1) < 0.1);
  check("both parents contribute equally (record granularity)", Math.abs(dist(gC1, gF1) / dist(gC1, gF2) - 1) < 0.1);
  const pure = G(cross(f1, f2, 103n, { mutRateQ32: 0 })); let fromA = 0, ok = true; for (let i = 0; i < src.length; i++) { if (pure[i] === gF1[i]) fromA++; if (pure[i] !== gF1[i] && pure[i] !== gF2[i]) ok = false; }
  check(`no mutation: every record carries one parent's count exactly (${(100 * fromA / src.length).toFixed(0)}% match A)`, ok && fromA > 0.45 * src.length);
  const gp = G(cross(f1, f2, 104n, { mutRateQ32: 0, granularity: GRANULARITY.pre })); const side = new Map(); let linked = true; for (let i = 0; i < src.length; i++) { const a = gp[i] === gF1[i], b = gp[i] === gF2[i]; if (a === b) continue; const k = src[i].pre; if (!side.has(k)) side.set(k, a); else if (side.get(k) !== a) linked = false; }
  check("granularity pre: all outputs of a neuron come from the same parent", linked && side.size > 100);
  const self = G(cross(f1, f1, 105n, { mutRateQ32: 0 })); check("a self-cross without mutation is the parent", self.every((v, i) => v === gF1[i]));
  const zero = new Uint8Array(32); const withBase = G(reg(encodeDelta3({ baseModelId: mid, neurons: n, parentA: deltaId(f1), parentB: zero, seed: 106n, name: "xb", mutRateQ32: 0 }))); check("parent id 0 = the published base", withBase.every((v, i) => v === gF1[i] || v === Math.abs(src[i].w)));
  const g1 = cross(c1, c2, 201n); const a1 = applyDelta(base, g1, { resolve }), a2 = applyDelta(base, g1, { resolve, cache: new Map() }); check("a grandchild resolves its ancestors recursively and deterministically", V.eq(a1, a2) && decodeHeader(a1).name === "X201");
  check("rejects a missing ancestor, a parent with explicit ops and a parent of another base", throws(() => applyDelta(base, g1, { resolve: () => null }), /not provided/)
    && throws(() => { const p = reg(encodeDelta2({ baseModelId: mid, neurons: n, seed: 9n, name: "ops", ops: [{ pre: 0, post: 1, w: 5 }] })); applyDelta(base, cross(p, f1, 107n), { resolve }); }, /no explicit ops/)
    && throws(() => { const p = reg(encodeDelta2({ baseModelId: modelIdOf(other), neurons: n, seed: 9n, name: "foreign" })); applyDelta(base, cross(p, f1, 108n), { resolve }); }, /base model id mismatch/));
  const E = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "44".repeat(32) }); const stE = await E.loadDelta(base, c1, { resolve, steps: 20, exec: "lif", commitStride: 10 }); check("node.loadDelta(base, v3 delta, { resolve }): the child's model_id, parents recorded", V.eq(stE.modelId, modelIdOf(applyDelta(base, c1, { resolve }))) && stE.delta.version === 3 && V.eq(stE.delta.parents[0], deltaId(f1)));
}
// the real brain, if given: apply(base, python-made v2 delta) must reproduce the python-applied payload byte for byte
const [basePath2, deltaPath, appliedPath, ...ancestorPaths] = process.argv.slice(2);
if (basePath2 && deltaPath && appliedPath && fs.existsSync(deltaPath) && fs.existsSync(appliedPath)) {
  const rb = new Uint8Array(fs.readFileSync(basePath2)), rd = new Uint8Array(fs.readFileSync(deltaPath)), ra = new Uint8Array(fs.readFileSync(appliedPath)); const anc = new Map(ancestorPaths.map((f) => new Uint8Array(fs.readFileSync(f))).map((b) => [V.hex(deltaId(b)), b])); const t0 = performance.now(); const out = applyDelta(rb, rd, { resolve: (id) => anc.get(id) }); check(`real brain: procedural delta (${rd.length} B, ${anc.size} ancestors) reproduces the Python-applied payload byte for byte (${records(out).length} records, ${Math.round(performance.now() - t0)} ms)`, V.eq(out, ra));
}
// the real brain, if given
const [basePath, targetPath] = process.argv.slice(2).length === 2 ? process.argv.slice(2) : [];
if (basePath && targetPath && fs.existsSync(basePath) && fs.existsSync(targetPath)) {
  const rb = new Uint8Array(fs.readFileSync(basePath)), rt = new Uint8Array(fs.readFileSync(targetPath)); const t0 = performance.now(); const rd = diffPayloads(rb, rt); const t1 = performance.now(); const ra = applyDelta(rb, rd); const t2 = performance.now();
  check(`real brain: ${decodeDelta(rd).ops.length}-op delta (${rd.length} B) reproduces ${targetPath.split("/").pop()} byte for byte (diff ${Math.round(t1 - t0)} ms, apply ${Math.round(t2 - t1)} ms)`, V.eq(ra, rt));
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
