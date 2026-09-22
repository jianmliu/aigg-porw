// Can a host that holds only a BASE and a recipe make a derived brain's residency claim about as cheaply as a host
// that holds the derived payload? This is the measurement behind #36; its enrolment decisions shipped in #37 and #38,
// and base-resident family hosting lives in family_service.js.
//
//   node bench_derive_sketch.mjs [base.bin recipe.delta]      (no arguments: a synthetic brain and in-place founder)
//
// Measured on the same bytes:
//   sketch   the raw tile sketch of a resident payload         -- one part of a claim, not the whole of it
//   claim    a full residency claim: sketch + commit + sign     (PorwNode.residency)
//   derive   porw_sample_records over every record, in WASM    -- what a claim made from base+recipe has to add
//   js       applyDelta in delta.js                            -- what family_service.js runs for a derived brain
//                                                                today, because applyDeltaWasm refuses layout 1
//
// On malecns-v1.0-min2 with fly #101's 223-byte recipe: claim 0.05 s; derive 0.80-1.03 s, i.e. 18-24x the claim (the
// spread is machine load across runs); js 4.3-6.2 s; one resident brain keeps 275 MB of kernel heap.
// The derivation touches every record and a claim sketches every tile, so no implementation brings the factor near 1;
// what matters is whether it fits an epoch, and what it replaces -- holding one resident payload per brain.
import fs from "node:fs";
import { loadKernelFromBytes, attachTrees } from "./porw.js";
import { decodeHeader } from "./model.js";
import { modelIdOf, decodeDelta3, decodeDelta2, isDelta3, applyDelta, encodeDelta3, fitName, baseNameLength } from "./delta.js";
import { uploadDeltaBase } from "./delta_wasm.js";
import { synthesizePayloadV2 } from "./synth.js";
import { PorwNode } from "./node.js";

const [basePath, deltaPath] = process.argv.slice(2);
if (!!basePath !== !!deltaPath) { console.log("usage: bench_derive_sketch.mjs [base.bin recipe.delta]"); process.exit(2); }
let base, delta;
if (basePath) { base = new Uint8Array(fs.readFileSync(basePath)); delta = new Uint8Array(fs.readFileSync(deltaPath)); }
else {   // a synthetic base and an in-place founder on it: the same code paths, at a size that runs in seconds
  base = synthesizePayloadV2("bench-derive-base", 20000, 400000);
  const zero = new Uint8Array(32);
  delta = encodeDelta3({ baseModelId: modelIdOf(base), neurons: decodeHeader(base).neurons, parentA: zero, parentB: zero, seed: 1000n,
    name: fitName("bench-founder", baseNameLength(base)), layout: 1, meanRatioQ16: 60948 });
}
const hdr = decodeHeader(base), mid = modelIdOf(base);
const d = isDelta3(delta) ? decodeDelta3(delta) : decodeDelta2(delta);
const tiles = Math.floor(base.length / 4096);
console.log(`base   ${base.length.toLocaleString("en-US")} bytes, ${hdr.neurons.toLocaleString("en-US")} neurons, ${hdr.synapses.toLocaleString("en-US")} records, ${tiles.toLocaleString("en-US")} tiles${basePath ? "" : "  (synthetic)"}`);
console.log(`recipe ${delta.length} bytes, seed ${d.seed}, layout ${d.layout ?? "-"}, mean ratio ${(d.meanRatioQ16 / 65536).toFixed(2)}, ${d.rTable.length} dispersion rows\n`);

const k = attachTrees(await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url))));
const e = k.exports, handle = uploadDeltaBase(k, base, { baseModelId: mid });
const rec = handle.ptr + hdr.synOffset, n = hdr.synapses;
const best = (f, reps = 3) => { let b = Infinity; for (let i = 0; i < reps; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };
const bestAsync = async (f, reps = 3) => { let b = Infinity; for (let i = 0; i < reps; i++) { const t = performance.now(); await f(); b = Math.min(b, performance.now() - t); } return b; };

// sketch: every tile of the payload a node is holding
const sketches = k.alloc(tiles * 4);
const tSketch = best(() => k.sketch(handle.ptr, tiles, 0, 0x5eed5eed, sketches));

// derive: the sampler over every record. Layout-independent -- it yields the counts, and an in-place writeback puts
// each one back at the offset it came from. It is what a claim made from base+recipe has to add to the claim.
const rows = k.alloc(d.rTable.length * 8); k.u32(rows, d.rTable.length * 2).set(d.rTable.flat());
const counts = k.alloc(n * 4);
const tDerive = best(() => { const rc = e.porw_sample_records(rec, n, Number(d.seed & 0xffffffffn), Number(d.seed >> 32n), d.meanRatioQ16, rows, d.rTable.length, counts); if (rc < 0) throw new Error("sampling failed " + rc); });

// js: the path family_service.js takes for a derived brain today (applyDeltaWasm refuses layout 1)
let tJs; try { tJs = best(() => applyDelta(base, delta, { baseModelId: mid }), 1); } catch (err) { tJs = String(err.message).slice(0, 60); }

// claim: what a host actually posts. The weight unit changes the MEP id, not the claim's cost, so the default kind is used.
const nd = new PorwNode(k, { privHex: "0x" + "77".repeat(32) });
// what one resident brain keeps: the kernel heap it holds after loading (process RSS would move with the JS garbage
// collector -- the JS derivation just above allocates a whole payload -- and the first version of this reported a negative)
const heap0 = k.mark();
const st = await nd.loadModel("bench", base, { maxSteps: 2, exec: "lif" });
const resident = k.mark() - heap0;
const tClaim = await bestAsync(() => nd.residency(st.mep.mepId, new Uint8Array(32).fill(9)));

const f = (x) => typeof x === "number" ? `${(x / 1000).toFixed(2)} s` : x;
console.log(`sketch every tile (raw)              ${f(tSketch)}      <- one part of a claim`);
console.log(`full residency claim, resident       ${f(tClaim)}      <- sketch + commit + sign (PorwNode.residency)`);
console.log(`derive every record (WASM sampler)   ${f(tDerive)}`);
console.log(`  derived on demand: derive + claim  ${f(tDerive + tClaim)}   = ${((tDerive + tClaim) / tClaim).toFixed(1)}x the resident claim`);
console.log(`derive in JS (applyDelta)            ${f(tJs)}   <- what family_service.js runs for a derived brain\n`);
const per = (tDerive + tClaim) / 1000, epoch = 200 * 3;
console.log(`a host serving N derived brains, claiming each from base+recipe every epoch (an epoch of 200 blocks at 3 s);`);
console.log(`holding them resident instead keeps ${(resident / 2 ** 20).toFixed(0)} MB of kernel heap each (resident payload, trees, state):`);
for (const N of [1, 10, 100, 1000]) { const s = N * per; console.log(`  ${String(N).padStart(4)} brains  ${(s < 90 ? s.toFixed(1) + " s" : (s / 60).toFixed(1) + " min").padStart(9)}   vs ${(N * resident / 2 ** 30).toFixed(1).padStart(6)} GB${s > epoch ? `   <- more than an epoch` : ""}`); }
