// The instance side of the relay transport: announces its per-epoch claim on the MEP topic, answers
// audit opening requests and task announcements addressed to its inbox, and can always produce the
// on-chain fallback (the exact IPoRWClaimManager.Opening struct) when relays censor it.
import { hex, unhex } from "./verify.js";
import { signHash } from "./claim.js";
import { topicMep } from "./envelope.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { resultDigest } from "./eip712.js";

const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const claimToJson = (r) => { const c = r.claim; return { claim: { schemeDigest: hex(c.schemeDigest), mepId: hex(c.mepId), modelId: hex(c.modelId), partialsRoot: hex(c.partialsRoot), coverageBytes: c.coverageBytes, challenge: hex(c.challenge), deviceId: hex(c.deviceId), execDigest: hex(c.execDigest), stimulusSeed: c.stimulusSeed },
  claimHash: hex(r.claimHash), signature: hex(r.signature), address: hex(r.address), execRoot: hex(r.result.execRoot), delegation: r.delegation || null }; };
export const claimFromJson = (j) => ({ claim: Object.fromEntries(Object.entries(j.claim).map(([k, v]) => [k, typeof v === "string" ? unhex(v) : v])), claimHash: unhex(j.claimHash), signature: unhex(j.signature), address: unhex(j.address), delegation: j.delegation || null });
export const openingToJson = (o) => ({ tileIdx: o.tileIdx, position: o.position, tile: hex(o.tile), sketch: o.sketch, partialsProof: o.partialsProof.map(hex), weightsProof: o.weightsProof.map(hex) });
export const openingFromJson = (o) => ({ ...o, tile: unhex(o.tile), partialsProof: o.partialsProof.map(unhex), weightsProof: o.weightsProof.map(unhex) });
/** raw result hash (JS-only tests); with an EIP-712 domain the node signs TaskMarket.resultDigest instead */
export const resultHash = (taskId32, digest32, root32) => keccak_256(cat(new TextEncoder().encode("porw-result"), taskId32, digest32, root32));
export const resultSigningHash = (domain, taskId32, digest32, root32) => (domain ? resultDigest(domain, taskId32, digest32, root32) : resultHash(taskId32, digest32, root32));

export class NodeService {
  /** `onResult(result)`: called with each signed task result (e.g. to hand it to a gas-sponsoring relayer for TaskMarket.submitResult) */
  constructor(node, client, { maxTilesPerRequest = 64, onResult = null } = {}) { this.node = node; this.client = client; this.maxTiles = maxTilesPerRequest; this.served = { openings: 0, tasks: 0 }; this.unsubs = []; this.onResult = onResult; }
  /** run the epoch challenge for a MEP and announce the signed claim (auditors pick it up on the MEP topic) */
  async announce(mepId, challenge32, { stimulusSeed = 1 } = {}) {
    const r = await this.node.challenge(mepId, challenge32, { stimulusSeed });
    const env = this.client.publish(topicMep(hex(mepId)), "claim", hex(mepId), claimToJson(r));
    return { r, env };
  }
  /** answer audits and tasks for a MEP */
  serve(mepId) {
    const id = hex(mepId);
    this.unsubs.push(this.client.serve("open-request", id, (env) => {
      const tiles = Array.isArray(env.payload.tiles) ? env.payload.tiles.slice(0, this.maxTiles) : [];
      if (env.mepId !== id) return null;
      const st = this.node.models.get(id); if (!st) return null;
      const openings = tiles.filter((t) => Number.isInteger(t) && t >= 0 && t < st.nTiles).map((t) => openingToJson(this.node.open(mepId, t)));
      this.served.openings += openings.length;
      return { type: "open-response", payload: { openings } };
    }));
    this.unsubs.push(this.client.serve("task-announce", id, async (env) => {
      const p = env.payload; if (env.mepId !== id || typeof p.taskId !== "string") return null;
      const ids = Array.isArray(p.stimulusIds) ? Uint32Array.from(p.stimulusIds) : null;
      const r = await this.node.challenge(mepId, unhex(p.taskId), { stimulusSeed: p.stimulusSeed >>> 0, stimulusIds: ids }); // the task id doubles as the (irrelevant) sketch challenge
      const h = resultSigningHash(this.node.domains?.market, unhex(p.taskId), r.result.execDigest, r.result.execRoot);
      this.served.tasks++;
      const result = { taskId: p.taskId, execDigest: hex(r.result.execDigest), execRoot: hex(r.result.execRoot), signature: hex(signHash(h, this.node.key.priv)), signer: hex(this.node.key.address), delegation: this.node.delegation || null };
      if (this.onResult) { try { await this.onResult(result); } catch {} }
      return { type: "result", payload: result };
    }));
  }
  /** on-chain fallback: the exact IPoRWClaimManager.Opening the instance submits itself via respondOpening */
  onchainOpening(mepId, tileIdx) { const o = this.node.open(mepId, tileIdx); return { tileIdx: o.tileIdx, tile: hex(o.tile), sTile: o.sketch, partialsIndex: o.position, partialsProof: o.partialsProof.map(hex), weightsProof: o.weightsProof.map(hex) }; }
  stop() { for (const u of this.unsubs) u(); }
}
