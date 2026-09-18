// Batched tasks in the browser node: one task, many runs of the same brain.
//   node test_batch.mjs
// What is checked: the hashes against the contract's (literals shared with contracts/evm/test/Batch.t.sol); a batch's
// result against an independent recompute; that every run of a batch is the run the single-task path produces; a lie
// in ONE run found by the Run-phase bisection and then prosecuted as that run's ordinary int-lif dispute; and the
// service over a real relay -- a signed batch result, a refusal when the runs are not the task's, named id sets.
import fs from "node:fs";
import { loadKernelFromBytes, treeWidths } from "./porw.js";
import { PorwNode } from "./node.js";
import { NodeService } from "./node_service.js";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { keypair } from "./claim.js";
import { synthesizePayloadV2 } from "./synth.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
import * as B from "./batch.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const hex = V.hex;

// ---- 1. the hashes, against the contract (the same literals are asserted in contracts/evm/test/Batch.t.sol) ----
{ const init = new Uint8Array(32).fill(0xab), root = new Uint8Array(32).fill(0xcd), nonce = new Uint8Array(32).fill(0x11);
  const task = { mepId: new Uint8Array(32).fill(0x22), stimulusSeed: 0, steps: 40, commitStride: 10, initStateRoot: new Uint8Array(32).fill(0x33), fee: 10n ** 18n, deadline: 10000000n, redundancy: 2 };
  const got = { runLeaf: hex(B.runLeaf(613, 7, init)), runResultLeaf: hex(B.runResultLeaf(613, root)), batchDigest: hex(B.batchDigest(root)), batchId: hex(B.batchId(task, 1000, nonce)) };
  if (process.argv.includes("--vectors")) console.log(JSON.stringify(got, null, 1));
  const want = JSON.parse(fs.readFileSync(new URL("./batch_vectors.json", import.meta.url)));
  for (const k of Object.keys(want)) check(`${k} == the contract's`, got[k] === want[k]); }

// ---- 2. a node executes a batch ----
const N = 3000, STEPS = 40, STRIDE = 10; const payload = synthesizePayloadV2("lif-batch", N, 90000);
const stimA = Uint32Array.from({ length: 300 }, (_, j) => j * 7), stimB = Uint32Array.from({ length: 200 }, (_, j) => 5 + j * 11), silence = Uint32Array.from([40, 41, 42, 900, 1500]);
const RUNS = [{ stimulusSeed: 5, stimulusIds: stimA }, { stimulusSeed: 6, stimulusIds: stimA }, { stimulusSeed: 5, stimulusIds: stimA, silenceIds: silence }, { stimulusSeed: 9, stimulusIds: stimB }, { stimulusSeed: 9, stimulusIds: stimB, silenceIds: silence }];
const mk = async (priv, lie) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + priv.repeat(32) }); if (lie) nd.batchLie = lie; const st = await nd.loadModel("lif-batch", payload, { maxSteps: STEPS }); return { nd, st, mep: st.mep.mepId }; };
const A = await mk("11"); const rA = await A.nd.executeBatch(A.mep, { steps: STEPS, commitStride: STRIDE, runs: RUNS });
check(`a batch of ${RUNS.length} runs: one result, its digest a function of its root`, rA.runs.length === RUNS.length && hex(rA.result.execDigest) === hex(B.batchDigest(rA.result.execRoot)));
{ const leaves = rA.runs.map((r, k) => B.runResultLeaf(k, r.execRoot)), inputs = rA.runs.map((r, k) => B.runLeaf(k, RUNS[k].stimulusSeed, r.initStateRoot));
  check("execRoot and the runs root recompute independently", hex(V.merkleRoot(leaves)) === hex(rA.result.execRoot) && hex(V.merkleRoot(inputs)) === hex(rA.result.initStateRoot)); }
{ const S = await mk("22"); let same = true; for (const k of [0, 2, 4]) { const x = await S.nd.execute(S.mep, { steps: STEPS, commitStride: STRIDE, ...RUNS[k] }); same &&= hex(x.result.execRoot) === hex(rA.runs[k].execRoot) && hex(x.result.initStateRoot) === hex(rA.runs[k].initStateRoot) && hex(x.result.execDigest) === hex(rA.runs[k].countsDigest); }
  check("every run of a batch is the run the single-task path produces (root, state_0 root, counts digest)", same); }
check("the silence set and the seed each make another run", new Set(rA.runs.map((r) => hex(r.execRoot))).size === RUNS.length && hex(rA.runs[0].initStateRoot) === hex(rA.runs[1].initStateRoot) && hex(rA.runs[0].initStateRoot) !== hex(rA.runs[2].initStateRoot));
{ const k = 3, o = await A.nd.batchOpenRun(A.mep, k); check("a client checks one run of a settled batch against its execRoot, and a wrong root fails", B.verifyRunResult(rA.result.execRoot, RUNS.length, k, o.execRoot, o.resultProof) && !B.verifyRunResult(rA.result.execRoot, RUNS.length, k, rA.runs[0].execRoot, o.resultProof)); }

