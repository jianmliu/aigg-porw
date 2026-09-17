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

export function verifyClaim(resp, mep, expectedChallenge) {
  const c = resp.claim, r = { ok: true, reasons: [] };
  const fail = (m) => { r.ok = false; r.reasons.push(m); };
  if (!V.eq(c.schemeDigest, mep.schemeDigest)) fail("scheme digest");
  if (!V.eq(c.mepId, mep.mepId)) fail("mep id");
  if (!V.eq(c.modelId, mep.modelId)) fail("model id");
  if (!V.eq(c.challenge, expectedChallenge)) fail("challenge");
  if (!V.eq(claimHash(c), resp.claimHash)) fail("claim hash");
  let addr = null;
  try { addr = recoverAddress(resp.claimHash, resp.signature); } catch { addr = null; } // malformed signature == invalid, never a crash
  if (!addr || !V.eq(addr, resp.address)) fail("signature");
  r.signer = addr; r.slotSeed = V.slotSeed(c.challenge, c.deviceId);
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

// Redundant re-execution of the claimed inference with the verifier's own kernel + model copy.
export function reexecute(kernel, payloadBytes, claim, mep) {
  const k = attachSpmv(kernel, kernel.exports);
  const bufPtr = k.put(payloadBytes); const hdr = decodeHeader(payloadBytes);
  const act = k.spmvStimulus(hdr.neurons, claim.stimulusSeed);
  k.spmvRun(bufPtr, hdr, act, mep.steps);
  const a = k.u32(act, hdr.neurons);
  const digest = keccak_256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return { digest, matches: V.eq(digest, claim.execDigest) };
}
