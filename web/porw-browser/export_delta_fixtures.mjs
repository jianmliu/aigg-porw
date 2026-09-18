// Fixtures for contracts/evm/test/FlyDelta.t.sol from the JS implementation: sampler vectors (hash64, lnQ60, expQ256, NB draws)
// and an in-place lineage on a synthetic base (two founders, a child, tampered children) with the tile openings a one-record
// check needs. Typed Solidity constants, so foundry.toml needs no fs permissions.
//   node export_delta_fixtures.mjs ../../contracts/evm/test/fixtures/FlyDeltaFixtures.sol
import fs from "node:fs";
import * as V from "./verify.js";
import { synthesizePayloadV2 } from "./synth.js";
import { decodeHeader } from "./model.js";
import { hash64Words, lnQ60, expQ256, nbTable, sampleFromTable, DEFAULT_R_TABLE, rOf } from "./sample.js";
import { encodeDelta3, decodeDelta3, applyDelta, deltaId, modelIdOf, records, recordAt, expectedRecord, fitName, baseNameLength, LAYOUT, MUT_ALWAYS } from "./delta.js";
const out = process.argv[2]; if (!out) { console.log("usage: export_delta_fixtures.mjs <FlyDeltaFixtures.sol>"); process.exit(2); }
const H = V.hex; const TILE = 4096;
// ---- sampler vectors ----
const hv = [[1n, 0, 0], [7n, 5, 9], [0xdeadbeefcafef00dn, 1234, 56789], [1n << 32n, 3, 4], [(1n << 64n) - 1n, 0xffffffff, 0xffffffff], [101n, 0xffffffff, 17], [101n, 17, 0xffffffff], [99999n, 2999, 0]].map(([s, a, b]) => { const [hi, lo] = hash64Words(Number(s & 0xffffffffn) >>> 0, Number(s >> 32n) >>> 0, a, b); return { s, a, b, hi, lo }; });
const lv = [[1n, 2n], [236n * 256n, 236n * 256n + 5n * 65536n], [423n * 256n, 423n * 256n + 60293n], [4412n * 256n, 4412n * 256n + 2405n * 65536n], [3n, 1000003n], [7n, 8n]].map(([n, d]) => ({ n, d, v: lnQ60(n, d) }));
const ev = [-1n, -799144290325165978n, -5000000000000000000n, -(1n << 62n) * 9n, -(1n << 60n) * 120n, -123456789012345678n].map((y) => ({ y, v: expQ256(y) }));
const sv = []; { let x = 0x12345678n; const next = () => { x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return x; };
  for (const c of [1, 1, 2, 3, 5, 5, 8, 13, 22, 40, 77, 150, 333, 1000, 2405]) for (const mr of [65536, 60293]) { const R = rOf(c, DEFAULT_R_TABLE); const t = nbTable(c, R, mr); for (const U of [next(), next()]) sv.push({ c, R, mr, U, k: sampleFromTable(t, U) }); }
  for (const [c, U] of [[5, 0n], [5, (1n << 64n) - 1n], [1, (1n << 64n) - 2n], [2405, (1n << 64n) - 1n], [40, 1n << 63n]]) { const R = rOf(c, DEFAULT_R_TABLE); sv.push({ c, R, mr: 65536, U, k: sampleFromTable(nbTable(c, R, 65536), U) }); } }
