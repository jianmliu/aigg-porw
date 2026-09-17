// Export on-chain test fixtures from real browser-node artifacts (for contracts/evm/test/Mesh.t.sol).
//   node export_fixtures.mjs <out.json> [epochBlocks=100] [epoch=1] [prevrandao=42]
// The claim is signed over the contract's epoch challenge: beacon = keccak(uint256 prevrandao || uint256 blockNumber)
// recorded at the epoch's first block; challenge = keccak(beacon || mepId).
import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES, treeWidths } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import { signHash, addressOf, keypair } from "./claim.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as E from "./eip712.js";
import { domains, walletAndSession, CHAIN_ID, CM_ADDR, MK_ADDR, REG_ADDR, DELEGATION_EXPIRY } from "./export_fixtures_common.js";

const [out, epochBlocksArg, epochArg, prevrandaoArg] = process.argv.slice(2);
const EPOCH_BLOCKS = Number(epochBlocksArg || 100), EPOCH = Number(epochArg || 1), PREVRANDAO = BigInt(prevrandaoArg || 42);
const be256 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const H = V.hex;

const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const payload = synthesizePayload("flywire-female", 4000, 40000); // small so the dispute openings stay test-sized
const steps = 2, stimulusSeed = 5; const nonces = [9, 10, 11].map((v) => new Uint8Array(32).fill(v));

const mk = async (priv, lie) => { const ws = await walletAndSession(String.fromCharCode(priv.charCodeAt(0)) + "a", priv); const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: ws.sessionPriv, domains, delegation: ws.delegation }); if (lie) nd.execLie = lie; const st = await nd.loadModel("flywire-female", payload, { steps }); return { nd, st, ws }; };
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
const claimJson = (r) => { const c = r.claim; return { mepId: H(c.mepId), partialsRoot: H(c.partialsRoot), coverageBytes: c.coverageBytes, challenge: H(c.challenge), deviceId: H(c.deviceId), execDigest: H(c.execDigest), stimulusSeed: c.stimulusSeed, signature: H(r.signature), signer: H(r.address), digest: H(r.digest), instance: r.delegation.instance }; };

// --- task results signed by A and B: resultHash = keccak("porw-result" || taskId || execDigest || execRoot) ---
const taskIds = nonces.map((nonce) => keccak_256(cat(mepId, be32(stimulusSeed), nonce)));
const resultSig = (P, r, taskId) => { const h = E.resultDigest(domains.market, taskId, r.result.execDigest, r.result.execRoot); return { execDigest: H(r.result.execDigest), execRoot: H(r.result.execRoot), signature: H(signHash(h, P.nd.key.priv)), signer: H(P.nd.key.address) }; };

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

const F = ({
  params: { epochBlocks: EPOCH_BLOCKS, epoch: EPOCH, epochStart, prevrandao: Number(PREVRANDAO), beacon: H(beacon), challenge: H(challenge), steps, stimulusSeed, nonces: nonces.map(H), taskIds: taskIds.map(H) },
  mep: { mepId: H(mepId), modelId: H(mep.modelId), schemeDigest: H(mep.schemeDigest), execKind: H(mep.execKind), steps: mep.steps, clampQ16: mep.clampQ16, neurons: n, synapses: A.st.hdr.synapses, synapseRoot: H(rA.result.synapseRoot), csrRoot: H(rA.result.csrRoot), rowRoot: H(rA.result.rowRoot), nTiles: A.st.nTiles },
  instances: { A: A.ws.wallet.address, B: B.ws.wallet.address, L: L.ws.wallet.address }, sessions: { A: H(A.nd.key.address), B: H(B.nd.key.address), L: H(L.nd.key.address) },
  delegations: { A: A.ws.delegation, B: B.ws.delegation, L: L.ws.delegation }, eip712: { chainId: CHAIN_ID, claimManager: CM_ADDR, market: MK_ADDR, registry: REG_ADDR, expiry: DELEGATION_EXPIRY },
  claimA: claimJson(rA), claimB: claimJson(rB), claimL: claimJson(rL), claimHashA: H(rA.claimHash),
  openingNoFraud: opening(A.nd, rA, 3), openingFraud: opening(L.nd, rL, 7), openingHonestOfLiar: opening(L.nd, rL, 3),
  resultsA: taskIds.map((t) => resultSig(A, rA, t)), resultsB: taskIds.map((t) => resultSig(B, rB, t)),
  dispute: { sStar, actRootsA: rA.result.actRoots.map(H), actRootsB: rB.result.actRoots.map(H), rounds: pairsA.length, pairsAFlat: pairsA.flat(), pairsBFlat: pairsB.flat(), neuron, actA, actB,
    sumsA: Array.from(psA.sums, Number), sumsBHonest: Array.from(psB.sums, Number), sumsBLied: Array.from(lied, Number), kStar,
    rowStart: { value: rowStart.value, proof: rowStart.proof.map(H) }, rowEnd: { value: rowEnd.value, proof: rowEnd.proof.map(H) },
    chunk: { c: chunk.c, records: H(chunk.records), proof: chunk.proof.map(H) }, actPre: preOpen.act, actPreProof: preOpen.proof.map(H) },
});
fs.writeFileSync(out, JSON.stringify(F, null, 1));
writeSolidity(F, out.replace(/\.json$/, ""));
console.log(`fixtures -> ${out} (+ MeshFixtures.sol, BrowserClaimFixture.sol): ${n} neurons, ${A.st.nTiles} tiles, s*=${sStar}, neuron ${neuron}, in-degree ${len}, k*=${kStar}, ${pairsA.length} bisection rounds`);

