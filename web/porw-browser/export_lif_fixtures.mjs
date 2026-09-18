// Export on-chain fixtures for the int-lif execution dispute from real node runs
// (contracts/evm/test/MeshLif.t.sol <- test/fixtures/LifMeshFixtures.sol).
//   node export_lif_fixtures.mjs <out.json> [epochBlocks=100] [epoch=1] [prevrandao=42]
import fs from "node:fs";
import { loadKernelFromBytes, treeWidths } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayloadV2 } from "./synth.js";
import { signHash } from "./claim.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
import * as L from "./lif.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as E from "./eip712.js";
import { taskId as swarmTaskId } from "./swarm.js";
import { domains, walletAndSession, CHAIN_ID, CM_ADDR, MK_ADDR, REG_ADDR, DELEGATION_EXPIRY } from "./export_fixtures_common.js";

const [out, epochBlocksArg, epochArg, prevrandaoArg] = process.argv.slice(2);
const EPOCH_BLOCKS = Number(epochBlocksArg || 100), EPOCH = Number(epochArg || 1), PREVRANDAO = BigInt(prevrandaoArg || 42);
const be256 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const H = V.hex;

const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const payload = synthesizePayloadV2("lif-mesh", 4000, 120000);
const steps = 40, stride = 10, stimulusSeed = 5; const nonces = [21, 22, 23].map((v) => new Uint8Array(32).fill(v));
// the task, pinned: taskId = keccak256(abi.encode(task, nonce)) binds every field, so the Solidity test posts exactly this
const TASK = { stimulusSeed, steps, commitStride: stride, fee: 10n ** 18n, deadline: 10_000_000, redundancy: 2 };
const stimulusIds = Uint32Array.from({ length: 300 }, (_, j) => j * 7);
const mk = async (priv, lie) => { const ws = await walletAndSession(priv[0] + "a", priv); const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: ws.sessionPriv, domains, delegation: ws.delegation }); if (lie) nd.execLie = lie; const st = await nd.loadModel("lif-mesh", payload, { maxSteps: steps }); return { nd, st, ws }; };
const A = await mk("11"); const mep = A.st.mep, mepId = mep.mepId, n = A.st.hdr.neurons;
const epochStart = EPOCH * EPOCH_BLOCKS; const beacon = keccak_256(cat(be256(PREVRANDAO), be256(epochStart))); const challenge = keccak_256(cat(beacon, mepId));

// residency claims (canonical stimulus run), then the task run with the explicit stimulus set
const claimA = await A.nd.challenge(mepId, challenge, { steps, commitStride: stride, stimulusSeed });
const Bc = await mk("22"); const claimB = await Bc.nd.challenge(mepId, challenge, { steps, commitStride: stride, stimulusSeed });
const claimJson = (r) => { const c = r.claim; return { mepId: H(c.mepId), partialsRoot: H(c.partialsRoot), coverageBytes: c.coverageBytes, challenge: H(c.challenge), deviceId: H(c.deviceId), signature: H(r.signature), signer: H(r.address) }; };
const rA = await A.nd.challenge(mepId, challenge, { steps, commitStride: stride, stimulusSeed, stimulusIds });
// the lied neuron: not stimulated, in-degree >= 3, free (not refractory) at step 22 so the input matters at step 23
const sLie = 23; const s22 = await A.nd.lifStates(mepId, sLie - 1); let neuron = -1, len = 0;
for (let i = 1; i < n; i++) { if (i % 7 === 0) continue; const S = L.decodeState(s22, i * 16); if (S.refr > 0 || (S.flags & 1)) continue; const ps = await A.nd.lifPartialSums(mepId, sLie, i); if (ps.sums.length < 3) continue;
  const honest = L.transition(S, ps.sums[ps.sums.length - 1], i, sLie, stimulusSeed), lied = L.transition(S, ps.sums[ps.sums.length - 1] + 40n, i, sLie, stimulusSeed); if (L.sameState(honest, lied)) continue; neuron = i; len = ps.sums.length; break; }
