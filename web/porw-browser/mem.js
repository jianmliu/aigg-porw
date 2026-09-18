// What one hosted brain costs a tab, in bytes of wasm memory.
//
// Under scheme sketch-tile-keccak (since v2) a residency claim is the sketch and its commitment, so CPU is no
// longer what limits how many brains a tab hosts. Memory is. Every allocation in `PorwNode.loadModel`
// is sized by (tiles, neurons, synapses, maxSteps, exec) and never by the weight values, so this is a
// closed form, not an estimate — `bench_memory.mjs` measures the real allocator against it and fails
// if they drift by more than 1%.
//
// The one knob a host actually chooses is `maxSteps`, the slot's task capacity. For int-lif it buys a
// state checkpoint every 32 steps, each `neurons * 16` bytes, and at the production task shape (5000
// steps) those checkpoints are 82% of the brain. TaskMarket's own limit on a task bounds the arrays a
// dispute round must post, which is a different and far looser bound: see `maxStepsWithin` below.
export const TILE_BYTES = 4096, LIF_STATE = 16, LIF_CHECKPOINT = 32, CSR_CHUNK = 64;
// A wasm32 memory cannot grow past this, on any device. Until the pointer coercion in porw.js, the JS glue
// gave up at half of it: a heap past 2 GiB reached the TypedArray constructors as a negative offset.
export const WASM32_MAX_BYTES = 4 * 2 ** 30;

const treeNodes = (n) => { let t = 0, w = n || 1; for (;;) { t += w; if (w === 1) break; w = Math.ceil(w / 2); } return t; };

/** the allocations of one `loadModel`, largest first; `bytes` sums to `modelMemoryBytes` */
export function modelMemoryParts({ nTiles, neurons: n, synapses: ns, maxSteps, exec = "lif" }) {
  const nChunks = Math.ceil(ns / CSR_CHUNK), actN = treeNodes(n), parts = [];
  const add = (what, bytes, scales) => parts.push({ what, bytes, scales });
  add("payload", nTiles * TILE_BYTES, "model bytes");
  add("weights leaves + tree", nTiles * 32 + treeNodes(nTiles) * 32, "model bytes");
  add("CSR rowStart + perm", (n + 1) * 4 + ns * 4, "synapses");
  add("CSR leaves + trees", nChunks * 32 + (n + 1) * 32 + treeNodes(nChunks) * 32 + treeNodes(n + 1) * 32, "synapses, neurons");
  add("residency slot (sketches, partials leaves + tree)", nTiles * 4 + nTiles * 32 + treeNodes(nTiles) * 32, "model bytes");
  if (exec === "lif") {
    add("LIF ping/pong + leaves + tree + acc + counts", 2 * n * LIF_STATE + n * 32 + actN * 32 + n * 8 + n * 4, "neurons");
    add("LIF checkpoints", (Math.floor(maxSteps / LIF_CHECKPOINT) + 1) * n * LIF_STATE, "neurons x maxSteps");
  } else {
    add("per-step activations + leaves + trees", (maxSteps + 1) * n * 4 + maxSteps * (n * 32 + actN * 32), "neurons x maxSteps");
  }
  return parts.sort((a, b) => b.bytes - a.bytes);
}

export const modelMemoryBytes = (shape) => modelMemoryParts(shape).reduce((s, p) => s + p.bytes, 0);

/** the largest task capacity for this brain that still fits `budgetBytes`, or 0 if even one step does not */
export function maxStepsWithin(shape, budgetBytes) {
  if (modelMemoryBytes({ ...shape, maxSteps: 1 }) > budgetBytes) return 0;
  let lo = 1, hi = 1;
  while (modelMemoryBytes({ ...shape, maxSteps: hi }) <= budgetBytes && hi < 1 << 22) { lo = hi; hi *= 2; }
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (modelMemoryBytes({ ...shape, maxSteps: mid }) <= budgetBytes) lo = mid; else hi = mid; }
  return lo;
}
