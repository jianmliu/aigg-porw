// The weight unit is a parameter of the int-lif KIND, per connectome: same rule, same KIND_ID, another digest.
//   node test_lif_wunit.mjs [--vectors]
// 0.275 mV per synapse (18022 in Q16) was set on FlyWire's counts. MaleCNS reports about 1.6x as many synapses for the
// same connection, and under FlyWire's unit every stimulus ignites it; its MEP pins a smaller unit. Checked here: the
// default is untouched (passing nothing, 0, or 18022 are one run), another unit is another run and another kind, and
// the kernel, lif.js and int_lif.py agree on it state by state. contracts/evm/test/LifWeightUnit.t.sol pins the same
// digest and transition literals from the Solidity side.
import fs from "node:fs"; import { execFileSync } from "node:child_process"; import os from "node:os"; import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import * as L from "./lif.js";
import * as Vf from "./verifier.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const N = 3000, SYN = 90000, STEPS = 60, SEED = 5, WU = 9011; const payload = synthesizePayloadV2("lif-wunit", N, SYN); const hdr = decodeHeader(payload);
const stimulusIds = Uint32Array.from({ length: 300 }, (_, j) => j * 7);
async function wasmRun(...unit) { // `unit` is passed as the kernel's last argument, or not at all
  const k = await loadKernelFromBytes(wasm), e = k.exports; const buf = k.put(payload); let cur = k.alloc(N * 16), nxt = k.alloc(N * 16); const acc = k.alloc(N * 8);
  const p = k.alloc(stimulusIds.length * 4); k.u32(p, stimulusIds.length).set(stimulusIds); if (e.porw_lif_state0_set(cur, N, p, stimulusIds.length) !== 0) throw new Error("state0");
  const states = [new Uint8Array(k.u8(cur, N * 16))];
  for (let s = 1; s <= STEPS; s++) { if (e.porw_lif_step(buf + hdr.synOffset, hdr.synapses, cur, nxt, acc, N, s, SEED, ...unit) !== 0) throw new Error("step"); [cur, nxt] = [nxt, cur]; states.push(new Uint8Array(k.u8(cur, N * 16))); }
  return states;
}
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const dflt = await wasmRun(), zero = await wasmRun(0), named = await wasmRun(L.LIF.wUnitQ16), half = await wasmRun(WU);
check("passing nothing, 0, or the default unit is one and the same run: no existing caller changes", same(dflt.at(-1), zero.at(-1)) && same(dflt.at(-1), named.at(-1)));
check(`another unit (${WU}) is another run`, !same(dflt.at(-1), half.at(-1)));
const spikes = (st) => { let t = 0; for (let i = 0; i < N; i++) t += L.decodeState(st, i * 16).count; return t; };
check(`and a smaller unit drives the network less: ${spikes(half.at(-1))} spikes against ${spikes(dflt.at(-1))}`, spikes(half.at(-1)) < spikes(dflt.at(-1)));

// ---- lif.js transition() over the records, under the other unit ----
{ const dv = new DataView(payload.buffer, payload.byteOffset + hdr.synOffset, hdr.synapses * 10); let ok = true, vec = null;
  for (let s = 1; s <= STEPS && ok; s++) { const prev = half[s - 1], I = new Array(N).fill(0n);
    for (let r = 0; r < hdr.synapses; r++) { const pre = dv.getUint32(r * 10, true), post = dv.getUint32(r * 10 + 4, true); if (L.decodeState(prev, pre * 16).flags & 2) I[post] += BigInt(dv.getInt16(r * 10 + 8, true)); }
    for (let i = 0; i < N; i++) { const S0 = L.decodeState(prev, i * 16), got = L.transition(S0, I[i], i, s, SEED, WU), want = L.decodeState(half[s], i * 16);
      if (!L.sameState(got, want)) { ok = false; console.log("   mismatch step", s, "neuron", i); break; }
      if (!vec && I[i] !== 0n && !(S0.flags & 1) && S0.refr === 0 && !L.sameState(got, L.transition(S0, I[i], i, s, SEED))) vec = { i, step: s, I: I[i], before: S0, after: want, dflt: L.transition(S0, I[i], i, s, SEED), leaf: hex(L.stateLeaf(i, want)) }; } }
  check(`lif.js transition(..., ${WU}) == the kernel for all ${N} neurons over ${STEPS} steps`, ok); check("a vector where the unit decides the state", !!vec);
  if (process.argv.includes("--vectors") && vec) console.log(`   VEC wu=${WU} i=${vec.i} step=${vec.step} seed=${SEED} I=${vec.I} before=(${vec.before.v},${vec.before.g},${vec.before.refr},${vec.before.flags},${vec.before.count}) after=(${vec.after.v},${vec.after.g},${vec.after.refr},${vec.after.flags},${vec.after.count}) default=(${vec.dflt.v},${vec.dflt.g}) leaf=${vec.leaf}`); }

