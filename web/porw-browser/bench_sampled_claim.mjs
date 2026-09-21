// What a claim over a challenge-selected SUBSET of tiles costs, separating the work from the call overhead --
// the first version of this measured the latter and reported it as the former.
//   node bench_sampled_claim.mjs <base.bin> <recipe.delta>
import fs from "node:fs";
import { loadKernelFromBytes, attachTrees } from "./porw.js";
import { decodeHeader } from "./model.js";
import { modelIdOf, decodeDelta3, isDelta3, decodeDelta2 } from "./delta.js";
import { uploadDeltaBase } from "./delta_wasm.js";
const [basePath, deltaPath] = process.argv.slice(2);
const base = new Uint8Array(fs.readFileSync(basePath)), delta = new Uint8Array(fs.readFileSync(deltaPath));
const hdr = decodeHeader(base), mid = modelIdOf(base), d = isDelta3(delta) ? decodeDelta3(delta) : decodeDelta2(delta);
const k = attachTrees(await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url))));
const e = k.exports, handle = uploadDeltaBase(k, base, { baseModelId: mid });
const TILE = 4096, REC = 10, tiles = Math.floor(base.length / TILE), n = hdr.synapses;
const rows = k.alloc(d.rTable.length * 8); k.u32(rows, d.rTable.length * 2).set(d.rTable.flat());
const out = k.alloc(n * 4), sk = k.alloc(tiles * 4);
const seedLo = Number(d.seed & 0xffffffffn), seedHi = Number(d.seed >> 32n);
const perTile = Math.ceil(TILE / REC) + 1;
const ms = (f, reps = 5) => { let b = Infinity; for (let i = 0; i < reps; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };
const sample = (from, cnt) => e.porw_sample_records(handle.ptr + hdr.synOffset + from * REC, cnt, seedLo, seedHi, d.meanRatioQ16, rows, d.rTable.length, out + from * 4);

const bulk = ms(() => sample(0, n), 3);
const perRec = bulk * 1e6 / n;                                        // ns per record
// the call overhead: the same total records, in c calls
console.log(`bulk: ${n.toLocaleString("en-US")} records in one call = ${bulk.toFixed(0)} ms (${perRec.toFixed(0)} ns/record)\n`);
console.log(`  calls    records/call    total ms    of which overhead    ns per call`);
for (const c of [1, 64, 1024, 37639]) {
  const each = Math.floor(n / c);
  const t = ms(() => { for (let i = 0; i < c; i++) sample(i * each, each); }, 3);
  const ov = t - bulk;
  console.log(`  ${String(c).padStart(6)}   ${String(each).padStart(12)}   ${t.toFixed(0).padStart(9)}   ${ov.toFixed(0).padStart(17)}   ${(ov * 1e6 / c).toFixed(0).padStart(11)}`);
}
console.log(`\nso a sampled claim, done right (one call per contiguous run, or one call over the sorted sample):`);
console.log(`  k tiles   fraction   derive work   sketch    100 brains per epoch   a host with p of it passes`);
for (const kk of [64, 256, 1024, 4096, tiles]) {
  const recs = kk * perTile, dw = recs * perRec / 1e6;
  const idx = Array.from({ length: Math.min(kk, 4096) }, (_, i) => (i * 7919 + 13) % tiles);
  const ts = ms(() => { for (const t of idx) k.sketch(handle.ptr + t * TILE, 1, 0, 0x5eed5eed, sk + t * 4); }) * (kk / idx.length);
  const tot = dw + ts, p100 = 100 * tot / 1000;
  console.log(`  ${String(kk).padStart(6)}   ${(kk / tiles * 100).toFixed(1).padStart(6)}%   ${dw.toFixed(0).padStart(9)} ms ${ts.toFixed(1).padStart(8)} ms ${(p100 < 90 ? p100.toFixed(1) + " s" : (p100 / 60).toFixed(1) + " min").padStart(20)}   p=0.99: ${Math.pow(0.99, kk).toExponential(1)}`);
}
