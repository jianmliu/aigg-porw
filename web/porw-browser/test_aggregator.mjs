// Aggregated claims over the relay: the aggregator verifies and batches, an instance fetches its proof,
// and the proof verifies against the root exactly as PoRWClaimManager.materializeClaim will.
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import { keypair } from "./claim.js";
import { makeMep } from "./mep.js";
import * as V from "./verify.js";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { NodeService } from "./node_service.js";
import { Aggregator, EpochTree, verifyClaimProof, claimLeafHash, leafOf } from "./aggregator.js";
import { domains, walletAndSession } from "./export_fixtures_common.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const payload = synthesizePayload("agg-test", 4000, 40000); const steps = 2; const challenge = new Uint8Array(32).fill(0x21);
import { decodeHeader } from "./model.js";
const mep = makeMep({ name: "agg-test", ...V.profileOf(payload, decodeHeader(payload)) }); const mepHex = V.hex(mep.mepId);
check("noble merkleProof verifies for every leaf (odd count)", (() => { const ls = Array.from({ length: 7 }, (_, i) => V.keccak(new Uint8Array([i]))); const r = V.merkleRoot(ls); return ls.every((l, i) => V.merkleVerifyCounted(r, l, i, ls.length, V.merkleProof(ls, i))); })());
const R = await startRelay({ name: "r" });
// three instances (wallet + session key each), one aggregator, one with a stale challenge
const mk = async (wb, sb) => { const ws = await walletAndSession(wb, sb); const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: ws.sessionPriv, domains, delegation: ws.delegation }); await nd.loadModel("agg-test", payload, { maxSteps: steps }); const c = new RelayClient([R.url], nd.key); await c.connect(); const svc = new NodeService(nd, c); svc.serve(mep.mepId); return { ws, nd, c, svc }; };
const A = await mk("1a", "11"), B = await mk("2a", "22"), C = await mk("3a", "33");
const G = keypair("0x" + "99".repeat(32)); const cG = new RelayClient([R.url], G); await cG.connect();
const agg = new Aggregator(cG, mep, challenge, { epoch: 1, domain: domains.claimManager, blockNumber: 100 }); agg.watch();
await A.svc.announce(mep.mepId, challenge); await B.svc.announce(mep.mepId, challenge);
await C.svc.announce(mep.mepId, new Uint8Array(32).fill(0x22)); // wrong (stale) challenge
await sleep(300);
check("aggregator accepted A and B (keyed by wallet), rejected C's stale-challenge claim", agg.claims.size === 2 && agg.claims.has(A.ws.wallet.address.toLowerCase()) && agg.claims.has(B.ws.wallet.address.toLowerCase()) && agg.rejected.length === 1 && agg.rejected[0].reasons.includes("challenge"));
const call = agg.postRootCall(); check(`postEpochRoot calldata: root over ${call.count} leaves sorted by instance`, call.count === 2 && call.root.length === 66 && agg.tree.order[0] < agg.tree.order[1]);
// A fetches its proof over the relay and verifies it before spending gas
const resp = await A.c.request(V.hex(G.address), "claim-proof-request", mepHex, { instance: A.ws.wallet.address }, { timeoutMs: 3000, responseType: "claim-proof" });
check("A's inclusion proof verifies against the posted root (materializeClaim inputs)", verifyClaimProof(resp.payload, call.root) && resp.payload.leaf.instance === A.ws.wallet.address.toLowerCase());
const bad = JSON.parse(JSON.stringify(resp.payload)); bad.leaf.coverageBytes += 4096; check("a modified leaf does not verify", !verifyClaimProof(bad, call.root));
const none = agg.proofFor(C.ws.wallet.address); check("an omitted instance gets no proof (falls back to submitClaim)", none === null);
// determinism: another aggregator seeing the same claims builds the same root
const agg2 = new Aggregator(cG, mep, challenge, { epoch: 1, domain: domains.claimManager, blockNumber: 100 }); for (const [, c] of agg.claims) agg2.claims.set(c.leaf.instance, c);
check("two aggregators with the same claims -> identical root", V.hex(agg2.build().root) === call.root);
// one root per epoch over several MEPs: a second brain's claims join the same tree, the leaf carries its mepId
{ const mep2 = { ...mep, mepId: Uint8Array.from(mep.mepId, (b, i) => (i === 31 ? b ^ 0xff : b)) }; const agg3 = new Aggregator(cG, mep2, challenge, { epoch: 1, domain: domains.claimManager, blockNumber: 100 });
  for (const [k, c] of agg.claims) agg3.claims.set(k, { ...c, leaf: { ...c.leaf, mepId: mep2.mepId } });
  const T = new EpochTree([agg, agg3], 1); const rc = T.postRootCall(); const m1 = V.hex(mep.mepId), m2 = V.hex(mep2.mepId), a = A.ws.wallet.address;
  check(`epoch tree: one root over ${rc.count} leaves of 2 MEPs, sorted by (mepId, instance), calldata has no mepId`, rc.count === 4 && rc.mepId === undefined && rc.epoch === 1 && T.tree.keys.every((k, i) => !i || T.tree.keys[i - 1] < k));
  const p1 = T.proofFor(m1, a), p2 = T.proofFor(m2, a);
  check("the same instance has one proof per MEP against the same root", verifyClaimProof(p1.payload, rc.root) && verifyClaimProof(p2.payload, rc.root) && p1.payload.index !== p2.payload.index && p1.payload.leaf.mepId === m1 && p2.payload.leaf.mepId === m2);
  const swapped = JSON.parse(JSON.stringify(p1.payload)); swapped.leaf.mepId = m2; check("a leaf presented under another MEP does not verify (mepId is inside the leaf hash)", !verifyClaimProof(swapped, rc.root));
  check("a (MEP, instance) the tree lacks gets no proof", T.proofFor(m2, C.ws.wallet.address) === null);
  agg.epochTree = T; check("an aggregator attached to the shared tree serves proofs from the posted root", agg.proofFor(a).payload.root === rc.root && agg.postRootCall().count === 4); }
for (const x of [A, B, C]) x.c.close(); cG.close(); await R.close();
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