// ---- int_lif.py ----
{ let py = null; for (const c of [process.env.PYTHON, "python3"]) { if (!c) continue; try { execFileSync(c, ["-c", "import numpy"], { stdio: "ignore" }); py = c; break; } catch {} }
  if (!py) console.log("  (skip) no python3 with numpy: int_lif.py not cross-checked");
  else { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lif-wunit-")); const f = path.join(dir, "p.bin"); fs.writeFileSync(f, payload);
    const code = `import sys, json, hashlib; sys.path.insert(0, ${JSON.stringify(path.dirname(new URL(import.meta.url).pathname))}); import int_lif as L
traj = L.run(open(${JSON.stringify(f)}, 'rb').read(), ${SEED}, ${STEPS}, stim_ids=${JSON.stringify([...stimulusIds])}, w_unit=${WU})
print(json.dumps([hashlib.sha256(S.leaf_bytes()).hexdigest() for S in traj]))`;
    const got = JSON.parse(execFileSync(py, ["-c", code], { maxBuffer: 1 << 26 }).toString());
    const pre = (st) => { const d = new DataView(st.buffer, st.byteOffset); const out = new Uint8Array(N * 20); const o = new DataView(out.buffer); for (let i = 0; i < N; i++) { o.setUint32(i * 20, i, true); o.setUint32(i * 20 + 4, d.getUint32(i * 16, true), true); o.setUint32(i * 20 + 8, d.getUint32(i * 16 + 4, true), true); o.setUint32(i * 20 + 12, d.getUint16(i * 16 + 8, true) | (d.getUint16(i * 16 + 10, true) << 16), true); o.setUint32(i * 20 + 16, d.getUint32(i * 16 + 12, true), true); } return Array.from(sha256(out), (x) => x.toString(16).padStart(2, "0")).join(""); };
    check(`int_lif.py(w_unit=${WU}) == the kernel, state by state (${got.length} states)`, got.length === STEPS + 1 && got.every((h, s) => h === pre(half[s]))); fs.rmSync(dir, { recursive: true }); } }

// ---- the kind, the MEP and the node ----
const KIND = { dflt: hex(L.lifExecKind()), other: hex(L.lifExecKind(WU)) };
if (process.argv.includes("--vectors")) console.log("   KIND", JSON.stringify(KIND));
const want = JSON.parse(fs.readFileSync(new URL("./lif_wunit_vectors.json", import.meta.url)));
check("the two kind digests are the contract's (LifRowCheck.execKind)", KIND.dflt === want.kind_default && KIND.other === want.kind_9011 && KIND.dflt !== KIND.other);
{ const mk = async (opts) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) }); const st = await nd.loadModel("lif-wunit", payload, { maxSteps: STEPS, exec: "lif", ...opts }); return { nd, st }; };
  const A = await mk({}), Bn = await mk({ wUnitQ16: WU }); const run = { steps: STEPS, commitStride: 10, stimulusSeed: SEED, stimulusIds };
  check("the same bytes under another unit are another kind, hence another MEP", hex(Bn.st.mep.execKind) === KIND.other && hex(A.st.mep.execKind) === KIND.dflt && hex(A.st.mep.mepId) !== hex(Bn.st.mep.mepId) && hex(A.st.mep.modelId) === hex(Bn.st.mep.modelId));
  const ra = await A.nd.execute(A.st.mep.mepId, run), rb = await Bn.nd.execute(Bn.st.mep.mepId, run);
  check("the node runs each model under its kind's unit", hex(ra.result.execRoot) !== hex(rb.result.execRoot) && hex(ra.result.initStateRoot) === hex(rb.result.initStateRoot));
  const k2 = await loadKernelFromBytes(wasm), k3 = await loadKernelFromBytes(wasm); const r = { stimulusSeed: SEED, steps: STEPS, execDigest: rb.result.execDigest };
  check("re-execution reproduces it given the unit, and not under the default", Vf.reexecuteLif(k2, payload, r, { stimulusIds, wUnitQ16: WU }).matches && !Vf.reexecuteLif(k3, payload, r, { stimulusIds }).matches); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
