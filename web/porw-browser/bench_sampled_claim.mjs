// What would a residency claim over a challenge-selected SUBSET of tiles cost, for a host that derives tiles from a
// base and a recipe instead of holding the derived payload? The follow-on measurement to bench_derive_sketch.mjs, behind
// #36; sampled claims were not taken up by #37/#38, and this is what it would take if they were.
//
//   node bench_sampled_claim.mjs [base.bin recipe.delta]      (no arguments: a synthetic brain and in-place founder)
//
// Three findings, each measured here rather than assumed:
//   1. porw_sample_records has a large per-CALL cost. Each call initialises a 32,769-entry index and builds, from
//      scratch, the distribution table of every distinct synapse count present in that call (sample_wasm.c). So the
//      cost of a call depends on how many distinct counts it contains -- on the male base about 1.7 ms for a tile-sized
//      call and 10-30 ms for a large one -- and deriving a sample one tile per call is dominated by it. The first
//      version of this benchmark did exactly that and reported the overhead as if it were the work.
//   2. A record's draw is a function of its (pre, post) and the seed, not of where it sits, so the records of scattered
//      tiles can be GATHERED into one contiguous buffer and sampled in one call. This file checks that the gathered
//      counts equal the bulk counts for the same records before it times anything with it.
//   3. Timed that way, the derivation for a claim over k tiles is measured, not extrapolated. On the male base,
//      k = 1024 (2.7% of tiles) takes 70-85 ms -- 7-8 s per epoch for 100 brains. The figure #36 gave, 26 ms, was
//      extrapolated from the bulk per-record rate and was about 3x optimistic: it left out the one table build.
// The tables depend only on the count, the dispersion table and the mean ratio -- not on the seed or the records -- so
// every brain of a population could share them; the WASM API does not, and nothing here assumes it does.
// Timings move with machine load; take the minimum of several runs.
// What is not timed: writing the counts back into tile bytes (k x ~410 two-byte stores). The sketch column times the
// same number of BASE tiles, which is the same number of bytes as the derived ones.
import fs from "node:fs";
import { loadKernelFromBytes, attachTrees } from "./porw.js";
import { decodeHeader } from "./model.js";
import { modelIdOf, decodeDelta3, isDelta3, decodeDelta2, encodeDelta3, fitName, baseNameLength } from "./delta.js";
import { uploadDeltaBase } from "./delta_wasm.js";
import { synthesizePayloadV2 } from "./synth.js";