if (neuron < 0) throw new Error("no suitable neuron");
const B1 = await mk("22", { step: sLie, neuron, delta: 5000 });            // lie in the state (caught by the row check)
const B2 = await mk("22", { step: sLie, neuron, delta: 40, kind: "input" }); // lie in the input sum (caught at the single term)
const rB1 = await B1.nd.challenge(mepId, challenge, { steps, commitStride: stride, stimulusSeed, stimulusIds }), rB2 = await B2.nd.challenge(mepId, challenge, { steps, commitStride: stride, stimulusSeed, stimulusIds });
if (!V.eq(rA.result.initStateRoot, rB1.result.initStateRoot)) throw new Error("initStateRoot");
const taskIds = nonces.map((nonce) => swarmTaskId({ ...TASK, mepId, inputCommit: rA.result.initStateRoot }, nonce));
const resultSig = (P, r, taskId) => { const h = E.resultDigest(domains.market, taskId, r.result.execDigest, r.result.execRoot); return { execDigest: H(r.result.execDigest), execRoot: H(r.result.execRoot), signature: H(signHash(h, P.nd.key.priv)), signer: H(P.nd.key.address) }; };

// dispute path: segment -> refine -> bisection (per liar) -> row -> term
const segStar = D.firstDifferingStep(rA.result.actRoots, rB1.result.actRoots) - 1; if (segStar !== Math.floor((sLie - 1) / stride)) throw new Error("segment");
const segA = await A.nd.lifSegmentRoots(mepId, segStar), segB1 = await B1.nd.lifSegmentRoots(mepId, segStar), segB2 = await B2.nd.lifSegmentRoots(mepId, segStar);
const ref1 = D.refineSegment({ seg: segStar, stride, steps, prevAgreed: rA.result.actRoots[segStar - 1], segRootA: rA.result.actRoots[segStar], segRootB: rB1.result.actRoots[segStar], rootsA: segA.roots, rootsB: segB1.roots });
const ref2 = D.refineSegment({ seg: segStar, stride, steps, prevAgreed: rA.result.actRoots[segStar - 1], segRootA: rA.result.actRoots[segStar], segRootB: rB2.result.actRoots[segStar], rootsA: segA.roots, rootsB: segB2.roots });
if (ref1.step !== sLie || ref2.step !== sLie) throw new Error("refine");
const prevRoot = ref1.prevRoot;
const bisect = async (P, Q) => { const w = treeWidths(n); let level = w.length - 1, idx = 0; const pa = [], pb = [];
  while (level > 0) { const l = 2 * idx, r = 2 * idx + 1, cw = w[level - 1];
    const a = [await P.nd.lifNode(mepId, sLie, level - 1, l), r < cw ? await P.nd.lifNode(mepId, sLie, level - 1, r) : await P.nd.lifNode(mepId, sLie, level - 1, l)];
    const b = [await Q.nd.lifNode(mepId, sLie, level - 1, l), r < cw ? await Q.nd.lifNode(mepId, sLie, level - 1, r) : await Q.nd.lifNode(mepId, sLie, level - 1, l)];
    pa.push(a.map(H)); pb.push(b.map(H)); const goLeft = !V.eq(a[0], b[0]); idx = goLeft ? l : (r < cw ? r : l); level--; }
  if (idx !== neuron) throw new Error(`bisection reached ${idx}, expected ${neuron}`); return { pa, pb }; };
