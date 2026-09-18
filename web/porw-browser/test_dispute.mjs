import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import * as V from "./verify.js";
import * as D from "./dispute.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const payload = synthesizePayload("dispute-test", 5000, 60000); const steps = 2, seed = 3; const ch = new Uint8Array(32).fill(7);
const mk = async (priv, lie) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + priv.repeat(32) }); if (lie) nd.execLie = lie; const st = await nd.loadModel("dispute-test", payload, { steps }); const r = await nd.challenge(st.mep.mepId, ch, { stimulusSeed: seed }); return { nd, st, r, mep: st.mep.mepId }; };
const A = await mk("11"), B = await mk("22", { step: 2, neuron: 123, delta: 777 });
const n = A.st.hdr.neurons;
// commitments: execRoot == merkle(actRoots) recomputed with noble from A's activations
const rootsNoble = []; for (let s = 1; s <= steps; s++) { const act = A.nd.activations(A.mep, s); const leaves = []; for (let i = 0; i < n; i++) leaves.push(V.actLeaf(i, act[i])); rootsNoble.push(V.merkleRoot(leaves)); }
check("actRoots (wasm) == noble recompute from activations", rootsNoble.every((r, s) => V.eq(r, A.r.result.actRoots[s])));
check("execRoot == merkle(actRoots)", V.eq(A.r.result.execRoot, V.merkleRoot(A.r.result.actRoots)));
check("synapseRoot == keccak(csrRoot || rowRoot)", V.eq(A.r.result.synapseRoot, V.synapseRootOf(A.r.result.csrRoot, A.r.result.rowRoot)));
check("same model -> same CSR commitments for both executors", V.eq(A.r.result.synapseRoot, B.r.result.synapseRoot));
check("A and B disagree on execDigest and execRoot", !V.eq(A.r.result.execDigest, B.r.result.execDigest) && !V.eq(A.r.result.execRoot, B.r.result.execRoot));
// step
const sStar = D.firstDifferingStep(A.r.result.actRoots, B.r.result.actRoots);
check(`first differing step = 2 (got ${sStar}); step 1 roots agree`, sStar === 2 && V.eq(A.r.result.actRoots[0], B.r.result.actRoots[0]));
// neuron bisection over both parties' act trees
const bis = D.bisectLeaf((l, i) => A.nd.actNode(A.mep, sStar, l, i), (l, i) => B.nd.actNode(B.mep, sStar, l, i), n);
check(`bisection finds the lied neuron 123 in ${bis.rounds.length} rounds (got ${bis.leaf})`, bis.leaf === 123);
const iStar = bis.leaf;
const openings = (P) => ({ claimedAct: P.nd.openActivation(P.mep, sStar, iStar).act, sums: P.nd.partialSums(P.mep, sStar, iStar).sums });
const rowStart = A.nd.openRowStart(A.mep, iStar), rowEnd = A.nd.openRowStart(A.mep, iStar + 1);
const base = { n, nChunks: A.st.csr.nChunks, chunk: A.st.csr.chunk, csrRoot: A.r.result.csrRoot, rowRoot: A.r.result.rowRoot, synapseRoot: A.r.result.synapseRoot,
               prevActRoot: A.r.result.actRoots[sStar - 2], stimulusSeed: seed, step: sStar, i: iStar, rowStart, rowEnd };
// scenario 1: B lied in the activation only -> its own partial sums contradict its claimed act (row check)
{ const pa = openings(A), pb = openings(B);
  const kStar = rowStart.value; const chunkOpen = A.nd.openCsrChunk(A.mep, Math.floor(kStar / base.chunk));
  const v = D.adjudicate({ ...base, chunkOpen, preOpen: null, partyA: pa, partyB: pb });
  check(`scenario 1 (lie in activation): loser = B by row check (${v.reason})`, v.loser === "B" && v.checks.rowA && !v.checks.rowB); }
// scenario 2: B lies consistently in its partial sums from some position -> caught at the single term
{ const pa = openings(A); const pb = openings(B); const len = pb.sums.length; check(`neuron ${iStar} has in-degree ${len} > 2`, len > 2);
  const jLie = Math.floor(len / 2); const lied = pb.sums.slice(); for (let j = jLie; j < len; j++) lied[j] += 777n << 16n; // B's series consistent with its claimed act? claimedAct = min(last>>16) of lied
  const partyB = { claimedAct: V.rowActivation(lied[len - 1]), sums: lied };
  const kStar = rowStart.value + jLie; const chunkOpen = A.nd.openCsrChunk(A.mep, Math.floor(kStar / base.chunk));
  const rec = V.record(chunkOpen.records.subarray((kStar - chunkOpen.k0) * 10, (kStar - chunkOpen.k0) * 10 + 10));
  const preOpen = A.nd.openActivation(A.mep, sStar - 1, rec.pre); // input activation from the agreed previous step (A's tree; roots agree)
  const v = D.adjudicate({ ...base, chunkOpen, preOpen, partyA: pa, partyB });
  check(`scenario 2 (lie in partial sums): loser = B at the divergent term (${v.reason})`, v.loser === "B" && v.checks.kStar === kStar && v.checks.chunkProof && v.checks.preProof !== false);
  // and the honest party is never blamed if roles are swapped
  const v2 = D.adjudicate({ ...base, chunkOpen, preOpen, partyA: partyB, partyB: pa });
  check("swapped roles: still blames the liar", v2.loser === "A"); }
// no dispute between two honest executors
const A2 = await mk("33"); check("two honest executors: no differing step", D.firstDifferingStep(A.r.result.actRoots, A2.r.result.actRoots) === null && V.eq(A.r.result.execRoot, A2.r.result.execRoot));
console.log(`per-slot timings (A, single thread, ${n} neurons): ${JSON.stringify(A.r.timings)}`);
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
