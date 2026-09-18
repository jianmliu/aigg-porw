// Verifier / redundant-node side. Uses ONLY the independent noble implementation for the
// cryptographic checks; re-executes the deterministic inference with its own kernel to
// check the claimed execution digest (this is the redundancy model: another node recomputes).
import * as V from "./verify.js";
import { claimHash, recoverAddress } from "./claim.js";
import { decodeHeader, attachSpmv } from "./model.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { TILE_BYTES } from "./porw.js";

export const freshChallenge = () => crypto.getRandomValues(new Uint8Array(32));

export function sampleTiles(challenge32, nTiles, k) {
  const out = new Set();
  for (let i = 0; out.size < Math.min(k, nTiles); i++) {
    const h = keccak_256(new Uint8Array([...challenge32, ...new TextEncoder().encode("audit"), i & 255, (i >> 8) & 255]));
    out.add(Number(new DataView(h.buffer).getBigUint64(0, true) % BigInt(nTiles)));
  }
  return [...out];
}

import { claimDigest, verifyDelegation } from "./eip712.js";
/** `domain`: verify the EIP-712 signature (contract path); otherwise the raw claim hash (JS-only tests).
 *  `delegation` + `blockNumber`: resolve a session-key signer to its bonded instance (r.instance). */
export function verifyClaim(resp, mep, expectedChallenge, { domain = null, blockNumber = 0 } = {}) {
  const c = resp.claim, r = { ok: true, reasons: [] };
  const fail = (m) => { r.ok = false; r.reasons.push(m); };
  if (!V.eq(c.schemeDigest, mep.schemeDigest)) fail("scheme digest");
  if (!V.eq(c.mepId, mep.mepId)) fail("mep id");
  if (!V.eq(c.modelId, mep.modelId)) fail("model id");
  if (!V.eq(c.challenge, expectedChallenge)) fail("challenge");
  if (!V.eq(claimHash(c), resp.claimHash)) fail("claim hash");
  let addr = null;
  try { addr = recoverAddress(domain ? claimDigest(domain, c) : resp.claimHash, resp.signature); } catch { addr = null; } // malformed signature == invalid, never a crash
  if (!addr || !V.eq(addr, resp.address)) fail("signature");
  r.signer = addr; r.instance = addr ? V.hex(addr) : null;
  if (addr && resp.delegation) { const inst = verifyDelegation(resp.delegation.domain || domain, resp.delegation, V.hex(addr), blockNumber); if (!inst) fail("delegation"); r.instance = inst; }
  r.slotSeed = r.instance ? V.slotSeed(c.challenge, r.instance) : null; // seeded by the instance the claim resolves to (the wallet behind a session key)
  return r;
}

export function verifyOpening(o, claim, slotSeed, nTiles) {
  const wl = V.weightsLeaf(o.tileIdx, o.tile);
  const weightsOk = V.merkleVerifyCounted(claim.modelId, wl, o.tileIdx, nTiles, o.weightsProof);
  const pl = V.partialsLeaf(o.tileIdx, o.sketch);
  const partialsOk = V.merkleVerifyCounted(claim.partialsRoot, pl, o.position, nTiles, o.partialsProof);
  const recomputed = V.sketchTile(slotSeed, o.tileIdx, o.tile);
  const verdict = !(weightsOk && partialsOk) ? "invalid" : recomputed === o.sketch ? "no_fraud" : "fraud";
  return { tileIdx: o.tileIdx, weightsOk, partialsOk, recomputed, committed: o.sketch, verdict };
}

// Redundant re-execution of a TASK's inference with the verifier's own kernel + model copy.
// `run` is the task's parameters plus the executor's claimed digest: { stimulusSeed, steps, execDigest }.
// It is deliberately not a residency claim: under sketch-tile-keccak:v2 a claim attests residency only,
// and execution is attested per task by TaskMarket's Result.
export function reexecute(kernel, payloadBytes, run) {
  const k = attachSpmv(kernel, kernel.exports);
  const bufPtr = k.put(payloadBytes); const hdr = decodeHeader(payloadBytes);
  const act = k.spmvStimulus(hdr.neurons, run.stimulusSeed);
  k.spmvRun(bufPtr, hdr, act, run.steps);
  const a = k.u32(act, hdr.neurons);
  const digest = keccak_256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return { digest, matches: V.eq(digest, run.execDigest) };
}

// Redundant re-execution of an `aigg:exec:int-lif:v1` run (no commitments): counts digest must match.
import { countsDigest } from "./lif.js";
export function reexecuteLif(kernel, payloadBytes, run, { stimulusIds = null } = {}) {
  const k = kernel, e = k.exports; const m = k.mark();
  const bufPtr = k.put(payloadBytes); const hdr = decodeHeader(payloadBytes); const n = hdr.neurons;
  if (hdr.version !== 2) throw new Error("int-lif needs a v2 payload");
  let cur = k.alloc(n * 16), nxt = k.alloc(n * 16); const acc = k.alloc(n * 8), counts = k.alloc(n * 4);
  if (stimulusIds) { const p = k.alloc(stimulusIds.length * 4); k.u32(p, stimulusIds.length).set(stimulusIds); if (e.porw_lif_state0_set(cur, n >>> 0, p, stimulusIds.length >>> 0) !== 0) throw new Error("state0"); }
  else e.porw_lif_state0_canonical(cur, n >>> 0, run.stimulusSeed >>> 0);
  for (let s = 1; s <= run.steps; s++) { const rc = e.porw_lif_step(bufPtr + hdr.synOffset, hdr.synapses >>> 0, cur, nxt, acc, n >>> 0, s >>> 0, run.stimulusSeed >>> 0); if (rc !== 0) throw new Error("lif rc=" + rc); [cur, nxt] = [nxt, cur]; }
  e.porw_lif_counts(cur, n >>> 0, counts);
  const c = new Uint32Array(k.u32(counts, n)); const digest = countsDigest(c); k.release(m);
  return { digest, matches: V.eq(digest, run.execDigest), counts: c };
}
