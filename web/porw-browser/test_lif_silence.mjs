// The silence set of `aigg:exec:int-lif:v1`: flags bit2 in state_0. A silenced neuron never spikes; silence wins over
// the stimulus; the bit persists; and a run with nothing silenced is, bit for bit, the run it always was.
//   node test_lif_silence.mjs [--vectors]   (--vectors prints the transition vectors contracts/evm/test/LifSilence.t.sol pins)
// Three implementations are held against each other here: the wasm kernel, lif.js's transition() driven over the
// payload's records, and int_lif.py (when python3 + numpy are around). Solidity gets the same vectors.
import fs from "node:fs"; import { execFileSync } from "node:child_process"; import os from "node:os"; import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { NodeService } from "./node_service.js";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import * as L from "./lif.js";
import * as Vf from "./verifier.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const N = 3000, SYN = 90000, STEPS = 60, SEED = 5; const payload = synthesizePayloadV2("lif-silence", N, SYN); const hdr = decodeHeader(payload);
const stimulusIds = Uint32Array.from({ length: 300 }, (_, j) => j * 7);

/** run the wasm kernel; returns every state (Uint8Array n*16) from 0..steps */
async function wasmRun(silenceIds) {
  const k = await loadKernelFromBytes(wasm), e = k.exports; const buf = k.put(payload); let cur = k.alloc(N * 16), nxt = k.alloc(N * 16); const acc = k.alloc(N * 8);
  let p = k.alloc(stimulusIds.length * 4); k.u32(p, stimulusIds.length).set(stimulusIds); if (e.porw_lif_state0_set(cur, N, p, stimulusIds.length) !== 0) throw new Error("state0");
  if (silenceIds) { p = k.alloc(silenceIds.length * 4); k.u32(p, silenceIds.length).set(silenceIds); if (e.porw_lif_state0_silence(cur, N, p, silenceIds.length) !== 0) throw new Error("silence"); }
  const states = [new Uint8Array(k.u8(cur, N * 16))];
  for (let s = 1; s <= STEPS; s++) { if (e.porw_lif_step(buf + hdr.synOffset, hdr.synapses, cur, nxt, acc, N, s, SEED) !== 0) throw new Error("step"); [cur, nxt] = [nxt, cur]; states.push(new Uint8Array(k.u8(cur, N * 16))); }
  return states;
}
const countsOf = (st) => Array.from({ length: N }, (_, i) => L.decodeState(st, i * 16).count);
const base = await wasmRun(null); const baseCounts = countsOf(base.at(-1));
// silence the busiest non-stimulated neurons, plus one stimulated neuron (silence must win)
const stimSet = new Set(stimulusIds); const busy = baseCounts.map((c, i) => [c, i]).filter(([c, i]) => c > 0 && !stimSet.has(i)).sort((a, b) => b[0] - a[0]).slice(0, 25).map(([, i]) => i);
const bothId = stimulusIds.find((i) => baseCounts[i] > 0); const silenceIds = Uint32Array.from([...busy, bothId].sort((a, b) => a - b));
check(`the baseline has something to silence: ${busy.length} busy free neurons, stimulated neuron ${bothId} spikes ${baseCounts[bothId]}x`, busy.length === 25 && baseCounts[bothId] > 0);

const sil = await wasmRun(silenceIds); const silCounts = countsOf(sil.at(-1));
check("a silenced neuron never spikes", [...silenceIds].every((i) => silCounts[i] === 0));
check("silence wins over the stimulus", silCounts[bothId] === 0 && (L.decodeState(sil[0], bothId * 16).flags & 5) === 5);
check("the bit persists to the last state, on exactly the silenced neurons", Array.from({ length: N }, (_, i) => ((L.decodeState(sil.at(-1), i * 16).flags & 4) !== 0) === silenceIds.includes(i)).every(Boolean));
check("and the rest of the brain notices", silCounts.some((c, i) => c !== baseCounts[i] && !silenceIds.includes(i)));
check("with nothing silenced the run is the run it always was (empty set == no set)", Buffer.compare(Buffer.from((await wasmRun(new Uint32Array(0))).at(-1)), Buffer.from(base.at(-1))) === 0);

// ---- lif.js transition() over the records, against the kernel, state by state ----
{ const dv = new DataView(payload.buffer, payload.byteOffset + hdr.synOffset, hdr.synapses * 10); let ok = true; const vectors = [];
  for (let s = 1; s <= STEPS && ok; s++) {
    const prev = sil[s - 1], I = new Array(N).fill(0n);
    for (let r = 0; r < hdr.synapses; r++) { const pre = dv.getUint32(r * 10, true), post = dv.getUint32(r * 10 + 4, true); if (L.decodeState(prev, pre * 16).flags & 2) I[post] += BigInt(dv.getInt16(r * 10 + 8, true)); }
    for (let i = 0; i < N; i++) { const S0 = L.decodeState(prev, i * 16), got = L.transition(S0, I[i], i, s, SEED), want = L.decodeState(sil[s], i * 16);
      if (!L.sameState(got, want)) { ok = false; console.log("   mismatch step", s, "neuron", i, got, want); break; }
      // vectors where the silence bit decides the outcome: the same state without it would have moved v or fired.
      // One silenced free neuron and one silenced stimulated neuron, which is what Solidity is held to.
      if ((S0.flags & 4) && vectors.length < 2) { const free = L.transition({ ...S0, flags: S0.flags & ~4 }, I[i], i, s, SEED); const kind = S0.flags & 1;
        if ((free.v !== 0 || (free.flags & 2)) && !vectors.some((v) => (v.before.flags & 1) === kind)) vectors.push({ i, step: s, I: I[i], before: S0, after: want, leaf: hex(L.stateLeaf(i, want)) }); } }
  }
  check(`lif.js transition() == wasm kernel for all ${N} neurons over ${STEPS} steps, silence set included`, ok);
  check("vectors exist where the silence bit decided the outcome, for a free and for a stimulated neuron", vectors.length === 2);
  if (process.argv.includes("--vectors")) for (const v of vectors) console.log(`   VEC i=${v.i} step=${v.step} seed=${SEED} I=${v.I} before=(${v.before.v},${v.before.g},${v.before.refr},${v.before.flags},${v.before.count}) after=(${v.after.v},${v.after.g},${v.after.refr},${v.after.flags},${v.after.count}) leaf=${v.leaf}`);
}