// ---- an in-place lineage ----
const n = 3000, ns = 30000; const base = synthesizePayloadV2("synthetic-base", n, ns); const hb = decodeHeader(base); const NL = baseNameLength(base); const mid = modelIdOf(base); const zero = new Uint8Array(32);
const byId = new Map(); const reg = (b) => { byId.set(H(deltaId(b)), b); return b; }; const resolve = (id) => byId.get(id);
const mk = (o) => reg(encodeDelta3({ baseModelId: mid, neurons: n, layout: LAYOUT.inplace, minSyn: 5, meanRatioQ16: 60293, ...o, name: fitName(o.name, NL) }));
const fA = mk({ parentA: zero, parentB: zero, seed: 1n, mutRateQ32: MUT_ALWAYS, name: "founderA" }), fB = mk({ parentA: zero, parentB: zero, seed: 2n, mutRateQ32: MUT_ALWAYS, name: "founderB" });
const child = mk({ parentA: deltaId(fA), parentB: deltaId(fB), seed: 101n, name: "child" }); const PA = applyDelta(base, fA, { resolve }), PB = applyDelta(base, fB, { resolve }), PC = applyDelta(base, child, { resolve });
const nTiles = base.length / TILE; const leavesOf = (p) => Array.from({ length: nTiles }, (_, t) => V.weightsLeaf(t, p.subarray(t * TILE, (t + 1) * TILE)));
const L = { base: leavesOf(base), A: leavesOf(PA), B: leavesOf(PB), C: leavesOf(PC) }; const P = { base, A: PA, B: PB, C: PC };
// a tile pair (T, T+1) with a record straddling the boundary, entirely inside the record area
let T = -1, jStraddle = -1; for (let j = 0; j < ns; j++) { const off = hb.synOffset + j * 10; if (off % TILE > TILE - 10 && off % TILE !== 0 && Math.floor(off / TILE) * TILE >= hb.synOffset) { T = Math.floor(off / TILE); jStraddle = j; break; } } // tile T holds records only, ~409 of them
const inTiles = (j) => Math.floor((hb.synOffset + j * 10) / TILE) === T && Math.floor((hb.synOffset + j * 10 + 9) / TILE) === T; // the single-tile cases all live in tile T
const dC = decodeDelta3(child); const cases = {}; const want = ["fromA", "fromB", "mutated", "zeroed"];
for (let j = 0; j < ns && Object.keys(cases).length < want.length; j++) { if (!inTiles(j) || j === jStraddle) continue; const c = recordAt(PC, j), a = recordAt(PA, j), b = recordAt(PB, j);
  const tag = c.w === 0 ? "zeroed" : (c.w === a.w && c.w !== b.w) ? "fromA" : (c.w === b.w && c.w !== a.w) ? "fromB" : (c.w !== a.w && c.w !== b.w) ? "mutated" : null; if (tag && !(tag in cases)) cases[tag] = j; }
