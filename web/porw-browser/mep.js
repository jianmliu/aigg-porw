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
