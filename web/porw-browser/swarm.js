// Deterministic mesh coordination for fly-brain instances ("swarm" without a coordinator).
//
// Every user who loads a MEP is an instance that can take distributed inference tasks.
// The coordination primitive is NOT swarm-intelligence optimization (PSO/ACO) — it is
// verifiable, leaderless assignment: rendezvous (highest-random-weight) hashing over the
// registry of eligible instances, seeded by the epoch beacon. Everyone can compute who is
// assigned to what, so audits and disputes are unambiguous, and every task gets a
// redundancy set of r independent executors whose deterministic results must agree.
//
// Eligibility: an instance hosts the MEP and passed its PoRW residency audit this epoch.
// Weighting: stake (Sybil resistance) — a bonded instance gets `weight` votes; unbonded = 0.
import { keccak_256 } from "@noble/hashes/sha3.js";

const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const u64 = (h) => new DataView(h.buffer, h.byteOffset).getBigUint64(0, false);

/** Rendezvous score of an instance for a task: keccak(beacon ‖ mepId ‖ taskId ‖ address ‖ vote). */
export function score(beacon, mepId, taskId, address, vote) {
  return u64(keccak_256(cat(beacon, mepId, taskId, address, be32(vote))));
}

/**
 * Deterministic redundancy set for a task. `instances`: [{ address(Uint8Array20), weight(int>=0), eligible(bool) }].
 * Returns the r highest-scoring eligible instances (each instance's best vote among its `weight` votes),
 * followed by the remaining eligible instances in score order as the backup queue for stragglers.
 */
export function assign(beacon, mepId, taskId, instances, r) {
  const ranked = instances
    .filter((i) => i.eligible && i.weight > 0)
    .map((i) => { let best = -1n; for (let v = 0; v < i.weight; v++) { const s = score(beacon, mepId, taskId, i.address, v); if (s > best) best = s; } return { i, best }; })
    .sort((a, b) => (a.best > b.best ? -1 : a.best < b.best ? 1 : 0))
    .map((x) => x.i);
  return { executors: ranked.slice(0, r), backups: ranked.slice(r) };
}

/**
 * On-chain-friendly rule (the one the settlement contract implements, O(r) reads):
 *   executor_j = eligibleVotes[ keccak(beacon ‖ mepId ‖ taskId ‖ j) mod |eligibleVotes| ]
 * where eligibleVotes lists each eligible instance `weight` times (stake-weighted sortition),
 * skipping already-chosen instances. The mesh and the contract MUST use the same rule; this
 * is the default. `assign` (rendezvous hashing) is kept as the off-chain-only alternative.
 */
export function assignSortition(beacon, mepId, taskId, instances, r) {
  const votes = []; for (const i of instances) if (i.eligible && i.weight > 0) for (let v = 0; v < i.weight; v++) votes.push(i);
  const chosen = [], seen = new Set();
  for (let j = 0; chosen.length < Math.min(r, new Set(votes).size); j++) {
    const h = keccak_256(cat(beacon, mepId, taskId, be32(j)));
    const i = votes[Number(u64(h) % BigInt(votes.length))]; const key = Array.from(i.address).join(",");
    if (!seen.has(key)) { seen.add(key); chosen.push(i); }
  }
  const backups = [...new Set(votes)].filter((i) => !seen.has(Array.from(i.address).join(",")));
  return { executors: chosen, backups };
}

/** Task id for an inference request: keccak256(abi.encode(Task, nonce)) -- it binds EVERY field of the task,
 *  including `steps` and `commitStride`, which live on the task now. An id that covered only (mep, seed, nonce)
 *  would let anyone squat a client's id with different parameters, and the executors would run those instead.
 *  The Task is a static tuple, so abi.encode lays it out inline: 8 words, then the nonce. */
export const taskId = (t, nonce32) => keccak_256(cat(
  t.mepId, abiU(t.stimulusSeed), abiU(t.steps), abiU(t.commitStride), t.initStateRoot,
  abiU(t.fee), abiU(t.deadline), abiU(t.redundancy), nonce32));
const abiU = (n) => { const o = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; };

/** Auditor set for a claim: the same primitive, keyed on the claim hash instead of a task. */
export const auditors = (beacon, mepId, claimHash, instances, k, exclude) =>
  assign(beacon, mepId, claimHash, instances.filter((i) => !exclude || i.address.some((b, j) => b !== exclude[j])), k).executors;

/** Majority verdict over redundant executors' result digests; disagreement -> dispute set. */
export function settle(results) { // [{ address, digest(Uint8Array32) }]
  const buckets = new Map();
  for (const r of results) { const key = Array.from(r.digest, (b) => b.toString(16).padStart(2, "0")).join(""); (buckets.get(key) || buckets.set(key, []).get(key)).push(r.address); }
  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const [winner, voters] = sorted[0];
  return { agreed: buckets.size === 1, winnerDigest: winner, voters, dissenters: sorted.slice(1).flatMap(([, v]) => v), needsFraudProof: buckets.size > 1 };
}