cases.straddling = jStraddle; for (const w of want) if (!(w in cases)) throw new Error("no fixture record for case " + w);
for (const [k, j] of Object.entries(cases)) if (expectedRecord(child, base, PA, PB, j).w !== recordAt(PC, j).w) throw new Error("self-check failed for " + k);
// tampered children: one weight changed (record `fromA`), and one root-id byte flipped (static region)
const tamper = (f) => { const p = Uint8Array.from(PC); f(p, new DataView(p.buffer)); return p; };
const PW = tamper((p, dv) => { const o = hb.synOffset + cases.fromA * 10 + 8; dv.setInt16(o, dv.getInt16(o, true) + 1, true); }); const staticTile = Math.floor((hb.neuronOffset + 8 * 100) / TILE); const PS = tamper((p) => { p[hb.neuronOffset + 8 * 100] ^= 1; });
L.W = leavesOf(PW); P.W = PW; L.S = leavesOf(PS); P.S = PS; const roots = Object.fromEntries(Object.entries(L).map(([k, lv]) => [k, V.merkleRoot(lv)]));
// ---- Solidity ----
const hexBytes = (b) => `hex"${Buffer.from(b).toString("hex")}"`; const u256 = (v) => "0x" + BigInt.asUintN(256, BigInt(v)).toString(16);
let s = `// SPDX-License-Identifier: 0BSD\n// GENERATED by web/porw-browser/export_delta_fixtures.mjs -- do not edit\npragma solidity ^0.8.20;\n\nlibrary FlyDeltaFixtures {\n`;
s += `    uint256 constant N_HASH = ${hv.length}; uint256 constant N_LN = ${lv.length}; uint256 constant N_EXP = ${ev.length}; uint256 constant N_SAMPLE = ${sv.length};\n`;
s += `    function hashVec(uint256 i) internal pure returns (uint64 seed, uint32 a, uint32 b, uint32 hi, uint32 lo) {\n${hv.map((v, i) => `        if (i == ${i}) return (${v.s}, ${v.a}, ${v.b}, ${v.hi}, ${v.lo});`).join("\n")}\n        revert();\n    }\n`;
s += `    function lnVec(uint256 i) internal pure returns (uint256 num, uint256 den, int256 v) {\n${lv.map((v, i) => `        if (i == ${i}) return (${v.n}, ${v.d}, ${v.v});`).join("\n")}\n        revert();\n    }\n`;
s += `    function expVec(uint256 i) internal pure returns (int256 y, uint256 v) {\n${ev.map((v, i) => `        if (i == ${i}) return (${v.y}, ${u256(v.v)});`).join("\n")}\n        revert();\n    }\n`;
s += `    function sampleVec(uint256 i) internal pure returns (uint32 c, uint256 R, uint256 MR, uint64 U, uint32 k) {\n${sv.map((v, i) => `        if (i == ${i}) return (${v.c}, ${v.R}, ${v.mr}, ${v.U}, ${v.k});`).join("\n")}\n        revert();\n    }\n`;
s += `    // in-place lineage on synthesizePayloadV2("synthetic-base", ${n}, ${ns}): founders A, B (seeds 1, 2), child (seed 101, record granularity, mutation 1/8)\n`;
s += `    uint64 constant N_TILES = ${nTiles}; uint64 constant SYN_OFFSET = ${hb.synOffset}; uint64 constant SYNAPSES = ${ns}; uint16 constant NAME_LEN = ${NL}; uint64 constant TILE_T = ${T}; uint64 constant STATIC_TILE = ${staticTile};\n`;
for (const [k, r] of Object.entries(roots)) s += `    bytes32 constant ROOT_${k.toUpperCase()} = ${H(r)};\n`;
s += `    bytes32 constant DELTA_ID_A = ${H(deltaId(fA))}; bytes32 constant DELTA_ID_B = ${H(deltaId(fB))};\n`;
s += `    function deltaFounderA() internal pure returns (bytes memory) { return ${hexBytes(fA)}; }\n    function deltaChild() internal pure returns (bytes memory) { return ${hexBytes(child)}; }\n`;
s += `    function deltaCompact() internal pure returns (bytes memory) { return ${hexBytes(encodeDelta3({ baseModelId: mid, neurons: n, parentA: zero, parentB: zero, seed: 1n, name: "compact" }))}; }\n`;
for (const [k, j] of Object.entries(cases)) s += `    uint64 constant J_${k.toUpperCase()} = ${j}; int16 constant W_${k.toUpperCase()} = ${recordAt(PC, j).w};\n`;
const tiles = [["base", T], ["base", T + 1], ["A", T], ["A", T + 1], ["B", T], ["B", T + 1], ["C", T], ["C", T + 1], ["W", Math.floor((hb.synOffset + cases.fromA * 10) / TILE)], ["base", staticTile], ["C", staticTile], ["S", staticTile]];
const seen = new Set(); for (const [k, t] of tiles) { const id = `${k}_${t === T ? "T" : t === T + 1 ? "T1" : "static"}`; // stable names: the tile numbers depend on the synthetic base if (seen.has(id)) continue; seen.add(id);
  s += `    function tile_${id}() internal pure returns (bytes memory) { return ${hexBytes(P[k].subarray(t * TILE, (t + 1) * TILE))}; }\n`;
  const pr = V.merkleProof(L[k], t); s += `    function proof_${id}() internal pure returns (bytes32[] memory a) { a = new bytes32[](${pr.length}); ${pr.map((x, i) => `a[${i}] = ${H(x)};`).join(" ")} }\n`; }
s += "}\n"; fs.writeFileSync(out, s);
console.log(`fixtures -> ${out}: ${hv.length}+${lv.length}+${ev.length}+${sv.length} sampler vectors; lineage ${nTiles} tiles, synOffset ${hb.synOffset}, tile pair ${T}/${T + 1}, cases ${JSON.stringify(cases)}, ${seen.size} tiles (${(s.length / 1024).toFixed(0)} KB)`);
