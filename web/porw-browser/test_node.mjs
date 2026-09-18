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
import { decodeHeader } from "./model.js";
const indepProfile = (p) => V.profileOf(p, decodeHeader(p)); // model id + CSR roots from the public bytes alone

// --- node hosts two released brains, each its own MEP ---
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const F = await node.loadModel("flywire-female", female, { maxSteps: 3 }), M = await node.loadModel("male-cns", male, { maxSteps: 2 });
console.log(`female: ${F.nTiles} tiles mep ${V.hex(F.mep.mepId).slice(0, 14)}… | male: ${M.nTiles} tiles mep ${V.hex(M.mep.mepId).slice(0, 14)}…`);
// the verifier derives both MEPs independently from the public model bytes alone: under
// sketch-tile-keccak:v2 every field of mep_id is a function of those bytes and the exec kind
const mepF = makeMep({ name: "flywire-female", ...indepProfile(female) });
const mepM = makeMep({ name: "male-cns", ...indepProfile(male) });
check("female MEP id (node) == verifier's independent MEP id", V.eq(F.mep.mepId, mepF.mepId));
check("male MEP id (node) == verifier's independent MEP id", V.eq(M.mep.mepId, mepM.mepId));
check("distinct brains -> distinct model ids and MEP ids", !V.eq(mepF.modelId, mepM.modelId) && !V.eq(mepF.mepId, mepM.mepId));

// --- one challenge, a signed claim per MEP ---
const ch = Vf.freshChallenge();
const rf = await node.challenge(mepF.mepId, ch, { steps: 3, stimulusSeed: 1 }), rm = await node.challenge(mepM.mepId, ch, { steps: 2, stimulusSeed: 1 });
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
const runF = { stimulusSeed: 1, steps: 3, execDigest: rf.result.execDigest }, runM = { stimulusSeed: 1, steps: 2, execDigest: rm.result.execDigest };
check("female: redundant re-execution digest matches the task result", Vf.reexecute(await loadKernelFromBytes(wasm), female, runF).matches);
check("male: redundant re-execution digest matches the task result", Vf.reexecute(await loadKernelFromBytes(wasm), male, runM).matches);
check("re-executing the female run with a different step count does NOT match", !Vf.reexecute(await loadKernelFromBytes(wasm), female, { ...runF, steps: 2 }).matches);
check("a residency claim carries no execution artifact", !("execDigest" in rf.claim) && !("stimulusSeed" in rf.claim));

// --- fraud: a lie in one tile of one MEP is caught by that MEP's audit only ---
const liar = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "22".repeat(32) });
const LF = await liar.loadModel("flywire-female", female, { maxSteps: 3 }); liar.lies.set(`${V.hex(LF.mep.mepId)}:7`, 12345);
const lr = await liar.challenge(LF.mep.mepId, ch, { steps: 3, stimulusSeed: 1 }); const lv = Vf.verifyClaim(lr, mepF, ch);
check("liar's claim is well-formed and signed (fraud not visible from the claim alone)", lv.ok);
const lo = Vf.verifyOpening(liar.open(LF.mep.mepId, 7), lr.claim, lv.slotSeed, LF.nTiles);
check(`opening of lied tile -> '${lo.verdict}'`, lo.verdict === "fraud" && lo.weightsOk && lo.partialsOk);
check("liar's honest tile -> no_fraud", Vf.verifyOpening(liar.open(LF.mep.mepId, 3), lr.claim, lv.slotSeed, LF.nTiles).verdict === "no_fraud");
// --- the sketch seed is the claiming instance's: nothing in a claim can choose it, and one scan serves one identity ---
{ check("two instances holding the same brain commit to different sketches under the same challenge", !V.eq(rf.claim.partialsRoot, lr.claim.partialsRoot) && lv.slotSeed !== Vf.verifyClaim(rf, mepF, ch).slotSeed);
  check("a claim has no device field: the seed is derived from (challenge, resolved instance)", !("deviceId" in rf.claim) && lv.slotSeed === V.slotSeed(ch, lv.instance));
  const honest = Vf.verifyClaim(rf, mepF, ch); const borrowed = Vf.verifyOpening(node.open(mepF.mepId, 3), rf.claim, lv.slotSeed, LF.nTiles);
  check("sketches scanned for one identity do not open under another's seed", Vf.verifyOpening(node.open(mepF.mepId, 3), rf.claim, honest.slotSeed, LF.nTiles).verdict === "no_fraud" && borrowed.verdict === "fraud"); }
const o = node.open(mepF.mepId, 5); o.tile = Uint8Array.from(o.tile); o.tile[0] ^= 0xff;
check("forged tile bytes -> 'invalid'", Vf.verifyOpening(o, rf.claim, vf.slotSeed, F.nTiles).verdict === "invalid");

// --- artifact for the on-chain (forge) test ---
const c = rf.claim;
if (outJson) fs.writeFileSync(outJson, JSON.stringify({ schemeDigest: V.hex(c.schemeDigest), mepId: V.hex(c.mepId), modelId: V.hex(c.modelId), partialsRoot: V.hex(c.partialsRoot),
  coverageBytes: c.coverageBytes, challenge: V.hex(c.challenge),
  mep: { name: mepF.name, execKind: V.hex(mepF.execKind), neurons: mepF.neurons, synapses: mepF.synapses, synapseRoot: V.hex(mepF.synapseRoot) },
  claimHash: V.hex(rf.claimHash), signature: V.hex(rf.signature), signer: V.hex(rf.address) }, null, 2));
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