const [basePath, deltaPath] = process.argv.slice(2);
if (!!basePath !== !!deltaPath) { console.log("usage: bench_sampled_claim.mjs [base.bin recipe.delta]"); process.exit(2); }
let base, delta;
if (basePath) { base = new Uint8Array(fs.readFileSync(basePath)); delta = new Uint8Array(fs.readFileSync(deltaPath)); }
else {
  base = synthesizePayloadV2("bench-sampled-base", 20000, 400000);
  const zero = new Uint8Array(32);
  delta = encodeDelta3({ baseModelId: modelIdOf(base), neurons: decodeHeader(base).neurons, parentA: zero, parentB: zero, seed: 1000n,
    name: fitName("bench-founder", baseNameLength(base)), layout: 1, meanRatioQ16: 60948 });
}
const hdr = decodeHeader(base), mid = modelIdOf(base), d = isDelta3(delta) ? decodeDelta3(delta) : decodeDelta2(delta);
const k = attachTrees(await loadKernelFromBytes(fs.readFileSync(new URL("./sketch.wasm", import.meta.url))));
const e = k.exports, handle = uploadDeltaBase(k, base, { baseModelId: mid });
const TILE = 4096, REC = 10, tiles = Math.floor(base.length / TILE), n = hdr.synapses, perTile = Math.ceil(TILE / REC) + 1;
const recBase = handle.ptr + hdr.synOffset;
const rows = k.alloc(d.rTable.length * 8); k.u32(rows, d.rTable.length * 2).set(d.rTable.flat());
const bulkOut = k.alloc(n * 4), sk = k.alloc(tiles * 4);
const seedLo = Number(d.seed & 0xffffffffn), seedHi = Number(d.seed >> 32n);
const best = (f, reps = 3) => { let b = Infinity; for (let i = 0; i < reps; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };
const sample = (ptr, cnt, out) => { const rc = e.porw_sample_records(ptr, cnt, seedLo, seedHi, d.meanRatioQ16, rows, d.rTable.length, out); if (rc < 0) throw new Error("sampling failed " + rc); };
console.log(`base ${base.length.toLocaleString("en-US")} bytes, ${n.toLocaleString("en-US")} records, ${tiles.toLocaleString("en-US")} tiles${basePath ? "" : "  (synthetic)"}\n`);

// the records a tile touches: the contiguous range under it, plus the straddler on each side (a 10-byte record can
// cross a 4 KiB edge). Tiles before the synapse table (header, neuron table) touch no records.
const rangeOf = (t) => { const first = Math.max(0, Math.floor((t * TILE - hdr.synOffset) / REC) - 1); return [first, Math.max(0, Math.min(perTile, n - first))]; };

// 1. the bulk rate, and the per-call cost
// the same records split into c calls; the one-call row is the baseline the others are measured against
const inCalls = (c, reps = 3) => { const each = Math.floor(n / c); return best(() => { for (let i = 0; i < c; i++) sample(recBase + i * each * REC, each, bulkOut + i * each * 4); }, reps); };
const bulk = inCalls(1, 5), perRec = bulk * 1e6 / n;
console.log(`one call over every record: ${bulk.toFixed(0)} ms (${perRec.toFixed(0)} ns/record)`);
console.log(`  calls    records/call    total ms    of which per-call cost    per call`);
for (const c of [1, 64, 1024, tiles].filter((c, i, a) => c <= n && a.indexOf(c) === i)) {
  const t = c === 1 ? bulk : inCalls(c), ov = Math.max(0, t - bulk);
  console.log(`  ${String(c).padStart(6)}   ${String(Math.floor(n / c)).padStart(12)}   ${t.toFixed(0).padStart(9)}   ${ov.toFixed(0).padStart(22)}   ${(ov / c).toFixed(3).padStart(7)} ms`);
}
sample(recBase, n, bulkOut);   // restore the reference counts the loops above overwrote piecewise

// 2. gather is exact: the records of scattered tiles, copied into one buffer, sample to the same counts as in place
function gather(idx) {
  const ranges = idx.map(rangeOf).filter(([, c]) => c > 0), total = ranges.reduce((a, [, c]) => a + c, 0);
  const mark = k.mark(), buf = k.alloc(total * REC), out = k.alloc(total * 4);
  let o = 0; for (const [first, c] of ranges) { k.u8(buf + o * REC, c * REC).set(k.u8(recBase + first * REC, c * REC)); o += c; }
  return { ranges, total, buf, out, release: () => k.release(mark) };
}
{
  const idx = Array.from({ length: Math.min(256, tiles) }, (_, i) => (i * 7919 + 13) % tiles).sort((a, b) => a - b);
  const g = gather(idx); sample(g.buf, g.total, g.out);
  const got = k.u32(g.out, g.total), want = k.u32(bulkOut, n); let o = 0, bad = 0;
  for (const [first, c] of g.ranges) { for (let j = 0; j < c; j++) if (got[o + j] !== want[first + j]) bad++; o += c; }
  g.release();
  console.log(`\ngathered sampling == in-place sampling for the same records: ${bad === 0 ? "yes" : `NO, ${bad} differ`} (${g.total.toLocaleString("en-US")} records from ${idx.length} scattered tiles)`);
  if (bad) process.exit(1);
}

// 3. a claim over k challenge-selected tiles, derivation measured with one gathered call
console.log(`\na claim over k tiles, from base+recipe (derivation gathered into one call; writeback not timed):`);
console.log(`  k tiles   fraction   gather+derive    sketch    100 brains per epoch   a host missing 1% passes`);
for (const kk of [...[64, 256, 1024, 4096].filter((x) => x < tiles), tiles]) {
  const idx = Array.from({ length: kk }, (_, i) => (i * 7919 + 13) % tiles).sort((a, b) => a - b);
  let td;
  if (kk >= tiles) td = bulk;                              // every tile: that is the bulk call, no gather needed
  else td = best(() => { const g = gather(idx); sample(g.buf, g.total, g.out); g.release(); });
  const ts = best(() => { for (const t of idx) k.sketch(handle.ptr + t * TILE, 1, 0, 0x5eed5eed, sk + t * 4); });
  const p100 = 100 * (td + ts) / 1000;
  console.log(`  ${String(kk).padStart(6)}   ${(kk / tiles * 100).toFixed(1).padStart(6)}%   ${td.toFixed(1).padStart(11)} ms ${ts.toFixed(1).padStart(8)} ms ${(p100 < 90 ? p100.toFixed(1) + " s" : (p100 / 60).toFixed(1) + " min").padStart(20)}   ${Math.pow(0.99, kk).toExponential(1).padStart(9)}`);
}
