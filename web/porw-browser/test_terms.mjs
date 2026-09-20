// Serving a profile that was registered under TERMS.
//
// A MEP may carry terms -- a beneficiary owed `royaltyBps` of every fee settled against it -- and then its id is
// keccak(profileId, beneficiary, royaltyBps), NOT the id the payload alone produces. The terms live on-chain and
// nowhere in the bytes, so a node cannot derive them: it has to be told. Until it is, it registers the model under
// the bare profile id while the chain draws tasks under the other one, and every announcement and every execution
// for such a task fails to find a model this node is in fact holding.
//
// That is not hypothetical. It is why an adopted fly could not be hosted: the collection registers each individual
// under its own terms, so the id a host is asked to serve is never the id the payload computes.
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayloadV2 } from "./synth.js";
import { makeMep, withTerms } from "./mep.js";
import { applyDelta, diffPayloads, records, encodePayload } from "./delta.js";
import * as V from "./verify.js";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const hex = V.hex;

const NEURONS = 3000, SYN = 30000;
const BENEFICIARY = "0x6c4e3ebcf8d1ae3fce16f290cd1d839419925164", BPS = 1000;
const payload = synthesizePayloadV2("terms-brain", NEURONS, SYN);

// ---- the same bytes, with and without terms ----
const bare = await new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) })
  .loadModel("terms-brain", payload, { maxSteps: 4, exec: "lif" });
const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "22".repeat(32) });
const st = await nd.loadModel("terms-brain", payload, { maxSteps: 4, exec: "lif", terms: { beneficiary: BENEFICIARY, royaltyBps: BPS } });

check("the profile is unchanged: same model id, same synapse root", hex(st.modelId) === hex(bare.modelId) && hex(st.csr.synapseRoot) === hex(bare.csr.synapseRoot));
check("but the mep id is not the bare one", hex(st.mep.mepId) !== hex(bare.mep.mepId));
const expected = withTerms(makeMep({ name: "terms-brain", modelId: bare.modelId, execKind: bare.mep.execKind, neurons: NEURONS, synapses: SYN, synapseRoot: bare.csr.synapseRoot }), BENEFICIARY, BPS);
check("it is exactly keccak(profileId, beneficiary, royaltyBps)", hex(st.mep.mepId) === hex(expected.mepId), `${hex(st.mep.mepId)} vs ${hex(expected.mepId)}`);
check("and it carries the terms for anyone reading it back", hex(st.mep.profileId) === hex(bare.mep.mepId) && st.mep.royaltyBps === BPS);

// ---- the point of all this: the node answers to the id the chain would draw ----
check("the model is resident UNDER THE TERMS ID, which is what an announcement names", nd.models.has(hex(st.mep.mepId)));
check("and not under the bare id, which nothing on-chain refers to", !nd.models.has(hex(bare.mep.mepId)));
let err = null; try { await nd.execute(bare.mep.mepId, { steps: 1, stimulusSeed: 1 }); } catch (e) { err = String(e.message); }
check("asking it for the bare id is an honest miss", err === "unknown MEP", String(err));
const ran = await nd.execute(st.mep.mepId, { steps: 2, stimulusSeed: 7, commitStride: 1 });
check("a task under the terms id executes", !!ran?.result?.execRoot);

// ---- a delta carries terms the same way: this is how an individual of a collection is served ----
const recs = records(payload); const edited = recs.slice(); for (let i = 0; i < 20; i++) edited[i * 97].w = (i - 10) || 5;
const target = encodePayload(payload, "terms-brain", edited);
const delta = diffPayloads(payload, target);
const fly = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "33".repeat(32) });
const stf = await fly.loadDelta(payload, delta, { maxSteps: 4, exec: "lif", terms: { beneficiary: BENEFICIARY, royaltyBps: BPS } });
const plain = await new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "44".repeat(32) }).loadModel("t", target, { maxSteps: 4, exec: "lif" });
check("base + delta under terms is the target payload's profile", hex(stf.modelId) === hex(plain.modelId));
check("wrapped in the same terms", hex(stf.mep.mepId) === hex(withTerms(plain.mep, BENEFICIARY, BPS).mepId));
check("and resident under that id", fly.models.has(hex(stf.mep.mepId)));

// ---- terms are checked, not taken on faith ----
for (const [what, bad] of [["a zero beneficiary", { beneficiary: "0x" + "00".repeat(20), royaltyBps: BPS }],
                           ["0 bps", { beneficiary: BENEFICIARY, royaltyBps: 0 }],
                           ["more than 100%", { beneficiary: BENEFICIARY, royaltyBps: 10001 }]]) {
  let e = null; const n2 = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "55".repeat(32) });
  try { await n2.loadModel("x", payload, { maxSteps: 2, exec: "lif", terms: bad }); } catch (x) { e = String(x.message); }
  check(`${what} is refused`, /terms need a beneficiary/.test(e || ""), String(e));
}

console.log(fails ? `${fails} FAILURES` : "terms: all checks passed");
process.exit(fails ? 1 : 0);
