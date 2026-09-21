// The number proposals/base-enrolment says decides it: can a host that holds only the BASE and a recipe produce a
// derived brain's residency sketch about as fast as a host holding the derived payload can sketch it?
//
//   node bench_derive_sketch.mjs <base.bin> <recipe.delta>
//
// Three costs, on the same bytes:
//   resident   sketch every tile of a materialized payload                      (what a claim costs today)
//   derive     porw_sample_records over every record, in WASM                   (the inner loop of a tile-local derivation)
//   js         applyProcedural in delta.js                                      (what an in-place individual runs TODAY,
//                                                                                because the WASM path refuses layout 1)
import fs from "node:fs";
import { loadKernelFromBytes, attachTrees } from "./porw.js";
import { decodeHeader } from "./model.js";
import { modelIdOf, decodeDelta3, decodeDelta2, isDelta3, applyProcedural } from "./delta.js";
import { uploadDeltaBase } from "./delta_wasm.js";

const [basePath, deltaPath] = process.argv.slice(2);
if (!basePath || !deltaPath) { console.log("usage: bench_derive_sketch.mjs <base.bin> <recipe.delta>"); process.exit(2); }
const base = new Uint8Array(fs.readFileSync(basePath)), delta = new Uint8Array(fs.readFileSync(deltaPath));
const hdr = decodeHeader(base), mid = modelIdOf(base);
const d = isDelta3(delta) ? decodeDelta3(delta) : decodeDelta2(delta);
const tiles = Math.floor(base.length / 4096);
console.log(`base   ${base.length.toLocaleString("en-US")} bytes, ${hdr.neurons.toLocaleString("en-US")} neurons, ${hdr.synapses.toLocaleString("en-US")} records, ${tiles.toLocaleString("en-US")} tiles`);
console.log(`recipe ${delta.length} bytes, seed ${d.seed}, layout ${d.layout ?? "-"}, mean ratio ${(d.meanRatioQ16 / 65536).toFixed(2)}, ${d.rTable.length} dispersion rows\n`);

const k = attachTrees(await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url))));
const e = k.exports, handle = uploadDeltaBase(k, base, { baseModelId: mid });
const rec = handle.ptr + hdr.synOffset, n = hdr.synapses;
const ms = (f, reps = 3) => { let best = Infinity; for (let i = 0; i < reps; i++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); } return best; };

// 1. resident: sketch every tile of the payload the node is holding
const sketches = k.alloc(tiles * 4), seed = 0x5eed5eed;
const tResident = ms(() => k.sketch(handle.ptr, tiles, 0, seed, sketches));

// 2. derive: the sampler over every record. Layout-independent -- it produces the counts, and an in-place writeback
//    puts each one back at the offset it came from. This is the inner loop a tile-local sketch would call per tile.
const rows = k.alloc(d.rTable.length * 8); k.u32(rows, d.rTable.length * 2).set(d.rTable.flat());
const counts = k.alloc(n * 4);
const tDerive = ms(() => { const rc = e.porw_sample_records(rec, n, Number(d.seed & 0xffffffffn), Number(d.seed >> 32n), d.meanRatioQ16, rows, d.rTable.length, counts); if (rc < 0) throw new Error("sampling failed " + rc); });

// 3. what an in-place individual costs today: the JS path, because the WASM path refuses layout 1
let tJs = null;
try { tJs = ms(() => applyProcedural(base, delta, { baseModelId: mid }), 1); } catch (err) { tJs = String(err.message).slice(0, 60); }

// the FULL claim a host posts: sketch + commit the sketches + sign, which is what 0.11 s was measured as via
// PorwNode.residency. Comparing a derivation against the raw sketch alone would flatter the derivation's factor.
const { PorwNode } = await import("./node.js");
const nd = new PorwNode(k, { privHex: "0x" + "77".repeat(32) });
const st = await nd.loadModel("bench", base, { maxSteps: 2, exec: "lif", wUnitQ16: 7209 });
const tClaim = ms(() => {}, 1) && await (async () => { let best = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); await nd.residency(st.mep.mepId, new Uint8Array(32).fill(9)); best = Math.min(best, performance.now() - t); } return best; })();
const f = (x) => typeof x === "number" ? `${(x / 1000).toFixed(2)} s` : x;
console.log(`resident sketch of every tile        ${f(tResident)}      <- what a residency claim costs today`);
console.log(`derive every record (WASM sampler)   ${f(tDerive)}`);
console.log(`full residency claim, resident      ${f(tClaim)}      <- sketch + commit + sign (PorwNode.residency)`);
console.log(`  derived on demand: derive + claim  ${f(tDerive + tClaim)}   = ${((tDerive + tClaim) / tClaim).toFixed(1)}x the resident claim`);
console.log(`derive in JS (applyProcedural)       ${f(tJs)}   <- TODAY's path for layout 1\n`);
if (typeof tDerive === "number") {
  const per = (tDerive + tClaim) / 1000, epoch = 200 * 3;
  console.log(`a host serving N derived brains pays N x ${per.toFixed(2)} s per epoch to claim them all`);
console.log(`(holding them instead is 455 MB each -- N = 100 is 45 GB, which is why this is the comparison that matters):`);
  for (const N of [1, 10, 100, 1000]) { const s = N * per; console.log(`  ${String(N).padStart(4)} brains  ${s < 90 ? s.toFixed(0) + " s" : (s / 60).toFixed(1) + " min"}${s > epoch ? `   <- more than an epoch (${epoch} s)` : ""}`); }
}
