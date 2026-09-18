// Aggregated claim path (cheap on chains where one tx per instance per epoch is too expensive, e.g. BSC):
// an UNTRUSTED aggregator collects the epoch's signed claims per MEP over the relay, verifies each
// (claim fields, EIP-712 signature, delegation, epoch challenge), and posts ONE Merkle root per epoch over the
// claims of every MEP it serves (EpochTree: leaves carry their mepId and are sorted by (mepId, instance)), so the
// on-chain cost of the root does not grow with the number of brains (PoRWClaimManager.postEpochRoot). Instances fetch
// their inclusion proof over the relay and materialize their claim only when they need on-chain eligibility
// (tasks) or are challenged. Omission is harmless: an omitted instance falls back to submitClaim.
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
import { hex, unhex } from "./verify.js";
import { topicMep } from "./envelope.js";
import { claimFromJson } from "./node_service.js";

const abiWord = (b) => { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
const be = (n) => { const o = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
/** ClaimLeaf hash = keccak(abi.encode(mepId, instance, partialsRoot, coverageBytes, keccak(signature))) */
export const claimLeafHash = (leaf) => keccak_256(cat(leaf.mepId, abiWord(unhex(leaf.instance)), leaf.partialsRoot, be(leaf.coverageBytes), keccak_256(leaf.signature)));
export const leafOf = (R, instanceHex) => ({ mepId: R.claim.mepId, instance: instanceHex, partialsRoot: R.claim.partialsRoot, coverageBytes: R.claim.coverageBytes, signature: R.signature });
const leafJson = (l) => ({ mepId: hex(l.mepId), instance: l.instance, partialsRoot: hex(l.partialsRoot), coverageBytes: l.coverageBytes, signature: hex(l.signature) });

/** One tree per epoch over the claims collected by several per-MEP aggregators. Leaves sorted by (mepId, instance). */
export class EpochTree {
  constructor(aggregators, epoch) { this.aggregators = aggregators; this.epoch = epoch; this.tree = null; }
  build() {
    const entries = []; for (const A of this.aggregators) { const m = hex(A.mep.mepId); for (const [inst, c] of A.claims) entries.push({ key: m + ":" + inst, leaf: c.leaf }); }
    entries.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)); const leaves = entries.map((e) => claimLeafHash(e.leaf));
    this.tree = { keys: entries.map((e) => e.key), entries, leaves, root: leaves.length ? V.merkleRoot(leaves) : null, count: leaves.length }; return this.tree;
  }
  /** calldata for PoRWClaimManager.postEpochRoot(epoch, root, count) */
  postRootCall() { const t = this.tree || this.build(); return { epoch: this.epoch, root: t.root ? hex(t.root) : null, count: t.count }; }
  /** materializeClaim(epoch, aggregator, index, leaf, proof) arguments for one (MEP, instance), or null */
  proofFor(mepIdHex, instanceHex) {
    const t = this.tree || this.build(); const i = t.keys.indexOf(mepIdHex.toLowerCase() + ":" + instanceHex.toLowerCase()); if (i < 0) return null;
    return { type: "claim-proof", payload: { mepId: mepIdHex.toLowerCase(), epoch: this.epoch, root: hex(t.root), count: t.count, index: i, leaf: leafJson(t.entries[i].leaf), proof: V.merkleProof(t.leaves, i).map(hex) } };
  }
}

export class Aggregator {
  constructor(client, mep, expectedChallenge, { epoch, domain, blockNumber = 0 }) {
    this.client = client; this.mep = mep; this.challenge = expectedChallenge; this.epoch = epoch; this.domain = domain; this.blockNumber = blockNumber;
    this.claims = new Map(); // instance (wallet) hex -> { R, leaf, signer }
    this.rejected = [];
  }
  /** collect claims from the MEP topic; serve inclusion proofs on request */
  watch() {
    const un1 = this.client.subscribe(topicMep(hex(this.mep.mepId)), (env) => { if (env.type === "claim") this.consider(env); });
    const un2 = this.client.serve("claim-proof-request", hex(this.mep.mepId), (env) => this.proofFor(env.payload.instance));
    return () => { un1(); un2(); };
  }
  consider(env) {
    const R = claimFromJson(env.payload); const vc = Vf.verifyClaim(R, this.mep, this.challenge, { domain: this.domain, blockNumber: this.blockNumber });
    if (!vc.ok || hex(vc.signer) !== env.from.toLowerCase()) { this.rejected.push({ from: env.from, reasons: vc.reasons }); return false; }
    if (this.claims.has(vc.instance)) return false; // first valid claim per instance wins
    this.claims.set(vc.instance, { R, leaf: leafOf(R, vc.instance), signer: hex(vc.signer) }); this.tree = null; this._T().tree = null; return true;
  }
  /** a single-MEP aggregator is the one-aggregator case of the epoch tree (leaves sorted by instance address).
   *  An aggregator serving several MEPs sets `epochTree` to the shared tree so proofs come from the posted root. */
  _T() { return this.epochTree || (this._own ||= new EpochTree([this], this.epoch)); }
  build() { const t = this._T().build(); this.tree = { ...t, order: t.entries.map((e) => e.leaf.instance) }; return this.tree; }
  /** calldata for PoRWClaimManager.postEpochRoot */
  postRootCall() { this.build(); return this._T().postRootCall(); }
  /** the instance's materializeClaim arguments (or null if not included) */
  proofFor(instanceHex) { return this._T().proofFor(hex(this.mep.mepId), instanceHex); }
}
/** instance side: verify a received proof against the posted root before spending gas on materializeClaim */
export function verifyClaimProof(p, expectedRootHex) {
  if (expectedRootHex && p.root.toLowerCase() !== expectedRootHex.toLowerCase()) return false;
  const leaf = claimLeafHash({ ...p.leaf, mepId: unhex(p.leaf.mepId), partialsRoot: unhex(p.leaf.partialsRoot), signature: unhex(p.leaf.signature) });
  return V.merkleVerifyCounted(unhex(p.root), leaf, p.index, p.count, p.proof.map(unhex));
}