const bis1 = await bisect(A, B1), bis2 = await bisect(A, B2);
const psA = await A.nd.lifPartialSums(mepId, sLie, neuron), psB1 = await B1.nd.lifPartialSums(mepId, sLie, neuron);
const jLie = Math.floor(len / 2); const lied = psA.sums.slice(); for (let j = jLie; j < len; j++) lied[j] += 40n; const kStar = psA.k0 + jLie;
const stA = (await A.nd.lifOpenState(mepId, sLie, neuron)).state, stB1 = (await B1.nd.lifOpenState(mepId, sLie, neuron)).state, stB2 = (await B2.nd.lifOpenState(mepId, sLie, neuron)).state;
const self = await A.nd.lifOpenState(mepId, sLie - 1, neuron); if (!V.merkleVerifyCounted(prevRoot, L.stateLeaf(neuron, self.state), neuron, n, self.proof)) throw new Error("self opening");
if (!L.sameState(L.transition(self.state, lied[len - 1], neuron, sLie, stimulusSeed), stB2)) throw new Error("input liar's state must follow from its lied sums");
if (!L.sameState(L.transition(self.state, psA.sums[len - 1], neuron, sLie, stimulusSeed), stA)) throw new Error("A row");
const rowStart = A.nd.openRowStart(mepId, neuron), rowEnd = A.nd.openRowStart(mepId, neuron + 1);
const chunk = A.nd.openCsrChunk(mepId, Math.floor(kStar / A.st.csr.chunk));
const rec = L.recordSigned(chunk.records.subarray((kStar - chunk.k0) * 10, (kStar - chunk.k0) * 10 + 10)); if (rec.post !== neuron) throw new Error("record");
const pre = await A.nd.lifOpenState(mepId, sLie - 1, rec.pre);
const so = (o) => ({ ...o.state, proof: o.proof.map(H) });
const F = {
  params: { epochBlocks: EPOCH_BLOCKS, epoch: EPOCH, epochStart, prevrandao: Number(PREVRANDAO), beacon: H(beacon), challenge: H(challenge), steps, stride, stimulusSeed, nonces: nonces.map(H), taskIds: taskIds.map(H), stimulusIds: Array.from(stimulusIds), task: { fee: String(TASK.fee), deadline: TASK.deadline, redundancy: TASK.redundancy } },
  mep: { mepId: H(mepId), modelId: H(mep.modelId), schemeDigest: H(mep.schemeDigest), execKind: H(mep.execKind), neurons: n, synapses: A.st.hdr.synapses, synapseRoot: H(rA.result.synapseRoot), csrRoot: H(rA.result.csrRoot), rowRoot: H(rA.result.rowRoot) },
  instances: { A: A.ws.wallet.address, B: B1.ws.wallet.address }, sessions: { A: H(A.nd.key.address), B: H(B1.nd.key.address) }, delegations: { A: A.ws.delegation, B: B1.ws.delegation },
  eip712: { chainId: CHAIN_ID, claimManager: CM_ADDR, market: MK_ADDR, registry: REG_ADDR, expiry: DELEGATION_EXPIRY }, claimA: claimJson(claimA), claimB: claimJson(claimB),
  initStateRoot: H(rA.result.initStateRoot), resultsA: taskIds.map((t) => resultSig(A, rA, t)), resultsB: [resultSig(B2, rB2, taskIds[0]), resultSig(B1, rB1, taskIds[1]), resultSig(B1, rB1, taskIds[2])],
  dispute: { segStar, sStar: sLie, neuron, inDegree: len, kStar, segRootsA: rA.result.actRoots.map(H), segRootsB1: rB1.result.actRoots.map(H), segRootsB2: rB2.result.actRoots.map(H),
    stepRootsA: segA.roots.map(H), stepRootsB1: segB1.roots.map(H), stepRootsB2: segB2.roots.map(H), rounds: bis1.pa.length,
    pairsA1Flat: bis1.pa.flat(), pairsB1Flat: bis1.pb.flat(), pairsA2Flat: bis2.pa.flat(), pairsB2Flat: bis2.pb.flat(),
    stateA: stA, stateB1: stB1, stateB2: stB2, sumsA: psA.sums.map(String), sumsB1Honest: psB1.sums.map(String), sumsB2Lied: lied.map(String),
    rowStart: { value: rowStart.value, proof: rowStart.proof.map(H) }, rowEnd: { value: rowEnd.value, proof: rowEnd.proof.map(H) },
    chunk: { c: chunk.c, records: H(chunk.records), proof: chunk.proof.map(H) }, self: so(self), pre: { i: rec.pre, ...so(pre) }, record: rec, prevRoot: H(prevRoot) },
};
fs.writeFileSync(out, JSON.stringify(F, null, 1));
writeSolidity(F, out.slice(0, out.lastIndexOf("/") + 1));
console.log(`lif fixtures -> ${out} (+ LifMeshFixtures.sol): ${n} neurons, seg*=${segStar}, s*=${sLie}, neuron ${neuron}, in-degree ${len}, k*=${kStar}, ${bis1.pa.length} bisection rounds, record ${rec.pre}->${rec.post} w=${rec.w}`);

