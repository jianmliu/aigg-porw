// FLYDELTAv1 delta payloads: diff/apply round trip on synthetic v2 brains (bytes and model_id identical to a directly
// written target), edit semantics (set / insert / delete), strictness (base binding, neuron count, order, unknown delete),
// and the node loading a delta model with the same MEP as the target payload. Optionally the real brain:
//   node test_delta.mjs [flywire-783-min5.bin target.bin]   (apply(diff(base, target)) must reproduce target)
import fs from "node:fs";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import * as V from "./verify.js";
import { applyDelta, diffPayloads, decodeDelta, encodeDelta, records, encodePayload, modelIdOf, deltaId } from "./delta.js";
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
// the real brain, if given
const [basePath, targetPath] = process.argv.slice(2);
if (basePath && targetPath && fs.existsSync(basePath) && fs.existsSync(targetPath)) {
  const rb = new Uint8Array(fs.readFileSync(basePath)), rt = new Uint8Array(fs.readFileSync(targetPath)); const t0 = performance.now(); const rd = diffPayloads(rb, rt); const t1 = performance.now(); const ra = applyDelta(rb, rd); const t2 = performance.now();
  check(`real brain: ${decodeDelta(rd).ops.length}-op delta (${rd.length} B) reproduces ${targetPath.split("/").pop()} byte for byte (diff ${Math.round(t1 - t0)} ms, apply ${Math.round(t2 - t1)} ms)`, V.eq(ra, rt));
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