// ---- Solidity fixture generation (typed constants; keeps foundry.toml free of fs permissions) ----
// EIP-55 checksummed address literal (Solidity rejects non-checksummed 40-hex literals)
function checksum(addrHex) {
  const low = addrHex.slice(2).toLowerCase();
  const h = Array.from(keccak_256(new TextEncoder().encode(low)), (b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + Array.from(low, (c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}
function writeSolidity(F, base) {
  const dir = base.slice(0, base.lastIndexOf("/") + 1);
  const b32 = (v) => v; const num = (v) => String(v);
  const arr32 = (name, a) => `    function ${name}() internal pure returns (bytes32[] memory a) { a = new bytes32[](${a.length});${a.map((v, i) => ` a[${i}] = ${v};`).join("")} }\n`;
  const arr64 = (name, a) => `    function ${name}() internal pure returns (uint64[] memory a) { a = new uint64[](${a.length});${a.map((v, i) => ` a[${i}] = ${num(v)};`).join("")} }\n`;
  const bytesFn = (name, hexv) => `    function ${name}() internal pure returns (bytes memory) { return hex"${hexv.slice(2)}"; }\n`;
  const claimFn = (name, c) => `    function ${name}() internal pure returns (IPoRWClaimManager.Claim memory c, bytes memory sig, address signer) {
        c = IPoRWClaimManager.Claim({ mepId: ${c.mepId}, partialsRoot: ${c.partialsRoot}, coverageBytes: ${c.coverageBytes}, challenge: ${c.challenge}, deviceId: ${c.deviceId}, execDigest: ${c.execDigest}, stimulusSeed: ${c.stimulusSeed} });
        sig = hex"${c.signature.slice(2)}"; signer = ${checksum(c.signer)};
    }\n`;
  const openingFn = (name, o) => `    function ${name}() internal pure returns (IPoRWClaimManager.Opening memory o) {
        o = IPoRWClaimManager.Opening({ tileIdx: ${o.tileIdx}, tile: ${name}Tile(), sTile: ${o.sTile}, partialsIndex: ${o.partialsIndex}, partialsProof: ${name}PP(), weightsProof: ${name}WP() });
    }\n` + bytesFn(name + "Tile", o.tile) + arr32(name + "PP", o.partialsProof) + arr32(name + "WP", o.weightsProof);
  const resultFn = (name, r) => `    function ${name}() internal pure returns (ITaskMarket.Result memory r, bytes memory sig, address signer) {
        r = ITaskMarket.Result({ execDigest: ${r.execDigest}, execRoot: ${r.execRoot} }); sig = hex"${r.signature.slice(2)}"; signer = ${checksum(r.signer)};
    }\n`;
  const P = F.params, M = F.mep, D = F.dispute;
  let sol = `// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
// GENERATED by web/porw-browser/export_fixtures.mjs from real browser-node runs — do not edit.
import "../../src/interfaces/PorwMesh.sol";

library MeshFixtures {
    uint64 constant EPOCH_BLOCKS = ${P.epochBlocks}; uint64 constant EPOCH = ${P.epoch}; uint256 constant EPOCH_START = ${P.epochStart}; uint256 constant PREVRANDAO = ${P.prevrandao};
    bytes32 constant BEACON = ${P.beacon}; bytes32 constant CHALLENGE = ${P.challenge}; uint32 constant STIMULUS_SEED = ${P.stimulusSeed};
    bytes32 constant MEP_ID = ${M.mepId}; bytes32 constant MODEL_ID = ${M.modelId}; bytes32 constant SCHEME_DIGEST = ${M.schemeDigest}; bytes32 constant EXEC_KIND = ${M.execKind};
    uint32 constant STEPS = ${M.steps}; uint32 constant CLAMP_Q16 = ${M.clampQ16}; uint32 constant NEURONS = ${M.neurons}; uint32 constant SYNAPSES = ${M.synapses};
    bytes32 constant SYNAPSE_ROOT = ${M.synapseRoot}; bytes32 constant CSR_ROOT = ${M.csrRoot}; bytes32 constant ROW_ROOT = ${M.rowRoot}; uint64 constant N_TILES = ${M.nTiles};
    address constant A = ${checksum(F.instances.A)}; address constant B = ${checksum(F.instances.B)}; address constant L = ${checksum(F.instances.L)}; // bonded wallets
    address constant SESSION_A = ${checksum(F.sessions.A)}; address constant SESSION_B = ${checksum(F.sessions.B)}; address constant SESSION_L = ${checksum(F.sessions.L)}; // delegated tab keys
    uint256 constant CHAIN_ID = ${F.eip712.chainId}; address constant CLAIM_MANAGER = ${checksum(F.eip712.claimManager)}; address constant MARKET = ${checksum(F.eip712.market)}; address constant REGISTRY = ${checksum(F.eip712.registry)}; uint64 constant DELEGATION_EXPIRY = ${F.eip712.expiry};
    bytes32 constant CLAIM_DIGEST_A = ${F.claimA.digest};
    uint32 constant S_STAR = ${D.sStar}; uint32 constant ROUNDS = ${D.rounds}; uint32 constant NEURON = ${D.neuron}; uint32 constant ACT_A = ${D.actA}; uint32 constant ACT_B = ${D.actB}; uint32 constant K_STAR = ${D.kStar};
    uint32 constant ROW_START = ${D.rowStart.value}; uint32 constant ROW_END = ${D.rowEnd.value}; uint32 constant CHUNK_C = ${D.chunk.c}; uint32 constant ACT_PRE = ${D.actPre};
`;
  const delFn = (name, d) => `    function ${name}() internal pure returns (address instance, address session, uint64 expiry, bytes memory sig) { instance = ${checksum(d.instance)}; session = ${checksum(d.session)}; expiry = ${d.expiry}; sig = hex"${d.sig.slice(2)}"; }\n`;
  sol += delFn("delegationA", F.delegations.A) + delFn("delegationB", F.delegations.B) + delFn("delegationL", F.delegations.L);
  sol += arr32("nonces", P.nonces) + arr32("taskIds", P.taskIds);
  sol += claimFn("claimA", F.claimA) + claimFn("claimB", F.claimB) + claimFn("claimL", F.claimL);
  sol += openingFn("openingNoFraud", F.openingNoFraud) + openingFn("openingFraud", F.openingFraud) + openingFn("openingHonestOfLiar", F.openingHonestOfLiar);
  F.resultsA.forEach((r, i) => { sol += resultFn(`resultA${i}`, r); }); F.resultsB.forEach((r, i) => { sol += resultFn(`resultB${i}`, r); });
  sol += arr32("actRootsA", D.actRootsA) + arr32("actRootsB", D.actRootsB) + arr32("pairsAFlat", D.pairsAFlat) + arr32("pairsBFlat", D.pairsBFlat);
  sol += arr64("sumsA", D.sumsA) + arr64("sumsBHonest", D.sumsBHonest) + arr64("sumsBLied", D.sumsBLied);
  sol += arr32("rowStartProof", D.rowStart.proof) + arr32("rowEndProof", D.rowEnd.proof) + arr32("chunkProof", D.chunk.proof) + bytesFn("chunkRecords", D.chunk.records) + arr32("actPreProof", D.actPreProof);
  sol += "}\n";
  fs.writeFileSync(dir + "MeshFixtures.sol", sol);
  const c = F.claimA;
  fs.writeFileSync(dir + "BrowserClaimFixture.sol", `// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
// GENERATED by web/porw-browser/export_fixtures.mjs — the browser node's signed residency claim.
library BrowserClaimFixture {
    bytes32 constant SCHEME_DIGEST = ${M.schemeDigest}; bytes32 constant MEP_ID = ${M.mepId}; bytes32 constant MODEL_ID = ${M.modelId};
    bytes32 constant EXEC_KIND = ${M.execKind}; uint32 constant STEPS = ${M.steps}; uint32 constant CLAMP_Q16 = ${M.clampQ16};
    bytes32 constant PARTIALS_ROOT = ${c.partialsRoot}; uint64 constant COVERAGE_BYTES = ${c.coverageBytes}; bytes32 constant CHALLENGE = ${c.challenge};
    bytes32 constant DEVICE_ID = ${c.deviceId}; bytes32 constant EXEC_DIGEST = ${c.execDigest}; uint32 constant STIMULUS_SEED = ${c.stimulusSeed};
    bytes32 constant CLAIM_HASH = ${F.claimHashA}; bytes32 constant CLAIM_DIGEST = ${c.digest}; address constant SIGNER = ${checksum(c.signer)}; address constant INSTANCE = ${checksum(c.instance)};
    uint256 constant CHAIN_ID = ${F.eip712.chainId}; address constant CLAIM_MANAGER = ${checksum(F.eip712.claimManager)}; address constant REGISTRY = ${checksum(F.eip712.registry)};
    function signature() internal pure returns (bytes memory) { return hex"${c.signature.slice(2)}"; }
    function delegation() internal pure returns (address instance, address session, uint64 expiry, bytes memory sig) { instance = ${checksum(F.delegations.A.instance)}; session = ${checksum(F.delegations.A.session)}; expiry = ${F.delegations.A.expiry}; sig = hex"${F.delegations.A.sig.slice(2)}"; }
}
`);
}
