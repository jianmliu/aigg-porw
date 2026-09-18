// Full-brain int-lif node run: per-step cost with commitments (state leaves + tree per step),
// single thread vs the shared-memory pool, plus "research mode" (no commitments) throughput.
//   node bench_lif_node.mjs <payload-v2.bin> [steps=100] [workers=4] [out.json]
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { createPool } from "./pool.js";
import { PorwNode } from "./node.js";
import { decodeHeader } from "./model.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
const [payloadPath, stepsArg, workersArg, out] = process.argv.slice(2); const steps = Number(stepsArg || 100), workers = Number(workersArg || 4);
const payload = new Uint8Array(fs.readFileSync(payloadPath)); const hdr = decodeHeader(payload);
const sketchWasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)), sharedWasm = fs.readFileSync(new URL("./porw-shared.wasm", import.meta.url));
const ch = new Uint8Array(32).fill(3); const res = { payload: payloadPath.split("/").pop(), neurons: hdr.neurons, synapses: hdr.synapses, steps, workers };
const run = async (nd, tag) => { let t0 = performance.now(); const st = await nd.loadModel(hdr.name, payload, { maxSteps: steps }); const loadMs = performance.now() - t0;
  t0 = performance.now(); const r = await nd.challenge(st.mep.mepId, ch, { steps, commitStride: 1, stimulusSeed: 7 }); const slotMs = performance.now() - t0;
  console.log(`${tag}: load ${loadMs.toFixed(0)} ms | slot ${slotMs.toFixed(0)} ms = sketch ${r.timings.sketchMs.toFixed(0)} + partials ${r.timings.commitMs.toFixed(0)} + infer ${r.timings.inferMs.toFixed(0)} + state-commit ${r.timings.disputeCommitMs.toFixed(0)} | ${(r.timings.inferMs / steps).toFixed(1)} ms/step infer, ${(r.timings.disputeCommitMs / (steps + 1)).toFixed(1)} ms/step commit | stimulated ${r.result.stimulated}`);
  return { st, r, loadMs, slotMs, timings: r.timings, modelId: V.hex(st.modelId), mepId: V.hex(st.mep.mepId), execDigest: V.hex(r.result.execDigest), execRoot: V.hex(r.result.execRoot), initStateRoot: V.hex(r.result.initStateRoot) }; };
const single = await run(new PorwNode(await loadKernelFromBytes(sketchWasm), { privHex: "0x" + "11".repeat(32) }), "single thread");
res.single = { loadMs: single.loadMs, slotMs: single.slotMs, timings: single.timings, modelId: single.modelId, mepId: single.mepId, execDigest: single.execDigest, execRoot: single.execRoot, initStateRoot: single.initStateRoot };
if (workers > 0) { const pool = await createPool({ wasmBytes: sharedWasm, workers, nodeWorkers: true, initialPages: 4096 });
  const pooled = await run(new PorwNode(pool.kernel, { privHex: "0x" + "11".repeat(32), pool }), `pool x${workers}`);
  res.pool = { loadMs: pooled.loadMs, slotMs: pooled.slotMs, timings: pooled.timings, identical: pooled.execDigest === single.execDigest && pooled.execRoot === single.execRoot };
  console.log(`pool == single: ${res.pool.identical}`); pool.close(); }
// research mode: no commitments, 1000 steps (100 ms of brain time), single thread
{ const k = await loadKernelFromBytes(sketchWasm); const t0 = performance.now(); const re = Vf.reexecuteLif(k, payload, { steps: 1000, stimulusSeed: 7, execDigest: new Uint8Array(32) }); const ms = performance.now() - t0;
  let tot = 0, act = 0; for (const x of re.counts) { tot += x; if (x) act++; }
  res.research = { steps: 1000, ms, msPerStep: ms / 1000, secondsPerBrainSecond: ms / 1000 * 10000 / 1000, spikes: tot, activeNeurons: act };
  console.log(`research mode (no commitments): 1000 steps in ${(ms / 1000).toFixed(1)} s = ${(ms / 1000).toFixed(1)} ms/step -> ${(res.research.secondsPerBrainSecond).toFixed(0)} s per second of brain time; ${tot} spikes, ${act} active neurons`); }
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
