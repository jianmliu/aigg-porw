// Model Execution Profiles for the browser node. One MEP per released fly brain
// (e.g. the female FlyWire adult brain, the male CNS): a content-addressed model
// (model_id = weights root) plus the pinned PoRW scheme and the deterministic
// execution parameters other nodes must use to re-execute and cross-audit.
//
// mep_id = keccak256(abi.encodePacked(
//   bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 steps, uint32 clampQ16))
import { keccak_256 } from "@noble/hashes/sha3.js";
import { schemeDigest } from "./verify.js";

export const EXEC_INT_SPMV_Q16 = keccak_256(new TextEncoder().encode("aigg:exec:int-spmv-q16:v1"));
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// For `aigg:exec:int-lif:v1` the execKind digest already pins the LIF parameter set (lif.js); the
// fifth field is the COMMIT STRIDE (state roots every `commitStride` steps and at the last step;
// execRoot = merkle(segment roots)). Same mep_id encoding, same contracts, for both execution kinds.
export function makeMep({ name, modelId, steps, clampQ16 = 65536, execKind = EXEC_INT_SPMV_Q16, commitStride = 10 }) {
  const isSpmv = execKind === EXEC_INT_SPMV_Q16;
  const m = { name, schemeDigest: schemeDigest(), modelId, execKind, steps, clampQ16: isSpmv ? clampQ16 : commitStride, commitStride: isSpmv ? 1 : commitStride };
  m.mepId = keccak_256(cat(m.schemeDigest, m.modelId, m.execKind, be32(m.steps), be32(m.clampQ16)));
  return m;
}
