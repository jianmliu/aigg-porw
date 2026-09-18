// Aggregated claim path (cheap on chains where one tx per instance per epoch is too expensive, e.g. BSC):
// an UNTRUSTED aggregator collects the epoch's signed claims for a MEP over the relay, verifies each
// (claim fields, EIP-712 signature, delegation, epoch challenge), builds one Merkle tree — leaves sorted by
// instance address — and posts a single root on-chain (PoRWClaimManager.postEpochRoot). Instances fetch
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
/** ClaimLeaf hash = keccak(abi.encode(instance, partialsRoot, coverageBytes, deviceId, keccak(signature))) */
export const claimLeafHash = (leaf) => keccak_256(cat(abiWord(unhex(leaf.instance)), leaf.partialsRoot, be(leaf.coverageBytes), leaf.deviceId, keccak_256(leaf.signature)));
export const leafOf = (R, instanceHex) => ({ instance: instanceHex, partialsRoot: R.claim.partialsRoot, coverageBytes: R.claim.coverageBytes, deviceId: R.claim.deviceId, signature: R.signature });

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
    this.claims.set(vc.instance, { R, leaf: leafOf(R, vc.instance), signer: hex(vc.signer) }); this.tree = null; return true;
  }
  /** deterministic tree: leaves sorted by instance address */
  build() {
    const order = [...this.claims.keys()].sort(); const leaves = order.map((a) => claimLeafHash(this.claims.get(a).leaf));
    this.tree = { order, leaves, root: V.merkleRoot(leaves), count: leaves.length }; return this.tree;
  }
  /** calldata for PoRWClaimManager.postEpochRoot */
  postRootCall() { const t = this.tree || this.build(); return { mepId: hex(this.mep.mepId), epoch: this.epoch, root: hex(t.root), count: t.count }; }
  /** the instance's materializeClaim arguments (or null if not included) */
  proofFor(instanceHex) {
    const t = this.tree || this.build(); const i = t.order.indexOf(instanceHex.toLowerCase()); if (i < 0) return null;
    const c = this.claims.get(t.order[i]); const l = c.leaf;
    return { type: "claim-proof", payload: { mepId: hex(this.mep.mepId), epoch: this.epoch, root: hex(t.root), count: t.count, index: i,
      leaf: { instance: l.instance, partialsRoot: hex(l.partialsRoot), coverageBytes: l.coverageBytes, deviceId: hex(l.deviceId), signature: hex(l.signature) },
      proof: V.merkleProof(t.leaves, i).map(hex) } };
  }
}
/** instance side: verify a received proof against the posted root before spending gas on materializeClaim */
export function verifyClaimProof(p, expectedRootHex) {
  if (expectedRootHex && p.root.toLowerCase() !== expectedRootHex.toLowerCase()) return false;
  const leaf = claimLeafHash({ ...p.leaf, partialsRoot: unhex(p.leaf.partialsRoot), deviceId: unhex(p.leaf.deviceId), signature: unhex(p.leaf.signature) });
  return V.merkleVerifyCounted(unhex(p.root), leaf, p.index, p.count, p.proof.map(unhex));
}
