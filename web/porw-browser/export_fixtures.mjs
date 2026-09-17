// Export on-chain test fixtures from real browser-node artifacts (for contracts/evm/test/Mesh.t.sol).
//   node export_fixtures.mjs <out.json> [epochBlocks=100] [epoch=1] [prevrandao=42]
// The claim is signed over the contract's epoch challenge: beacon = keccak(uint256 prevrandao || uint256 blockNumber)
// recorded at the epoch's first block; challenge = keccak(beacon || mepId).
import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES, treeWidths } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import { signHash, addressOf } from "./claim.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const [out, epochBlocksArg, epochArg, prevrandaoArg] = process.argv.slice(2);
const EPOCH_BLOCKS = Number(epochBlocksArg || 100), EPOCH = Number(epochArg || 1), PREVRANDAO = BigInt(prevrandaoArg || 42);
const be256 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const H = V.hex;

const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const payload = synthesizePayload("flywire-female", 4000, 40000); // small so the dispute openings stay test-sized
const steps = 2, stimulusSeed = 5; const nonces = [9, 10, 11].map((v) => new Uint8Array(32).fill(v));

const mk = async (priv, lie) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + priv.repeat(32) }); if (lie) nd.execLie = lie; const st = await nd.loadModel("flywire-female", payload, { steps }); return { nd, st }; };
const A = await mk("11"); const mep = A.st.mep; const mepId = mep.mepId;

// contract-derived epoch challenge
const epochStart = EPOCH * EPOCH_BLOCKS;
const beacon = keccak_256(cat(be256(PREVRANDAO), be256(epochStart)));
const challenge = keccak_256(cat(beacon, mepId));

// pick a neuron for the execution lie: not clamped, in-degree >= 3, honest act + 777 < 65536
const rA = await A.nd.challenge(mepId, challenge, { stimulusSeed });
const actFinal = A.nd.activations(mepId, steps); let neuron = -1;
for (let i = 0; i < actFinal.length; i++) { const ps = A.nd.partialSums(mepId, steps, i); if (ps.sums.length >= 3 && actFinal[i] + 777 < 65536 && V.rowActivation(ps.sums[ps.sums.length - 1]) === actFinal[i]) { neuron = i; break; } }
if (neuron < 0) throw new Error("no suitable neuron");
const B = await mk("22", { step: steps, neuron, delta: 777 });
const rB = await B.nd.challenge(mepId, challenge, { stimulusSeed });

// --- residency claim (A, honest) + openings: NoFraud tile from A, Fraud tile from a residency liar ---
const L = await mk("33"); L.nd.lies.set(`${H(mepId)}:7`, 12345); const rL = await L.nd.challenge(mepId, challenge, { stimulusSeed });
const opening = (nd, r, t) => { const o = nd.open(mepId, t); return { tileIdx: o.tileIdx, tile: H(o.tile), sTile: o.sketch, partialsIndex: o.position, partialsProof: o.partialsProof.map(H), weightsProof: o.weightsProof.map(H) }; };
const claimJson = (r) => { const c = r.claim; return { mepId: H(c.mepId), partialsRoot: H(c.partialsRoot), coverageBytes: c.coverageBytes, challenge: H(c.challenge), deviceId: H(c.deviceId), execDigest: H(c.execDigest), stimulusSeed: c.stimulusSeed, signature: H(r.signature), signer: H(r.address) }; };

// --- task results signed by A and B: resultHash = keccak("porw-result" || taskId || execDigest || execRoot) ---
const taskIds = nonces.map((nonce) => keccak_256(cat(mepId, be32(stimulusSeed), nonce)));
const resultSig = (P, r, taskId) => { const h = keccak_256(cat(new TextEncoder().encode("porw-result"), taskId, r.result.execDigest, r.result.execRoot)); return { execDigest: H(r.result.execDigest), execRoot: H(r.result.execRoot), signature: H(signHash(h, P.nd.key.priv)), signer: H(P.nd.key.address) }; };

