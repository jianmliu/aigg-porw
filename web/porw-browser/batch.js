// Batched tasks (TaskMarket.postBatch): one task, many runs of the same brain.
//
// A batch is a Task whose `initStateRoot` is the root over runLeaf(k, seed_k, initStateRoot_k) and whose
// `stimulusSeed` is 0. A run is its seed and its state_0 -- the stimulus set and the silence set are both inside
// state_0 -- under the task's steps and stride. What an executor commits to for run k is the run's own execRoot and
// nothing else: the batch's execRoot is the root over runResultLeaf(k, execRoot_k), and its execDigest is a function
// of that root. A digest the root does not determine is something two parties can disagree about with no step to
// bisect to, so a batch does not have one.
//
// Everything here mirrors PorwMeshHash (contracts/evm/src/interfaces/PorwMesh.sol) and the Run phase of
// ExecutionDisputes; test_batch.mjs and contracts/evm/test/Batch.t.sol pin the same literals from both sides.
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as V from "./verify.js";
import { taskId } from "./swarm.js";
import { treeWidths } from "./porw.js";

const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const be256 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const TAG = new TextEncoder().encode("aigg:batch:v1");
export const MAX_RUNS = 1 << 16;

export const runLeaf = (k, seed, initStateRoot) => keccak_256(cat(le32(k), le32(seed), initStateRoot));
export const runResultLeaf = (k, execRoot) => keccak_256(cat(le32(k), execRoot));
export const batchDigest = (execRoot) => keccak_256(cat(TAG, execRoot));
/** keccak256(abi.encode(taskId(task, nonce), uint32 runs)): a batch is never the single task with the same fields */
export const batchId = (task, runs, nonce32) => keccak_256(cat(taskId(task, nonce32), be256(runs)));

/** the two trees of a batch, from per-run records { seed, initStateRoot, execRoot } */
export function batchTrees(runs) {
  if (!(runs.length >= 2 && runs.length <= MAX_RUNS)) throw new Error(`a batch has 2..${MAX_RUNS} runs`);
  const inputLeaves = runs.map((r, k) => runLeaf(k, r.seed, r.initStateRoot)), resultLeaves = runs.map((r, k) => runResultLeaf(k, r.execRoot));
  const execRoot = V.merkleRoot(resultLeaves);
  return { inputLeaves, resultLeaves, runsRoot: V.merkleRoot(inputLeaves), execRoot, execDigest: batchDigest(execRoot) };
}

/** every level of the counted keccak tree (duplicate-last), leaves first: levels[0] = leaves, last = [root] */
export function levelsOf(leaves) { const out = [leaves]; while (out.at(-1).length > 1) { const l = out.at(-1), n = []; for (let i = 0; i < l.length; i += 2) n.push(V.parent(l[i], i + 1 < l.length ? l[i + 1] : l[i])); out.push(n); } return out; }
/** the pair a party posts to `postChildren` for node (level, idx) of its result tree: [left, right], right = left at a lone node */
export function childrenAt(levels, level, idx) { const c = levels[level - 1], l = 2 * idx, r = l + 1 < c.length ? l + 1 : l; return [c[l], c[r]]; }

/** The Run phase as the contract plays it: from the two result trees, the rounds each party posts and the run they end
 *  at. Returns null when the trees are equal (no dispute). */
export function bisectRuns(resultLeavesA, resultLeavesB) {
  if (resultLeavesA.length !== resultLeavesB.length) throw new Error("the parties executed different batches");
  const A = levelsOf(resultLeavesA), B = levelsOf(resultLeavesB); if (V.eq(A.at(-1)[0], B.at(-1)[0])) return null;
  const w = treeWidths(resultLeavesA.length); let level = w.length - 1, idx = 0; const rounds = [];
  while (level > 0) { const pa = childrenAt(A, level, idx), pb = childrenAt(B, level, idx); rounds.push({ level, idx, pairA: pa, pairB: pb });
    const goLeft = !V.eq(pa[0], pb[0]); if (!goLeft && V.eq(pa[1], pb[1])) throw new Error("children equal under different parents"); idx = goLeft ? 2 * idx : 2 * idx + 1; level--; }
  return { run: idx, rounds };
}

/** a client's check that run k of a settled batch has the execRoot somebody says it has */
export const verifyRunResult = (batchExecRoot, runs, k, runExecRoot, proof) => V.merkleVerifyCounted(batchExecRoot, runResultLeaf(k, runExecRoot), k, runs, proof);
