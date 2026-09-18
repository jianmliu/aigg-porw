// How much wasm memory one hosted brain costs a tab, and therefore how many a tab can hold.
//
// Under scheme sketch-tile-keccak:v2 a residency claim is 34 ms, so CPU stopped being what
// limits `h`, the number of brains one tab hosts. This measures what does. The kernel is a bump
// allocator (`porw_alloc`), so `porw_heap_mark()` is an exact high-water mark: the delta across
// `loadModel` is precisely what that brain costs, with no page rounding and no GC noise.
//
//   node bench_memory.mjs [--neurons 139255] [--synapses 2700513] [--max-steps 100] [--exec lif]
//                         [--brains 3] [--json out.json]
//
// Defaults are the real FlyWire v783 min-5 export's shape. The payload is synthesized rather than
// downloaded: every allocation here is sized by (neurons, synapses, tiles, maxSteps), never by the
// weight values, so a synthetic brain of the same shape costs exactly what the real one costs.
import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload, synthesizePayloadV2 } from "./synth.js";
import * as M from "./mem.js";

const a = Object.fromEntries(process.argv.slice(2).reduce((o, v, i, r) => { if (v.startsWith("--")) o.push([v.slice(2), r[i + 1]]); return o; }, []));
const NEURONS = Number(a.neurons || 139255), SYNAPSES = Number(a.synapses || 2700513);
const MAX_STEPS = Number(a["max-steps"] || 100), EXEC = a.exec || "lif", BRAINS = Number(a.brains || 3);
const MB = (b) => b / 1024 / 1024;
const f = (b) => `${MB(b).toFixed(1)} MB`;

const parts_ = (nTiles, n, ns, maxSteps, exec) => M.modelMemoryParts({ nTiles, neurons: n, synapses: ns, maxSteps, exec });
const model = parts_;

const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const k = node.k;

console.log(`shape: ${NEURONS.toLocaleString()} neurons, ${SYNAPSES.toLocaleString()} synapse records, exec ${EXEC}, maxSteps ${MAX_STEPS}`);
const rows = [];
let nTiles = 0;
for (let i = 0; i < BRAINS; i++) {
  const name = `bench-${i}`;
  const payload = EXEC === "lif" ? synthesizePayloadV2(name, NEURONS, SYNAPSES) : synthesizePayload(name, NEURONS, SYNAPSES);
  nTiles = Math.floor(payload.length / TILE_BYTES);
  const before = k.mark(), t0 = performance.now();
  const st = await node.loadModel(name, payload, { maxSteps: MAX_STEPS, exec: EXEC });
  const used = k.mark() - before, ms = performance.now() - t0;
  rows.push({ brain: i, bytes: used, ms, wasmBuffer: k.memory.buffer.byteLength });
  console.log(`  brain ${i}: ${f(used)} resident (${(ms / 1000).toFixed(1)} s to load), wasm memory now ${f(k.memory.buffer.byteLength)}`);
  st.nTiles; // keep it hosted: this is the cost of HOSTING, not of a transient
}
const per = rows.reduce((s, r) => s + r.bytes, 0) / rows.length;

const parts = model(nTiles, NEURONS, SYNAPSES, MAX_STEPS, EXEC);
const predicted = parts.reduce((s, p) => s + p.bytes, 0);
console.log(`\nbreakdown (predicted from the allocation sites; total checked against the measurement):`);
for (const p of parts.sort((x, y) => y.bytes - x.bytes)) console.log(`  ${f(p.bytes).padStart(9)}  ${(100 * p.bytes / predicted).toFixed(1).padStart(5)}%  ${p.what}  [${p.scales}]`);
const drift = Math.abs(per - predicted) / predicted;
console.log(`  ${f(predicted).padStart(9)}  total predicted; measured ${f(per)} per brain (drift ${(100 * drift).toFixed(2)}%, 16-byte alignment per alloc)`);
if (drift > 0.01) { console.log("MISMATCH: the model above no longer matches loadModel"); process.exit(1); }

console.log(`\nbrains a tab can host at this shape:`);
for (const budget of [512, 1024, 2048, 4096]) console.log(`  ${String(budget).padStart(4)} MB of wasm memory -> h = ${Math.floor(budget * 1024 * 1024 / per)}`);

// The capacity a tab is asked for is `maxSteps`, and for int-lif it buys a checkpoint every 32 steps,
// so it is the one knob that moves this number. Computed from the model validated above.
console.log(`\nwhat maxSteps costs (same brain; the model above, validated to ${(100 * drift).toFixed(2)}%):`);
const sweep = [1, 100, 500, 1000, 2000, 5000].filter((x) => x <= 262144);
for (const ms of sweep) {
  const b = model(nTiles, NEURONS, SYNAPSES, ms, EXEC).reduce((s, p) => s + p.bytes, 0);
  console.log(`  maxSteps ${String(ms).padStart(6)} -> ${f(b).padStart(9)} per brain, h = ${String(Math.floor(1024 * 1024 * 1024 / b)).padStart(3)} at 1 GB`);
}
const at = (ms) => model(nTiles, NEURONS, SYNAPSES, ms, EXEC).reduce((s, p) => s + p.bytes, 0);
const CONTRACT_MAX = EXEC === "lif" ? 512 * 512 : 512; // TaskMarket.MAX_ROOTS: segments x stride, or steps
console.log(`  TaskMarket's limit for ${EXEC} is maxSteps ${CONTRACT_MAX} -> ${f(at(CONTRACT_MAX))} per brain,`);
console.log(`  i.e. ${at(CONTRACT_MAX) > 4 * 2 ** 30 ? "past wasm32's 4 GB ceiling: the load cannot succeed at all" : "within wasm32's 4 GB ceiling"}.`);
console.log(`  The dispute-round bound and the memory bound are not the same bound, and memory binds first.`);
if (a.json) fs.writeFileSync(a.json, JSON.stringify({ neurons: NEURONS, synapses: SYNAPSES, maxSteps: MAX_STEPS, exec: EXEC, nTiles, perBrainBytes: per, parts, rows }, null, 1));
