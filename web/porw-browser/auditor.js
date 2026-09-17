// The auditor side of the relay transport: watches a MEP topic for claims, verifies them, samples
// tile openings from the claimant through the relay, and produces the on-chain escalation when a
// check fails or the claimant stays silent (challengeOpening with a deposit forces an on-chain
// answer within OPENING_WINDOW; a missing answer is treated as fraud by the contract).
import * as Vf from "./verifier.js";
import * as V from "./verify.js";
import { hex, unhex } from "./verify.js";
import { topicMep } from "./envelope.js";
import { claimFromJson, openingFromJson } from "./node_service.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
/** PoRWClaimManager.claimIdOf(instance, mepId, epoch) = keccak(abi.encodePacked(address, bytes32, uint64)) */
export const claimIdOf = (addr20, mepId32, epoch) => keccak_256(cat(addr20, mepId32, be64(epoch)));

export class Auditor {
  constructor(client, mep, expectedChallenge, { epoch = 1, samples = 16, timeoutMs = 4000 } = {}) {
    this.client = client; this.mep = mep; this.challenge = expectedChallenge; this.epoch = epoch; this.samples = samples; this.timeoutMs = timeoutMs; this.audits = [];
  }
  watch() { return this.client.subscribe(topicMep(hex(this.mep.mepId)), (env) => { if (env.type === "claim") this.audits.push(this.audit(env)); }); }
  async audit(env) {
    const R = claimFromJson(env.payload); const out = { from: env.from, claimHash: env.payload.claimHash, claim: R.claim, ok: false, verdicts: [], escalation: null };
    const vc = Vf.verifyClaim(R, this.mep, this.challenge); out.claimOk = vc.ok; out.reasons = vc.reasons;
    if (!vc.ok || hex(vc.signer) !== env.from.toLowerCase()) { out.escalation = { kind: "invalid-claim", reasons: vc.reasons }; return out; } // an unsigned/mismatched claim never reaches the chain
    const nTiles = R.claim.coverageBytes / V.TILE_BYTES; const tiles = Vf.sampleTiles(this.challenge, nTiles, this.samples);
    const claimId = hex(claimIdOf(vc.signer, this.mep.mepId, this.epoch));
    let resp; try { resp = await this.client.request(env.from, "open-request", env.mepId, { tiles }, { timeoutMs: this.timeoutMs, responseType: "open-response" }); }
    catch (e) { out.escalation = { kind: "unresponsive", action: "challengeOpening", claimId, tiles, note: "deposit-backed on-chain challenge; the instance answers with respondOpening or is slashed on timeout" }; return out; }
    const openings = (resp.payload.openings || []).map(openingFromJson); const byTile = new Map(openings.map((o) => [o.tileIdx, o]));
    for (const t of tiles) {
      const o = byTile.get(t); if (!o) { out.verdicts.push({ tile: t, verdict: "missing" }); continue; }
      const v = Vf.verifyOpening(o, R.claim, vc.slotSeed, nTiles); out.verdicts.push({ tile: t, verdict: v.verdict, recomputed: v.recomputed, committed: v.committed });
    }
    const bad = out.verdicts.find((v) => v.verdict !== "no_fraud");
    if (bad) { const o = byTile.get(bad.tile); out.escalation = { kind: bad.verdict, action: "challengeOpening+respondOpening", claimId, tileIdx: bad.tile,
      opening: o ? { tileIdx: o.tileIdx, tile: hex(o.tile), sTile: o.sketch, partialsIndex: o.position, partialsProof: o.partialsProof.map(hex), weightsProof: o.weightsProof.map(hex) } : null }; }
    out.ok = !bad; return out;
  }
}
