// Stage-1 relay transport: signed envelopes, multi-relay fan-out with dedupe, audits and tasks over
// the relay, invalid envelopes dropped, censoring relays tolerated, and the on-chain fallback.
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import { keypair, recoverAddress } from "./claim.js";
import { makeMep } from "./mep.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { seal, verifyEnvelope, canonical, topicMep } from "./envelope.js";
import { NodeService, openingFromJson, claimToJson, resultSigningHash } from "./node_service.js";
import * as E from "./eip712.js";
import { domains, walletAndSession } from "./export_fixtures_common.js";
import { Auditor } from "./auditor.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const payload = synthesizePayload("relay-test", 6000, 60000); const steps = 2; const challenge = new Uint8Array(32).fill(0x42);
import { decodeHeader } from "./model.js";
const prof = V.profileOf(payload, decodeHeader(payload)); const nTiles = prof.tiles;
const mep = makeMep({ name: "relay-test", ...prof }); const mepHex = V.hex(mep.mepId);
const A = keypair("0x" + "11".repeat(32)), U = keypair("0x" + "44".repeat(32)), C = keypair("0x" + "55".repeat(32)), U2 = keypair("0x" + "66".repeat(32)), U3 = keypair("0x" + "77".repeat(32)), Lk = keypair("0x" + "33".repeat(32));
const aHex = V.hex(A.address);

// ---- envelope ----
{ const env = seal("claim", mepHex, { b: 1, a: [1, { z: 2, y: 3 }] }, A); check("envelope verifies and recovers the signer", verifyEnvelope(env) === aHex);
  const reord = { ...env, payload: { a: [1, { y: 3, z: 2 }], b: 1 } }; check("canonical JSON: key order does not matter", verifyEnvelope(reord) === aHex && canonical(env.payload) === canonical(reord.payload));
  const t = { ...env, payload: { ...env.payload, b: 2 } }; check("tampered payload rejected", verifyEnvelope(t) === null);
  const f = { ...env, from: V.hex(U.address) }; check("wrong sender rejected", verifyEnvelope(f) === null);
  const old = seal("claim", mepHex, {}, A, Date.now() - 3600e3); check("stale envelope rejected", verifyEnvelope(old) === null);
  check("garbage never throws", verifyEnvelope(null) === null && verifyEnvelope({ type: "x" }) === null && verifyEnvelope({ ...env, sig: "0x00" }) === null); }

// ---- relays: two honest, one that censors instance A ----
const R1 = await startRelay({ name: "r1" }), R2 = await startRelay({ name: "r2" }), R3 = await startRelay({ name: "r3-censor", censor: (from) => from === aHex });
// instance A: fans out to r1 + r2 (+ r3, which drops it)
// instance A = wallet WA (bonded) + delegated session key 0x11.. (the tab); claims/results are EIP-712 typed data
const wsA = await walletAndSession("1a", "11");
const nodeA = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32), domains, delegation: wsA.delegation }); await nodeA.loadModel("relay-test", payload, { maxSteps: steps });
const cA = new RelayClient([R1.url, R2.url, R3.url], A); check(`instance connects to ${await cA.connect()} relays`, cA.socks.filter((s) => s.open).length === 3);
const svc = new NodeService(nodeA, cA); svc.serve(mep.mepId);
// auditor U on r1 + r2
const cU = new RelayClient([R1.url, R2.url], U); await cU.connect(); const aud = new Auditor(cU, mep, challenge, { samples: 16, timeoutMs: 3000, domain: domains.claimManager, blockNumber: 100 }); aud.watch();
const { r: rA } = await svc.announce(mep.mepId, challenge);
await sleep(300); check("auditor received the claim exactly once (deduped across relays)", aud.audits.length === 1 && cU.duplicates >= 1);
const a1 = await aud.audits[0];
check(`claim verified; ${a1.verdicts.length} sampled openings over the relay all no_fraud`, a1.claimOk && a1.ok && a1.verdicts.length === 16 && a1.verdicts.every((v) => v.verdict === "no_fraud"));
check("EIP-712 claim signed by the session key resolves to the bonded wallet (claimId keyed by the wallet)", a1.from === aHex && a1.instance === wsA.wallet.address.toLowerCase());
check("relay r3 censored the instance's traffic; r1/r2 forwarded it", R3.stats.censored > 0 && R1.stats.forwarded > 0 && R2.stats.forwarded > 0);

// ---- a residency liar is caught through the relay and escalated with on-chain calldata ----
const wsL = await walletAndSession("3a", "33");
const nodeL = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "33".repeat(32), domains, delegation: wsL.delegation }); await nodeL.loadModel("relay-test", payload, { maxSteps: steps });
const liedTile = Vf.sampleTiles(challenge, nTiles, 16)[3]; nodeL.lies.set(`${mepHex}:${liedTile}`, 777);
const cL = new RelayClient([R1.url], Lk); await cL.connect(); const svcL = new NodeService(nodeL, cL); svcL.serve(mep.mepId);
await svcL.announce(mep.mepId, challenge); await sleep(300); const a2 = await aud.audits[1];
check(`liar's claim verifies but the sampled lied tile ${liedTile} is fraud`, a2.claimOk && !a2.ok && a2.verdicts.find((v) => v.tile === liedTile)?.verdict === "fraud" && a2.verdicts.filter((v) => v.verdict === "fraud").length === 1);
{ const e = a2.escalation; const o = openingFromJson({ ...e.opening, position: e.opening.partialsIndex, sketch: e.opening.sTile });
  check("escalation carries claimId + the exact respondOpening struct (verifies as fraud independently)", e?.kind === "fraud" && e.claimId.length === 66 && Vf.verifyOpening(o, a2.claim, V.slotSeed(challenge, a2.claim.deviceId), nTiles).verdict === "fraud"); }

