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
import { Aggregator, verifyClaimProof, claimLeafHash, leafOf } from "./aggregator.js";
import { domains, walletAndSession } from "./export_fixtures_common.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const payload = synthesizePayload("agg-test", 4000, 40000); const steps = 2; const challenge = new Uint8Array(32).fill(0x21);
const nT = Math.floor(payload.length / 4096); const lv = []; for (let t = 0; t < nT; t++) lv.push(V.weightsLeaf(t, payload.subarray(t * 4096, (t + 1) * 4096)));
const mep = makeMep({ name: "agg-test", modelId: V.merkleRoot(lv), steps }); const mepHex = V.hex(mep.mepId);
check("noble merkleProof verifies for every leaf (odd count)", (() => { const ls = Array.from({ length: 7 }, (_, i) => V.keccak(new Uint8Array([i]))); const r = V.merkleRoot(ls); return ls.every((l, i) => V.merkleVerifyCounted(r, l, i, ls.length, V.merkleProof(ls, i))); })());
const R = await startRelay({ name: "r" });
// three instances (wallet + session key each), one aggregator, one with a stale challenge
const mk = async (wb, sb) => { const ws = await walletAndSession(wb, sb); const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: ws.sessionPriv, domains, delegation: ws.delegation }); await nd.loadModel("agg-test", payload, { steps }); const c = new RelayClient([R.url], nd.key); await c.connect(); const svc = new NodeService(nd, c); svc.serve(mep.mepId); return { ws, nd, c, svc }; };
const A = await mk("1a", "11"), B = await mk("2a", "22"), C = await mk("3a", "33");
const G = keypair("0x" + "99".repeat(32)); const cG = new RelayClient([R.url], G); await cG.connect();
const agg = new Aggregator(cG, mep, challenge, { epoch: 1, domain: domains.claimManager, blockNumber: 100 }); agg.watch();
await A.svc.announce(mep.mepId, challenge, { stimulusSeed: 1 }); await B.svc.announce(mep.mepId, challenge, { stimulusSeed: 1 });
await C.svc.announce(mep.mepId, new Uint8Array(32).fill(0x22), { stimulusSeed: 1 }); // wrong (stale) challenge
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
for (const x of [A, B, C]) x.c.close(); cG.close(); await R.close();
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