function checksum(addrHex) { const low = addrHex.slice(2).toLowerCase(); const h = Array.from(keccak_256(new TextEncoder().encode(low)), (b) => b.toString(16).padStart(2, "0")).join(""); return "0x" + Array.from(low, (c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join(""); }
function writeSolidity(F, dir) {
  const arr32 = (name, a) => `    function ${name}() internal pure returns (bytes32[] memory a) { a = new bytes32[](${a.length});${a.map((v, i) => ` a[${i}] = ${v};`).join("")} }\n`;
  const arrI64 = (name, a) => `    function ${name}() internal pure returns (int64[] memory a) { a = new int64[](${a.length});${a.map((v, i) => ` a[${i}] = ${v};`).join("")} }\n`;
  const bytesFn = (name, hexv) => `    function ${name}() internal pure returns (bytes memory) { return hex"${hexv.slice(2)}"; }\n`;
  const claimFn = (name, c) => `    function ${name}() internal pure returns (IPoRWClaimManager.Claim memory c, bytes memory sig) {
        c = IPoRWClaimManager.Claim({ mepId: ${c.mepId}, partialsRoot: ${c.partialsRoot}, coverageBytes: ${c.coverageBytes}, challenge: ${c.challenge}, deviceId: ${c.deviceId} });
        sig = hex"${c.signature.slice(2)}";
    }\n`;
  const resultFn = (name, r) => `    function ${name}() internal pure returns (ITaskMarket.Result memory r, bytes memory sig) { r = ITaskMarket.Result({ execDigest: ${r.execDigest}, execRoot: ${r.execRoot} }); sig = hex"${r.signature.slice(2)}"; }\n`;
  const stateLit = (s) => `LifRowCheck.State(${s.v}, ${s.g}, ${s.refr}, ${s.flags}, ${s.count})`;
  const openFn = (name, o) => `    function ${name}() internal pure returns (IExecutionDisputes.StateOpening memory o) { o = IExecutionDisputes.StateOpening({ v: ${o.v}, g: ${o.g}, refr: ${o.refr}, flags: ${o.flags}, count: ${o.count}, proof: ${name}Proof() }); }\n` + arr32(name + "Proof", o.proof);
  const P = F.params, M = F.mep, Dd = F.dispute;
  let sol = `// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
// GENERATED by web/porw-browser/export_lif_fixtures.mjs from real node runs (int-lif on a synthetic v2 brain) — do not edit.
import "../../src/interfaces/PorwMesh.sol";
import "../../src/mesh/LifRowCheck.sol";

library LifMeshFixtures {
    uint64 constant EPOCH_BLOCKS = ${P.epochBlocks}; uint64 constant EPOCH = ${P.epoch}; uint256 constant EPOCH_START = ${P.epochStart}; uint256 constant PREVRANDAO = ${P.prevrandao};
    bytes32 constant BEACON = ${P.beacon}; bytes32 constant CHALLENGE = ${P.challenge}; uint32 constant STIMULUS_SEED = ${P.stimulusSeed};
    bytes32 constant MEP_ID = ${M.mepId}; bytes32 constant MODEL_ID = ${M.modelId}; bytes32 constant SCHEME_DIGEST = ${M.schemeDigest}; bytes32 constant EXEC_KIND = ${M.execKind};
    uint32 constant STEPS = ${P.steps}; uint32 constant STRIDE = ${P.stride}; uint32 constant NEURONS = ${M.neurons}; uint32 constant SYNAPSES = ${M.synapses};
    uint256 constant TASK_FEE = ${P.task.fee}; uint64 constant TASK_DEADLINE = ${P.task.deadline}; uint8 constant TASK_REDUNDANCY = ${P.task.redundancy};
    bytes32 constant SYNAPSE_ROOT = ${M.synapseRoot}; bytes32 constant CSR_ROOT = ${M.csrRoot}; bytes32 constant ROW_ROOT = ${M.rowRoot}; bytes32 constant INIT_STATE_ROOT = ${F.initStateRoot};
    address constant A = ${checksum(F.instances.A)}; address constant B = ${checksum(F.instances.B)}; // bonded wallets
    address constant SESSION_A = ${checksum(F.sessions.A)}; address constant SESSION_B = ${checksum(F.sessions.B)};
    uint256 constant CHAIN_ID = ${F.eip712.chainId}; address constant CLAIM_MANAGER = ${checksum(F.eip712.claimManager)}; address constant MARKET = ${checksum(F.eip712.market)}; address constant REGISTRY = ${checksum(F.eip712.registry)};
    uint32 constant SEG_STAR = ${Dd.segStar}; uint32 constant S_STAR = ${Dd.sStar}; uint32 constant ROUNDS = ${Dd.rounds}; uint32 constant NEURON = ${Dd.neuron}; uint32 constant K_STAR = ${Dd.kStar};
    uint32 constant ROW_START = ${Dd.rowStart.value}; uint32 constant ROW_END = ${Dd.rowEnd.value}; uint32 constant CHUNK_C = ${Dd.chunk.c}; uint32 constant PRE = ${Dd.pre.i}; bytes32 constant PREV_ROOT = ${Dd.prevRoot};
    function stateA() internal pure returns (LifRowCheck.State memory) { return ${stateLit(Dd.stateA)}; }
    function stateB1() internal pure returns (LifRowCheck.State memory) { return ${stateLit(Dd.stateB1)}; }
    function stateB2() internal pure returns (LifRowCheck.State memory) { return ${stateLit(Dd.stateB2)}; }
`;
  const delFn = (name, d) => `    function ${name}() internal pure returns (address instance, address session, uint64 expiry, bytes memory sig) { instance = ${checksum(d.instance)}; session = ${checksum(d.session)}; expiry = ${d.expiry}; sig = hex"${d.sig.slice(2)}"; }\n`;
  sol += delFn("delegationA", F.delegations.A) + delFn("delegationB", F.delegations.B);
  sol += `    /// @dev the exact Task the ids were derived from -- taskId = keccak256(abi.encode(task, nonce))
    function task() internal pure returns (ITaskMarket.Task memory t) {
        t = ITaskMarket.Task({ mepId: MEP_ID, stimulusSeed: STIMULUS_SEED, steps: STEPS, commitStride: STRIDE, inputCommit: INIT_STATE_ROOT, fee: TASK_FEE, deadline: TASK_DEADLINE, redundancy: TASK_REDUNDANCY });
    }\n`;
  sol += arr32("nonces", P.nonces) + arr32("taskIds", P.taskIds) + claimFn("claimA", F.claimA) + claimFn("claimB", F.claimB);
  F.resultsA.forEach((r, i) => { sol += resultFn(`resultA${i}`, r); }); F.resultsB.forEach((r, i) => { sol += resultFn(`resultB${i}`, r); });
  sol += arr32("segRootsA", Dd.segRootsA) + arr32("segRootsB1", Dd.segRootsB1) + arr32("segRootsB2", Dd.segRootsB2) + arr32("stepRootsA", Dd.stepRootsA) + arr32("stepRootsB1", Dd.stepRootsB1) + arr32("stepRootsB2", Dd.stepRootsB2);
  sol += arr32("pairsA1Flat", Dd.pairsA1Flat) + arr32("pairsB1Flat", Dd.pairsB1Flat) + arr32("pairsA2Flat", Dd.pairsA2Flat) + arr32("pairsB2Flat", Dd.pairsB2Flat);
  sol += arrI64("sumsA", Dd.sumsA) + arrI64("sumsB1Honest", Dd.sumsB1Honest) + arrI64("sumsB2Lied", Dd.sumsB2Lied);
  sol += arr32("rowStartProof", Dd.rowStart.proof) + arr32("rowEndProof", Dd.rowEnd.proof) + arr32("chunkProof", Dd.chunk.proof) + bytesFn("chunkRecords", Dd.chunk.records);
  sol += openFn("selfOpening", Dd.self) + openFn("preOpening", Dd.pre);
  sol += "}\n";
  fs.writeFileSync(dir + "LifMeshFixtures.sol", sol);
}