// ---- invalid envelopes are dropped by the relay and by clients ----
{ const raw = new WebSocket(R1.url); await new Promise((r) => (raw.onopen = r)); const errs = []; raw.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.op === "err") errs.push(m.reason); };
  const env = seal("claim", mepHex, { x: 1 }, U); env.payload.x = 2; raw.send(JSON.stringify({ op: "pub", topic: topicMep(mepHex), env })); await sleep(200);
  check("relay rejects a tampered envelope", errs.includes("bad envelope") && R1.stats.dropped >= 1); raw.close(); }
{ const before = aud.audits.length; const cX = new RelayClient([R1.url], U2); await cX.connect(); // forge a frame through a trusted-looking path: client-side verification still guards
  cX.subscribe(topicMep(mepHex), () => {}); const env = seal("claim", mepHex, { forged: true }, U2); env.from = aHex; // claims to be A
  for (const s of cX.socks) s.ws.send(JSON.stringify({ op: "pub", topic: topicMep(mepHex), env })); await sleep(200);
  check("a spoofed sender never reaches the auditor", aud.audits.length === before); cX.close(); }

// ---- censorship: one censoring relay is tolerated; all-censoring relays trigger the on-chain fallback ----
const cU2 = new RelayClient([R3.url, R2.url], U2); await cU2.connect(); const aud2 = new Auditor(cU2, mep, challenge, { samples: 8, timeoutMs: 3000, domain: domains.claimManager, blockNumber: 100 }); aud2.watch();
await svc.announce(mep.mepId, challenge); await sleep(300);
check("auditor behind a censoring relay + an honest one still audits A", aud2.audits.length === 1 && (await aud2.audits[0]).ok);
const cU3 = new RelayClient([R3.url], U3); await cU3.connect(); const aud3 = new Auditor(cU3, mep, challenge, { samples: 8, timeoutMs: 800, domain: domains.claimManager, blockNumber: 100 }); aud3.watch();
await svc.announce(mep.mepId, challenge); await sleep(300);
check("auditor behind only the censoring relay never sees A's claim", aud3.audits.length === 0);
{ const cArel = new RelayClient([R3.url], A); await cArel.connect(); // A reachable only through the censor: the auditor's direct request times out
  const claimEnv = seal("claim", mepHex, claimToJson(rA), A); const fake = await aud3.audit(claimEnv);
  check("unresponsive instance -> escalation = deposit-backed challengeOpening (forces an on-chain answer)", fake.escalation?.kind === "unresponsive" && fake.escalation.action === "challengeOpening" && fake.escalation.tiles.length === 8);
  const fb = svc.onchainOpening(mep.mepId, fake.escalation.tiles[0]); const v = Vf.verifyOpening({ tileIdx: fb.tileIdx, position: fb.partialsIndex, tile: V.unhex(fb.tile), sketch: fb.sTile, partialsProof: fb.partialsProof.map(V.unhex), weightsProof: fb.weightsProof.map(V.unhex) }, rA.claim, V.slotSeed(challenge, nodeA.deviceId), nTiles);
  check("the censored instance answers on-chain itself: respondOpening struct verifies no_fraud (relays bypassed)", v.verdict === "no_fraud"); cArel.close(); }

// ---- a task over the relay: announce -> signed result (valid for TaskMarket.submitResult) ----
const cC = new RelayClient([R2.url], C); await cC.connect();
const taskId = new Uint8Array(32).fill(0x77); const resp = await cC.request(aHex, "task-announce", mepHex, { taskId: V.hex(taskId), stimulusSeed: 9, steps, commitStride: 1 }, { timeoutMs: 8000, responseType: "result" });
const rp = resp.payload; const h = resultSigningHash(domains.market, taskId, V.unhex(rp.execDigest), V.unhex(rp.execRoot));
check("result envelope from A; EIP-712 signature recovers the session key over TaskMarket.resultDigest, delegation -> wallet", resp.from === aHex && V.eq(recoverAddress(h, V.unhex(rp.signature)), A.address) && E.verifyDelegation(domains.registry, rp.delegation, aHex, 100) === wsA.wallet.address.toLowerCase());
const re = Vf.reexecute(await loadKernelFromBytes(wasm), payload, { stimulusSeed: 9, steps, execDigest: V.unhex(rp.execDigest) }); check("client re-executes the task and matches the relayed execDigest", re.matches);
console.log(`relay stats: r1 ${JSON.stringify(R1.stats)} | r2 ${JSON.stringify(R2.stats)} | r3(censor) ${JSON.stringify(R3.stats)} | auditor U: received ${cU.received}, duplicates ${cU.duplicates}, rejected ${cU.rejected}`);
for (const c of [cA, cU, cL, cU2, cU3, cC]) c.close(); await Promise.all([R1.close(), R2.close(), R3.close()]);
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
