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
 * The rule the settlement contract implements (TaskMarket._draw / InstanceRegistry.sortitionPick), in constant time per
 * draw: for j = 0, 1, ... let h = keccak(beacon ‖ mepId ‖ taskId ‖ be32(j)) as a 256-bit integer. Its LOW 128 bits pick
 * an ENROLLED instance uniformly -- `instances` is the MEP's enrolment list, in enrolment order, eligible or not -- and
 * its HIGH 128 bits accept it with probability weight / cap; it must be eligible, and not chosen already. At most
 * 64·r draws. `cap` is the chain's `weightCap(mepId)`: the largest weight anybody bonded with while naming the MEP
 * (default: the largest weight in `instances`). Over repeated draws an instance is chosen in proportion to its weight
 * among the eligible ones, which is what walking a vote list gave; the walk read every enrolled instance.
 * The mesh and the contract MUST use the same rule; `assign` (rendezvous hashing) is the off-chain-only alternative.
 */
export function assignSortition(beacon, mepId, taskId, instances, r, { cap } = {}) {
  const len = BigInt(instances.length); const c = BigInt(cap ?? instances.reduce((m, i) => Math.max(m, i.weight), 0));
  const chosen = [], seen = new Set(); const LOW = (1n << 128n) - 1n;
  for (let j = 0; len > 0n && c > 0n && chosen.length < r && j < 64 * r; j++) {
    const hb = keccak_256(cat(beacon, mepId, taskId, be32(j))); let h = 0n; for (const x of hb) h = (h << 8n) | BigInt(x);
    const i = instances[Number((h & LOW) % len)];
    if ((h >> 128n) % c >= BigInt(i.weight) || !i.eligible) continue;
    const key = Array.from(i.address).join(","); if (!seen.has(key)) { seen.add(key); chosen.push(i); }
  }
  const backups = instances.filter((i) => i.eligible && i.weight > 0 && !seen.has(Array.from(i.address).join(",")));
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