// --- dispute path: step, then the children pairs each party posts, following the contract's rule ---
const n = A.st.hdr.neurons; const sStar = D.firstDifferingStep(rA.result.actRoots, rB.result.actRoots);
const w = treeWidths(n); let level = w.length - 1, idx = 0; const pairsA = [], pairsB = [];
while (level > 0) {
  const l = 2 * idx, r = 2 * idx + 1, cw = w[level - 1];
  const pa = [A.nd.actNode(mepId, sStar, level - 1, l), r < cw ? A.nd.actNode(mepId, sStar, level - 1, r) : A.nd.actNode(mepId, sStar, level - 1, l)];
  const pb = [B.nd.actNode(mepId, sStar, level - 1, l), r < cw ? B.nd.actNode(mepId, sStar, level - 1, r) : B.nd.actNode(mepId, sStar, level - 1, l)];
  pairsA.push(pa.map(H)); pairsB.push(pb.map(H));
  const goLeft = !V.eq(pa[0], pb[0]); idx = goLeft ? l : (r < cw ? r : l); level--;
}
if (idx !== neuron) throw new Error(`bisection reached ${idx}, expected ${neuron}`);
const psA = A.nd.partialSums(mepId, sStar, neuron), psB = B.nd.partialSums(mepId, sStar, neuron);
const len = psA.sums.length, jLie = Math.floor(len / 2); const lied = psB.sums.slice(); for (let j = jLie; j < len; j++) lied[j] += 777n << 16n;
const kStar = psA.k0 + jLie;
const rowStart = A.nd.openRowStart(mepId, neuron), rowEnd = A.nd.openRowStart(mepId, neuron + 1);
const chunk = A.nd.openCsrChunk(mepId, Math.floor(kStar / A.st.csr.chunk));
const rec = V.record(chunk.records.subarray((kStar - chunk.k0) * 10, (kStar - chunk.k0) * 10 + 10));
const preOpen = sStar > 1 ? A.nd.openActivation(mepId, sStar - 1, rec.pre) : { act: V.stimulusAct(rec.pre, stimulusSeed), proof: [] };
const actA = A.nd.openActivation(mepId, sStar, neuron).act, actB = B.nd.openActivation(mepId, sStar, neuron).act;
if (V.rowActivation(lied[len - 1]) !== actB) throw new Error("lied sums inconsistent with B's activation (clamp)");

fs.writeFileSync(out, JSON.stringify({
  params: { epochBlocks: EPOCH_BLOCKS, epoch: EPOCH, epochStart, prevrandao: Number(PREVRANDAO), beacon: H(beacon), challenge: H(challenge), steps, stimulusSeed, nonces: nonces.map(H), taskIds: taskIds.map(H) },
  mep: { mepId: H(mepId), modelId: H(mep.modelId), schemeDigest: H(mep.schemeDigest), execKind: H(mep.execKind), steps: mep.steps, clampQ16: mep.clampQ16, neurons: n, synapses: A.st.hdr.synapses, synapseRoot: H(rA.result.synapseRoot), csrRoot: H(rA.result.csrRoot), rowRoot: H(rA.result.rowRoot), nTiles: A.st.nTiles },
  instances: { A: H(A.nd.key.address), B: H(B.nd.key.address), L: H(L.nd.key.address) },
  claimA: claimJson(rA), claimB: claimJson(rB), claimL: claimJson(rL),
  openingNoFraud: opening(A.nd, rA, 3), openingFraud: opening(L.nd, rL, 7), openingHonestOfLiar: opening(L.nd, rL, 3),
  resultsA: taskIds.map((t) => resultSig(A, rA, t)), resultsB: taskIds.map((t) => resultSig(B, rB, t)),
  dispute: { sStar, actRootsA: rA.result.actRoots.map(H), actRootsB: rB.result.actRoots.map(H), rounds: pairsA.length, pairsAFlat: pairsA.flat(), pairsBFlat: pairsB.flat(), neuron, actA, actB,
    sumsA: Array.from(psA.sums, Number), sumsBHonest: Array.from(psB.sums, Number), sumsBLied: Array.from(lied, Number), kStar,
    rowStart: { value: rowStart.value, proof: rowStart.proof.map(H) }, rowEnd: { value: rowEnd.value, proof: rowEnd.proof.map(H) },
    chunk: { c: chunk.c, records: H(chunk.records), proof: chunk.proof.map(H) }, actPre: preOpen.act, actPreProof: preOpen.proof.map(H) },
}, null, 1));
console.log(`fixtures -> ${out}: ${n} neurons, ${A.st.nTiles} tiles, s*=${sStar}, neuron ${neuron}, in-degree ${len}, k*=${kStar}, ${pairsA.length} bisection rounds`);
