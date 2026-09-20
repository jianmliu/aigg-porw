// The event-driven path is the scatter path, bit for bit. What it skips are terms that are zero (the out-edges of a
// neuron that did not spike) and neurons that are fixed points (never reached, not stimulated: v = g = refr = count = 0
// under I = 0 stays that way). Integer sums are exact and order-independent, so every state, root and digest is equal.
// Checked here against the REAL connectome when one is to hand, and always on synthetic payloads:
//   node test_lif_events.mjs [flywire-783-min5.bin]
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js"; import { PorwNode } from "./node.js"; import { synthesizePayloadV2 } from "./synth.js";
import { createPool } from "./pool.js"; import * as V from "./verify.js"; import * as L from "./lif.js";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const node = async (opts = {}) => new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32), ...opts });
/** run with the event path armed or forced off (L.events = null makes _lifEventsArm keep it off) */
async function run(payload, opts, { events = true, steps = 60, stride = 10 } = {}) {
  const nd = await node(); const st = await nd.loadModel("m", payload, { maxSteps: steps, exec: "lif" });
  if (!events) st.slot.lif.events = null;
  const r = await nd.execute(st.mep.mepId, { steps, commitStride: stride, ...opts });
  return { nd, st, armed: !!st.slot.lif.events, digest: V.hex(r.result.execDigest), root: V.hex(r.result.execRoot), init: V.hex(r.result.initStateRoot), counts: r.result.counts, roots: r.result.actRoots.map(V.hex) };
}
const same = (a, b) => a.digest === b.digest && a.root === b.root && a.init === b.init && a.roots.join() === b.roots.join() && a.counts.every((c, i) => c === b.counts[i]);

// ---- synthetic: the canonical set, an explicit set, a silence set, several seeds, a stride that is not a divisor ----
{ const p = synthesizePayloadV2("events", 4000, 120000);
  const ids = Uint32Array.from({ length: 200 }, (_, j) => j * 7), sil = Uint32Array.from([3, 11, 12, 400, 1500]);
  for (const [name, opts] of [["canonical set", { stimulusSeed: 5 }], ["another seed", { stimulusSeed: 9 }], ["an explicit set", { stimulusSeed: 5, stimulusIds: ids }],
    ["a silence set", { stimulusSeed: 5, stimulusIds: ids, silenceIds: sil }], ["silence over the canonical set", { stimulusSeed: 9, silenceIds: sil }]]) {
    const a = await run(p, opts, { events: false }), b = await run(p, opts);
    check(`${name}: same digest, execRoot, initStateRoot, every segment root and every spike count`, a.armed === false && b.armed === true && same(a, b), `${a.digest.slice(0, 14)} vs ${b.digest.slice(0, 14)}`);
  }
  { const a = await run(p, { stimulusSeed: 5 }, { events: false, steps: 55, stride: 10 }), b = await run(p, { stimulusSeed: 5 }, { steps: 55, stride: 10 });
    check("a stride that does not divide the steps (the last segment is short)", same(a, b)); }
  { const a = await run(p, { stimulusSeed: 5 }, { events: false, steps: 1, stride: 1 }), b = await run(p, { stimulusSeed: 5 }, { steps: 1, stride: 1 });
    check("one step", same(a, b)); }
  { // a dispute's replay paths: state at a step, and the per-step roots inside a segment, both from a checkpoint
    const a = await run(p, { stimulusSeed: 5 }, { events: false }), b = await run(p, { stimulusSeed: 5 });
    const sa = await a.nd.lifStates(a.st.mep.mepId, 37), sb = await b.nd.lifStates(b.st.mep.mepId, 37);
    check("replayed state at step 37 is identical, byte for byte", Buffer.compare(Buffer.from(sa), Buffer.from(sb)) === 0);
    const ra = await a.nd.lifSegmentRoots(a.st.mep.mepId, 2), rb = await b.nd.lifSegmentRoots(b.st.mep.mepId, 2);
    check("and so is every per-step root of segment 2 (what a bisection walks)", ra.roots.map(V.hex).join() === rb.roots.map(V.hex).join());
    const oa = await a.nd.lifOpenState(a.st.mep.mepId, 37, 11), ob = await b.nd.lifOpenState(b.st.mep.mepId, 37, 11);
    check("and an opening of one neuron at one step, with its proof", V.hex(oa.state) === V.hex(ob.state) && oa.proof.map(V.hex).join() === ob.proof.map(V.hex).join()); }
  { // the pool path is the scatter path parallelised: the event path must equal it too
    const pool = await createPool({ wasmBytes: fs.readFileSync(new URL("./porw-shared.wasm", import.meta.url)), workers: 4, nodeWorkers: true });
    const nd = new PorwNode(pool.kernel, { privHex: "0x" + "11".repeat(32), pool }); const st = await nd.loadModel("m", p, { maxSteps: 60, exec: "lif" });
    st.slot.lif.events = null; const r = await nd.execute(st.mep.mepId, { steps: 60, commitStride: 10, stimulusSeed: 5 });
    const b = await run(p, { stimulusSeed: 5 });
    check("pool (4 workers, rows) == event-driven", V.hex(r.result.execDigest) === b.digest && V.hex(r.result.execRoot) === b.root); pool.close(); }
  { // a liar cannot hide in the event path: it diverges there exactly as it does in the scatter path. (The lie is a
    // small change to one v, so the SPIKE COUNTS are untouched and the digest is not what moves -- the state roots are,
    // which is what a task settles on and what a dispute bisects.)
    const honest = await run(p, { stimulusSeed: 5 });
    const lie = async (events) => { const nd = await node(); const st = await nd.loadModel("m", p, { maxSteps: 60, exec: "lif" }); if (!events) st.slot.lif.events = null;
      nd.execLie = { step: 7, neuron: 13, kind: "state", delta: 40 }; const r = await nd.execute(st.mep.mepId, { steps: 60, commitStride: 10, stimulusSeed: 5 });
      return { root: V.hex(r.result.execRoot), roots: r.result.actRoots.map(V.hex).join() }; };
    const dense = await lie(false), evented = await lie(true);
    check("a lie diverges from the honest run under the event path, in the roots a dispute bisects", evented.root !== honest.root && evented.roots !== honest.roots.join());
    check("and it diverges into exactly the same wrong roots as it does in the scatter path: no hiding place", evented.root === dense.root && evented.roots === dense.roots); }
}