// ---- int_lif.py, if there is a python with numpy ----
{ let py = null; for (const c of [process.env.PYTHON, "python3"]) { if (!c) continue; try { execFileSync(c, ["-c", "import numpy"], { stdio: "ignore" }); py = c; break; } catch {} }
  if (!py) console.log("  (skip) no python3 with numpy: int_lif.py not cross-checked");
  else { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lif-silence-")); const f = path.join(dir, "p.bin"); fs.writeFileSync(f, payload);
    const code = `import sys, json, hashlib; sys.path.insert(0, ${JSON.stringify(path.dirname(new URL(import.meta.url).pathname))}); import int_lif as L
traj = L.run(open(${JSON.stringify(f)}, 'rb').read(), ${SEED}, ${STEPS}, stim_ids=${JSON.stringify([...stimulusIds])}, silence_ids=${JSON.stringify([...silenceIds])})
print(json.dumps([hashlib.sha256(S.leaf_bytes()).hexdigest() for S in traj]))`;
    const got = JSON.parse(execFileSync(py, ["-c", code], { maxBuffer: 1 << 26 }).toString());
    const pre = (st) => { const dvs = new DataView(st.buffer, st.byteOffset); const out = new Uint8Array(N * 20); const o = new DataView(out.buffer); for (let i = 0; i < N; i++) { o.setUint32(i * 20, i, true); o.setUint32(i * 20 + 4, dvs.getUint32(i * 16, true), true); o.setUint32(i * 20 + 8, dvs.getUint32(i * 16 + 4, true), true); o.setUint32(i * 20 + 12, dvs.getUint16(i * 16 + 8, true) | (dvs.getUint16(i * 16 + 10, true) << 16), true); o.setUint32(i * 20 + 16, dvs.getUint32(i * 16 + 12, true), true); } return Array.from(sha256(out), (x) => x.toString(16).padStart(2, "0")).join(""); };
    check(`int_lif.py == wasm kernel, state by state, silence set included (${got.length} states)`, got.length === STEPS + 1 && got.every((h, s) => h === pre(sil[s])));
    fs.rmSync(dir, { recursive: true }); } }

// ---- the node: the silence set is part of state_0, hence of initStateRoot; re-execution needs it too ----
{ const mk = async () => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) }); const st = await nd.loadModel("lif-silence", payload, { maxSteps: STEPS }); return { nd, st }; };
  const A = await mk(); const ch = new Uint8Array(32).fill(7); const opts = { steps: STEPS, commitStride: 10, stimulusSeed: SEED, stimulusIds };
  const r0 = await A.nd.execute(A.st.mep.mepId, opts), r1 = await A.nd.execute(A.st.mep.mepId, { ...opts, silenceIds });
  check("the node's run with a silence set has another state_0 root, another digest and another execRoot", hex(r0.result.initStateRoot) !== hex(r1.result.initStateRoot) && hex(r0.result.execDigest) !== hex(r1.result.execDigest) && hex(r0.result.execRoot) !== hex(r1.result.execRoot));
  const run = { stimulusSeed: SEED, steps: STEPS, execDigest: r1.result.execDigest };
  check("re-execution reproduces it given the silence set, and not without it", Vf.reexecuteLif(await loadKernelFromBytes(wasm), payload, run, { stimulusIds, silenceIds }).matches && !Vf.reexecuteLif(await loadKernelFromBytes(wasm), payload, run, { stimulusIds }).matches);
  // an announcement that names the task's initStateRoot: a node that was not told the silence set refuses rather than sign another task's run
  const handlers = {}; const client = { serve: (type, id, fn) => { handlers[type] = fn; return () => {}; } }; const svc = new NodeService(A.nd, client, {}); svc.serve(A.st.mep.mepId); const id = hex(A.st.mep.mepId).slice(2);
  const announce = (extra) => handlers["task-announce"]({ mepId: Object.keys(handlers).length && [...A.nd.models.keys()][0], payload: { taskId: "0x" + "ab".repeat(32), steps: STEPS, commitStride: 10, stimulusSeed: SEED, stimulusIds: [...stimulusIds], initStateRoot: hex(r1.result.initStateRoot), ...extra } });
  const told = await announce({ silenceIds: [...silenceIds] }), untold = await announce({});
  check("told the silence set, the node signs the task's run", told?.type === "result" && told.payload.execDigest === hex(r1.result.execDigest));
  check("not told, it refuses instead of signing a run of some other task", untold?.type === "result-refused" && /initStateRoot/.test(untold.payload.reason));
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