// ---- 3. a lie in ONE run: found by the Run phase, prosecuted as that run's dispute ----
{ const STAR = 3, sLie = 23; const L = await mk("33", { run: STAR, lie: { step: sLie, neuron: 1234, delta: 5000 } }); const rL = await L.nd.executeBatch(L.mep, { steps: STEPS, commitStride: STRIDE, runs: RUNS });
  check("the liar's batch differs in its root, and only in run " + STAR, hex(rL.result.execRoot) !== hex(rA.result.execRoot) && rL.runs.every((r, k) => (hex(r.execRoot) === hex(rA.runs[k].execRoot)) === (k !== STAR)));
  const bis = B.bisectRuns(rA.runs.map((r, k) => B.runResultLeaf(k, r.execRoot)), rL.runs.map((r, k) => B.runResultLeaf(k, r.execRoot)));
  check(`the run bisection walks ${bis.rounds.length} rounds to run ${bis.run}`, bis.run === STAR && bis.rounds.length === treeWidths(RUNS.length).length - 1);
  check("and posts what each node would post (batchNode)", bis.rounds.every((r) => hex(A.nd.batchNode(A.mep, r.level, r.idx)[0]) === hex(r.pairA[0]) && hex(L.nd.batchNode(L.mep, r.level, r.idx)[1]) === hex(r.pairB[1])));
  const oA = await A.nd.batchOpenRun(A.mep, STAR), oL = await L.nd.batchOpenRun(L.mep, STAR);
  check("both open the same input against the runs root, and different results", hex(oA.initStateRoot) === hex(oL.initStateRoot) && oA.seed === oL.seed && V.merkleVerifyCounted(rA.result.initStateRoot, B.runLeaf(STAR, oA.seed, oA.initStateRoot), STAR, RUNS.length, oA.inputProof) && hex(oA.execRoot) !== hex(oL.execRoot));
  // from here it is an ordinary int-lif dispute over run STAR: the helpers answer for the reopened run
  const segA = oA.result.actRoots, segL = oL.result.actRoots; // the reopened run's own result: what a single task's dispute starts from
  check("the reopened run's result is the run's, not the batch's", hex(oA.result.execRoot) === hex(oA.execRoot) && hex(oL.result.execRoot) === hex(oL.execRoot));
  const seg = D.firstDifferingStep(segA, segL) - 1; check(`the reopened run's segment roots first differ in segment ${seg}, the one holding step ${sLie}`, seg === Math.floor((sLie - 1) / STRIDE));
  const stA = (await A.nd.lifSegmentRoots(A.mep, seg)).roots, stL = (await L.nd.lifSegmentRoots(L.mep, seg)).roots; let j = 0; while (j < stA.length && hex(stA[j]) === hex(stL[j])) j++;
  check(`and its step roots first differ at step ${seg * STRIDE + j + 1}: the step that was lied about`, seg * STRIDE + j + 1 === sLie);
  check("each chain of step roots ends at the segment root that party committed", hex(stA.at(-1)) === hex(segA[seg]) && hex(stL.at(-1)) === hex(segL[seg])); }

// ---- 4. the service, over a real relay ----
{ const R = await startRelay({ name: "r" }); const S = await mk("44"); const cS = new RelayClient([R.url], S.nd.key); await cS.connect(); const svc = new NodeService(S.nd, cS, {}); svc.serve(S.mep);
  const cli = new RelayClient([R.url], keypair("0x" + "55".repeat(32))); await cli.connect(); const to = hex(S.nd.key.address), mepHex = hex(S.mep);
  const sets = { a: [...stimA], b: [...stimB], quiet: [...silence] };
  const runs = [{ stimulusSeed: 5, stimulusSet: "a" }, { stimulusSeed: 6, stimulusSet: "a" }, { stimulusSeed: 5, stimulusSet: "a", silenceSet: "quiet" }, { stimulusSeed: 9, stimulusSet: "b" }, { stimulusSeed: 9, stimulusIds: [...stimB], silenceIds: [...silence] }];
  const base = { taskId: "0x" + "ab".repeat(32), steps: STEPS, commitStride: STRIDE, sets, runs };
  const ok = await cli.request(to, "batch-announce", mepHex, { ...base, initStateRoot: hex(rA.result.initStateRoot) }, { timeoutMs: 60000, responseType: "result" });
  check("announced with named sets, the node signs the batch the direct path produced", ok.payload.execRoot === hex(rA.result.execRoot) && ok.payload.execDigest === hex(rA.result.execDigest) && ok.payload.runs.length === RUNS.length && ok.payload.runs[2].execRoot === hex(rA.runs[2].execRoot));
  let refusal = null; try { await cli.request(to, "batch-announce", mepHex, { ...base, runs: runs.slice(0, 4), initStateRoot: hex(rA.result.initStateRoot) }, { timeoutMs: 60000, responseType: "result" }); } catch (e) { refusal = e; }
  check("runs that are not the task's are refused, and the requester hears why instead of timing out", refusal && refusal.refused && /initStateRoot/.test(refusal.refused.reason));
  refusal = null; try { await cli.request(to, "batch-announce", mepHex, { ...base, runs: [{ stimulusSeed: 1, stimulusSet: "nope" }, { stimulusSeed: 2, stimulusSet: "a" }] }, { timeoutMs: 60000, responseType: "result" }); } catch (e) { refusal = e; }
  check("so is a run naming a set the announcement does not carry", refusal && /does not carry: nope/.test(refusal.message));
  check(`the service counted ${svc.served.runs} runs in ${svc.served.tasks} batch, ${svc.served.refused} refused`, svc.served.tasks === 1 && svc.served.runs === RUNS.length && svc.served.refused === 1);
  cli.close(); cS.close(); await R.close?.(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