// ---- the incremental commit: the tree an update leaves behind is the tree a full build would ----
{ const p = synthesizePayloadV2("commit", 4000, 120000); const ids = Uint32Array.from({ length: 200 }, (_, j) => j * 7);
  const a = await run(p, { stimulusSeed: 5, stimulusIds: ids }, { events: false }), b = await run(p, { stimulusSeed: 5, stimulusIds: ids });
  check("every segment root of an incrementally committed run equals the fully built one", a.roots.join() === b.roots.join() && a.init === b.init);
  // and the tree is not only right at the root: an opening from it verifies against that root
  const o = await b.nd.lifOpenState(b.st.mep.mepId, 30, 7), oa = await a.nd.lifOpenState(a.st.mep.mepId, 30, 7);
  check("and an opening taken from the updated tree matches the full build's, proof and all", V.hex(o.state) === V.hex(oa.state) && o.proof.map(V.hex).join() === oa.proof.map(V.hex).join()); }

// ---- the real connectome, if the payload is to hand ----
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  const p = new Uint8Array(fs.readFileSync(real)); const steps = 500, stride = 100;
  const ids = Uint32Array.from({ length: 359 }, (_, j) => j * 23), sil = Uint32Array.from([101, 202, 303, 40404]);
  const a = await run(p, { stimulusSeed: 7, stimulusIds: ids, silenceIds: sil }, { events: false, steps, stride });
  const t = Date.now(); const b = await run(p, { stimulusSeed: 7, stimulusIds: ids, silenceIds: sil }, { steps, stride });
  check(`${real.split("/").pop()}, ${steps} steps with a stimulus and a silence set: identical (${a.counts.reduce((x, y) => x + y, 0)} spikes)`, same(a, b), `${a.digest.slice(0, 18)} vs ${b.digest.slice(0, 18)}`);
  check("and the digest is the hash of those counts", V.hex(L.countsDigest(b.counts)) === b.digest);
  console.log(`  (the event path ran it in ${((Date.now() - t) / 1000).toFixed(1)}s)`);
} else console.log("  --   no real payload given; synthetic only");
console.log(fails ? `${fails} FAILURES` : "lif events: all checks passed"); process.exit(fails ? 1 : 0);
