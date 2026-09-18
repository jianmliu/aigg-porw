// Model Execution Profiles for the browser node. One MEP per released fly brain
// (e.g. the female FlyWire adult brain, the male CNS): a content-addressed model
// (model_id = weights root) plus the pinned PoRW scheme and the structure every
// other node needs to re-derive the same commitments.
//
// mep_id = keccak256(abi.encodePacked(
//   bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 neurons, uint32 synapses, bytes32 synapseRoot))
//
// Every field is a function of the model bytes and the execution kind, so two nodes that hold the
// same brain derive the same mep_id. Step count and commit stride USED to be in here; they are
// per-task now (ITaskMarket.Task), because the dispute machinery is the only thing that reads them
// and folding them in split one brain's residency set -- its bonds, its claims, its sortition pool --
// across every step count anyone ever wanted to run.
// A profile may be registered under TERMS -- a beneficiary owed `royaltyBps` of every fee settled for a task against
// it (MEPRegistry.registerMEPWithTerms; TaskMarket sets the share aside). The terms wrap the profile id:
//   mep_id = keccak256(abi.encodePacked(bytes32 profileId, address beneficiary, uint16 royaltyBps))
// so a royalty-free profile keeps the id above, and the same brain under other terms is another MEP.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { schemeDigest } from "./verify.js";

export const EXEC_INT_SPMV_Q16 = keccak_256(new TextEncoder().encode("aigg:exec:int-spmv-q16:v1"));
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export function makeMep({ name, modelId, execKind = EXEC_INT_SPMV_Q16, neurons, synapses, synapseRoot }) {
  if (!(neurons > 0 && synapses > 0) || !synapseRoot) throw new Error("mep needs neurons, synapses and synapseRoot");
  const m = { name, schemeDigest: schemeDigest(), modelId, execKind, neurons, synapses, synapseRoot };
  m.mepId = keccak_256(cat(m.schemeDigest, m.modelId, m.execKind, be32(neurons), be32(synapses), synapseRoot));
  return m;
}

const unhex = (h) => { h = h.replace(/^0x/, ""); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(2 * i, 2), 16); return o; };
/** The same profile under terms. `beneficiary`: 20 bytes or 0x-hex; `royaltyBps`: 1..10000. Returns a new MEP object. */
export function withTerms(mep, beneficiary, royaltyBps) {
  const b = typeof beneficiary === "string" ? unhex(beneficiary) : beneficiary;
  if (b.length !== 20 || b.every((x) => x === 0) || !(Number.isInteger(royaltyBps) && royaltyBps > 0 && royaltyBps <= 10000)) throw new Error("terms need a beneficiary and 1..10000 bps");
  const profileId = mep.profileId || mep.mepId; // terms do not nest: they always wrap the profile
  return { ...mep, profileId, beneficiary: b, royaltyBps, mepId: keccak_256(cat(profileId, b, new Uint8Array([royaltyBps >> 8, royaltyBps & 255]))) };
}
