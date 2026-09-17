import fs from "node:fs";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import { PorwNode } from "./node.js";
import { makeMep } from "./mep.js";
import * as Vf from "./verifier.js";
import * as V from "./verify.js";
const dir = process.argv[2]; const outJson = process.argv[3] || null;
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
import { synthesizePayload } from "./synth.js";
const female = dir && dir !== "-" ? new Uint8Array(fs.readFileSync(dir + "/female.bin")) : synthesizePayload("flywire-female", 20000, 200000);
const male   = dir && dir !== "-" ? new Uint8Array(fs.readFileSync(dir + "/male.bin"))   : synthesizePayload("male-cns", 16000, 150000);
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const indepModelId = (p) => { const n = Math.floor(p.length / TILE_BYTES); const l = []; for (let t = 0; t < n; t++) l.push(V.weightsLeaf(t, p.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES))); return V.merkleRoot(l); };

// --- node hosts two released brains, each its own MEP ---
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const F = node.loadModel("flywire-female", female, { steps: 3 }), M = node.loadModel("male-cns", male, { steps: 2 });
console.log(`female: ${F.nTiles} tiles mep ${V.hex(F.mep.mepId).slice(0, 14)}… | male: ${M.nTiles} tiles mep ${V.hex(M.mep.mepId).slice(0, 14)}…`);
// the verifier derives both MEPs independently from the public model bytes + published profile params
const mepF = makeMep({ name: "flywire-female", modelId: indepModelId(female), steps: 3 });
const mepM = makeMep({ name: "male-cns", modelId: indepModelId(male), steps: 2 });
check("female MEP id (node) == verifier's independent MEP id", V.eq(F.mep.mepId, mepF.mepId));
check("male MEP id (node) == verifier's independent MEP id", V.eq(M.mep.mepId, mepM.mepId));
check("distinct brains -> distinct model ids and MEP ids", !V.eq(mepF.modelId, mepM.modelId) && !V.eq(mepF.mepId, mepM.mepId));

// --- one challenge, a signed claim per MEP ---
const ch = Vf.freshChallenge();
const rf = node.challenge(mepF.mepId, ch, { stimulusSeed: 1 }), rm = node.challenge(mepM.mepId, ch, { stimulusSeed: 1 });
console.log(`female claim: sketch ${rf.timings.sketchMs.toFixed(1)} ms, commit ${rf.timings.commitMs.toFixed(1)} ms, infer ${rf.timings.inferMs.toFixed(1)} ms`);
const vf = Vf.verifyClaim(rf, mepF, ch), vm = Vf.verifyClaim(rm, mepM, ch);
check("female claim verifies (scheme, mep, model, challenge, hash, signature)", vf.ok);
check("male claim verifies", vm.ok);
check("recovered signer == node address (both)", V.eq(vf.signer, node.key.address) && V.eq(vm.signer, node.key.address));
check("female claim rejected against the male MEP (cross-model rebinding)", !Vf.verifyClaim(rf, mepM, ch).ok);
const bad = { ...rf, signature: Uint8Array.from(rf.signature) }; bad.signature[10] ^= 1;
check("tampered signature rejected", !Vf.verifyClaim(bad, mepF, ch).ok);

// --- sampled openings per MEP ---
for (const [tag, r, mep, v, st] of [["female", rf, mepF, vf, F], ["male", rm, mepM, vm, M]]) {
  const sample = Vf.sampleTiles(ch, st.nTiles, 16);
  const res = sample.map((t) => Vf.verifyOpening(node.open(mep.mepId, t), r.claim, v.slotSeed, st.nTiles));
  check(`${tag}: ${sample.length} sampled openings verify, recomputed sketch == committed`, res.every((x) => x.verdict === "no_fraud"));
}
// --- redundant re-execution per MEP (another node recomputes the deterministic inference) ---
check("female: redundant re-execution digest matches claim", Vf.reexecute(await loadKernelFromBytes(wasm), female, rf.claim, mepF).matches);
check("male: redundant re-execution digest matches claim", Vf.reexecute(await loadKernelFromBytes(wasm), male, rm.claim, mepM).matches);
check("re-executing female claim with the male MEP's steps does NOT match", !Vf.reexecute(await loadKernelFromBytes(wasm), female, rf.claim, mepM).matches);

// --- fraud: a lie in one tile of one MEP is caught by that MEP's audit only ---
const liar = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "22".repeat(32) });
const LF = liar.loadModel("flywire-female", female, { steps: 3 }); liar.lies.set(`${V.hex(LF.mep.mepId)}:7`, 12345);
const lr = liar.challenge(LF.mep.mepId, ch, { stimulusSeed: 1 }); const lv = Vf.verifyClaim(lr, mepF, ch);
check("liar's claim is well-formed and signed (fraud not visible from the claim alone)", lv.ok);
const lo = Vf.verifyOpening(liar.open(LF.mep.mepId, 7), lr.claim, lv.slotSeed, LF.nTiles);
check(`opening of lied tile -> '${lo.verdict}'`, lo.verdict === "fraud" && lo.weightsOk && lo.partialsOk);
check("liar's honest tile -> no_fraud", Vf.verifyOpening(liar.open(LF.mep.mepId, 3), lr.claim, lv.slotSeed, LF.nTiles).verdict === "no_fraud");
const o = node.open(mepF.mepId, 5); o.tile = Uint8Array.from(o.tile); o.tile[0] ^= 0xff;
check("forged tile bytes -> 'invalid'", Vf.verifyOpening(o, rf.claim, vf.slotSeed, F.nTiles).verdict === "invalid");

// --- artifact for the on-chain (forge) test ---
const c = rf.claim;
if (outJson) fs.writeFileSync(outJson, JSON.stringify({ schemeDigest: V.hex(c.schemeDigest), mepId: V.hex(c.mepId), modelId: V.hex(c.modelId), partialsRoot: V.hex(c.partialsRoot),
  coverageBytes: c.coverageBytes, challenge: V.hex(c.challenge), deviceId: V.hex(c.deviceId), execDigest: V.hex(c.execDigest), stimulusSeed: c.stimulusSeed,
  mep: { name: mepF.name, execKind: V.hex(mepF.execKind), steps: mepF.steps, clampQ16: mepF.clampQ16 },
  claimHash: V.hex(rf.claimHash), signature: V.hex(rf.signature), signer: V.hex(rf.address) }, null, 2));
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
