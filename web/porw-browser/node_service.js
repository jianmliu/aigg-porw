// The instance side of the relay transport: announces its per-epoch claim on the MEP topic, answers
// audit opening requests and task announcements addressed to its inbox, and can always produce the
// on-chain fallback (the exact IPoRWClaimManager.Opening struct) when relays censor it.
import { hex, unhex } from "./verify.js";
import { signHash } from "./claim.js";
import { topicMep } from "./envelope.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { resultDigest } from "./eip712.js";
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const claimToJson = (r) => { const c = r.claim; return { claim: { schemeDigest: hex(c.schemeDigest), mepId: hex(c.mepId), modelId: hex(c.modelId), partialsRoot: hex(c.partialsRoot), coverageBytes: c.coverageBytes, challenge: hex(c.challenge) },
  claimHash: hex(r.claimHash), signature: hex(r.signature), address: hex(r.address), delegation: r.delegation || null }; };
export const claimFromJson = (j) => ({ claim: Object.fromEntries(Object.entries(j.claim).map(([k, v]) => [k, typeof v === "string" ? unhex(v) : v])), claimHash: unhex(j.claimHash), signature: unhex(j.signature), address: unhex(j.address), delegation: j.delegation || null });
export const openingToJson = (o) => ({ tileIdx: o.tileIdx, position: o.position, tile: hex(o.tile), sketch: o.sketch, partialsProof: o.partialsProof.map(hex), weightsProof: o.weightsProof.map(hex) });
export const openingFromJson = (o) => ({ ...o, tile: unhex(o.tile), partialsProof: o.partialsProof.map(unhex), weightsProof: o.weightsProof.map(unhex) });
/** raw result hash (JS-only tests); with an EIP-712 domain the node signs TaskMarket.resultDigest instead */
export const resultHash = (taskId32, digest32, root32) => keccak_256(cat(new TextEncoder().encode("porw-result"), taskId32, digest32, root32));
export const resultSigningHash = (domain, taskId32, digest32, root32) => (domain ? resultDigest(domain, taskId32, digest32, root32) : resultHash(taskId32, digest32, root32));

export class NodeService {
  /** `onResult(result)`: called with each signed task result (e.g. to hand it to a gas-sponsoring relayer for TaskMarket.submitResult) */
  constructor(node, client, { maxTilesPerRequest = 64, maxRunsPerBatch = 4096, onResult = null } = {}) { this.node = node; this.client = client; this.maxTiles = maxTilesPerRequest; this.maxRuns = maxRunsPerBatch; this.served = { openings: 0, tasks: 0 }; this.unsubs = []; this.onResult = onResult; }
  /** run the epoch challenge for a MEP and announce the signed residency claim (auditors pick it up on the MEP topic) */
  /** A residency claim is the one thing a host does that nobody replies to, and for most of an epoch nothing
   *  depends on it -- so a claim that reaches no aggregator looks exactly like a claim that worked. That is not
   *  hypothetical: a relayer redeploy left a live host announcing into nothing for six epochs, its eligibility
   *  quietly lapsing, with no error at either end. So delivery is checked, and a claim nobody received is treated
   *  as what it is: the connection is dropped and redialled, and the claim is made again on the new one. */
  async announce(mepId, challenge32, { redial = true } = {}) {
    const r = await this.node.residency(mepId, challenge32);
    // Two ways a claim fails to arrive, and they look nothing like each other from here: no socket at all (the
    // publish throws), and a socket to a relay that has nobody subscribed any more (the publish succeeds and is
    // delivered to nobody). Both are "it did not arrive", and both are answered the same way.
    const send = async () => { try { return await this.client.publishTo(topicMep(hex(mepId)), "claim", hex(mepId), claimToJson(r)); }
      catch (e) { return { env: null, delivered: 0, error: e }; } };
    let { env, delivered, error } = await send();
    if (!delivered && redial) {
      await this.client.redial(); // the client replays its subscriptions on the new socket, so serving resumes with it
      ({ env, delivered, error } = await send());
    }
    if (!delivered) throw new Error(`the claim reached no relay${error ? `: ${error.message}` : ": nothing is subscribed to this brain's topic"}`);
    return { r, env, delivered };
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
    // A BATCH (TaskMarket.postBatch): `runs` = [{ stimulusSeed, stimulusIds?, silenceIds? }]. The task's initStateRoot is
    // the root of its runs, which this node can only know after it has built every run's state_0 -- so, as for a single
    // task, it executes what it was told, compares, and refuses to sign a batch whose runs are not the task's.
    this.unsubs.push(this.client.serve("batch-announce", id, async (env) => {
      const p = env.payload; if (env.mepId !== id || typeof p.taskId !== "string" || !Array.isArray(p.runs) || p.runs.length < 2 || p.runs.length > this.maxRuns) return null;
      // runs of a dataset share a handful of id sets, so an announcement may name them once (`sets`: name -> ids) and let a
      // run say `stimulusSet` / `silenceSet`; inline `stimulusIds` / `silenceIds` still work. An unknown name is a refusal.
      const sets = p.sets && typeof p.sets === "object" ? p.sets : {}; let unknown = null;
      const idsOf = (inline, name) => { if (Array.isArray(inline)) return Uint32Array.from(inline); if (name == null) return null; if (!Array.isArray(sets[name])) { unknown = name; return null; } return Uint32Array.from(sets[name]); };
      const runs = p.runs.map((r) => ({ stimulusSeed: r.stimulusSeed >>> 0, stimulusIds: idsOf(r.stimulusIds, r.stimulusSet), silenceIds: idsOf(r.silenceIds, r.silenceSet) }));
      if (unknown !== null) return { type: "result-refused", payload: { taskId: p.taskId, reason: `the announcement names a set it does not carry: ${unknown}` } };
      const r = await this.node.executeBatch(mepId, { steps: (p.steps >>> 0) || 1, commitStride: (p.commitStride >>> 0) || 1, runs });
      if (typeof p.initStateRoot === "string" && hex(r.result.initStateRoot) !== p.initStateRoot.toLowerCase()) { this.served.refused = (this.served.refused || 0) + 1; return { type: "result-refused", payload: { taskId: p.taskId, reason: "the runs do not hash to the task's initStateRoot", built: hex(r.result.initStateRoot) } }; }
      const h = resultSigningHash(this.node.domains?.market, unhex(p.taskId), r.result.execDigest, r.result.execRoot);
      this.served.tasks++; this.served.runs = (this.served.runs || 0) + runs.length;
      // per-run roots go back with the result: they are the dataset's rows, and a client checks any of them against the settled execRoot
      const result = { taskId: p.taskId, execDigest: hex(r.result.execDigest), execRoot: hex(r.result.execRoot), runs: r.runs.map((x) => ({ execRoot: hex(x.execRoot), initStateRoot: hex(x.initStateRoot), countsDigest: hex(x.countsDigest) })),
        signature: hex(signHash(h, this.node.key.priv)), signer: hex(this.node.key.address), delegation: this.node.delegation || null };
      if (this.onResult) { try { await this.onResult(result); } catch {} }
      return { type: "result", payload: result };
    }));
    this.unsubs.push(this.client.serve("task-announce", id, async (env) => {
      const p = env.payload; if (env.mepId !== id || typeof p.taskId !== "string") return null;
      const ids = Array.isArray(p.stimulusIds) ? Uint32Array.from(p.stimulusIds) : null;
      // steps and commitStride are the TASK's: they are no longer pinned by the MEP, so the announcement carries them
      const silence = Array.isArray(p.silenceIds) ? Uint32Array.from(p.silenceIds) : null;
      const r = await this.node.execute(mepId, { steps: (p.steps >>> 0) || 1, commitStride: (p.commitStride >>> 0) || 1, stimulusSeed: p.stimulusSeed >>> 0, stimulusIds: ids, silenceIds: silence });
      // The task on chain commits to state_0 (initStateRoot). If the announcement names it and this node built another
      // one -- a stimulus or silence set it was not told about, or an announcement in a dialect it does not speak --
      // signing the result would be signing a run of a different task. Refuse instead of being slashed for it.
      if (typeof p.initStateRoot === "string" && r.result.initStateRoot && hex(r.result.initStateRoot) !== p.initStateRoot.toLowerCase()) { this.served.refused = (this.served.refused || 0) + 1; return { type: "result-refused", payload: { taskId: p.taskId, reason: "state_0 does not match the task's initStateRoot", built: hex(r.result.initStateRoot) } }; }
      const h = resultSigningHash(this.node.domains?.market, unhex(p.taskId), r.result.execDigest, r.result.execRoot);
      this.served.tasks++;
      const result = { taskId: p.taskId, execDigest: hex(r.result.execDigest), execRoot: hex(r.result.execRoot), signature: hex(signHash(h, this.node.key.priv)), signer: hex(this.node.key.address), delegation: this.node.delegation || null };
      if (this.onResult) { try { await this.onResult(result); } catch {} }
      // An announcement may ask for the run's OUTPUT (`counts: true`): every neuron's spike count, little-endian u32, base64.
      // Nothing new has to be trusted for it -- execDigest is keccak(LE32 n || these bytes), so the client checks the
      // counts against the digest the task settles on. They go back to the asker only: `onResult` is what gets submitted
      // on-chain (a page POSTs it to a relayer as it is), and half a megabyte has no business there. int-lif only.
      if (p.counts === true && r.result.counts) return { type: "result", payload: { ...result, counts: b64(new Uint8Array(r.result.counts.buffer, r.result.counts.byteOffset, r.result.counts.byteLength)), countsEncoding: "u32le-base64" } };
      return { type: "result", payload: result };
    }));
  }
  /** on-chain fallback: the exact IPoRWClaimManager.Opening the instance submits itself via respondOpening */
  onchainOpening(mepId, tileIdx) { const o = this.node.open(mepId, tileIdx); return { tileIdx: o.tileIdx, tile: hex(o.tile), sTile: o.sketch, partialsIndex: o.position, partialsProof: o.partialsProof.map(hex), weightsProof: o.weightsProof.map(hex) }; }
  stop() { for (const u of this.unsubs) u(); }
}
