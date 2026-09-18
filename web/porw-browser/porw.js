// Shared WASM glue for the PoRW browser PoC (used by the page and by workers).

export async function loadKernel(wasmUrl) {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  return loadKernelFromBytes(bytes);
}

export const TILE_BYTES = 4096;
export const TILE_WORDS = 1024;

// Sketch a slice: materialize `nTiles` tiles starting at global tile `firstTile`
// (deterministic pattern), then time `repeats` sketches. Returns timings + the
// sketch values (Uint32Array copy).
export function runSlice(k, { nTiles, firstTile, seed, slotSeed, repeats }) {
  const nWords = nTiles * TILE_WORDS;
  const bufPtr = k.alloc(nTiles * TILE_BYTES);
  const outPtr = k.alloc(nTiles * 4);
  const t0 = performance.now();
  k.fill(bufPtr, nWords, firstTile * TILE_WORDS, seed);
  const fillMs = performance.now() - t0;
  k.sketch(bufPtr, nTiles, firstTile, slotSeed, outPtr); // warm
  const times = [];
  for (let r = 0; r < repeats; r++) {
    const a = performance.now();
    k.sketch(bufPtr, nTiles, firstTile, slotSeed, outPtr);
    times.push(performance.now() - a);
  }
  times.sort((x, y) => x - y);
  return {
    fillMs,
    medianMs: times[times.length >> 1],
    bestMs: times[0],
    sketches: new Uint32Array(k.u32(outPtr, nTiles)), // copy out
  };
}

// ---- loading from bytes (Node) and keccak-scheme commitment wrappers ----
export async function loadKernelFromBytes(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return wrap(instance.exports);
}
export function wrap(e, memory = e.memory) {
  const k = {
    exports: e,
    backend: e.porw_simd_backend() === 1 ? "simd128" : "scalar",
    memory,
    alloc: (n) => { const p = e.porw_alloc(n >>> 0); if (!p) throw new Error("wasm alloc failed"); return p; },
    mark: () => e.porw_heap_mark(),
    release: (m) => e.porw_heap_release(m),
    fill: (ptr, nWords, wordOffset, seed) => e.porw_fill_pattern(ptr, nWords >>> 0, wordOffset >>> 0, seed >>> 0),
    sketch: (bufPtr, nTiles, firstTile, slotSeed, outPtr) => {
      const rc = e.porw_sketch_tiles(bufPtr, nTiles >>> 0, firstTile >>> 0, slotSeed >>> 0, outPtr);
      if (rc !== 0) throw new Error("sketch rc=" + rc);
    },
    u8: (ptr, n) => new Uint8Array(memory.buffer, ptr, n),
    u32: (ptr, n) => new Uint32Array(memory.buffer, ptr, n),
    put: (bytes) => { const p = k.alloc(bytes.length); new Uint8Array(memory.buffer, p, bytes.length).set(bytes); return p; },
    keccak256: (bytes) => { const m = k.mark(); const p = k.put(bytes); const o = k.alloc(32);
      e.porw_keccak256(p, bytes.length, o); const r = new Uint8Array(k.u8(o, 32)); k.release(m); return r; },
    slotSeed: (challenge32, device32) => { const m = k.mark(); const c = k.put(challenge32), d = k.put(device32);
      const s = e.porw_slot_seed(c, d) >>> 0; k.release(m); return s; },
    // leaves over a resident buffer (bufPtr) — returns a copy (n*32 bytes)
    weightsLeaves: (bufPtr, nTiles, firstTile) => { const m = k.mark(); const o = k.alloc(nTiles * 32);
      e.porw_weights_leaves(bufPtr, nTiles >>> 0, firstTile >>> 0, o); const r = new Uint8Array(k.u8(o, nTiles * 32)); k.release(m); return r; },
    partialsLeaves: (sketchesU32, firstTile, tileIdsU32 = null) => { const m = k.mark(); const n = sketchesU32.length;
      const sp = k.alloc(n * 4); k.u32(sp, n).set(sketchesU32);
      let tp = 0; if (tileIdsU32) { tp = k.alloc(n * 4); k.u32(tp, n).set(tileIdsU32); }
      const o = k.alloc(n * 32); e.porw_partials_leaves(tp, sp, n >>> 0, firstTile >>> 0, o);
      const r = new Uint8Array(k.u8(o, n * 32)); k.release(m); return r; },
    merkleRoot: (leaves) => { const m = k.mark(); const n = leaves.length / 32; const lp = k.put(leaves);
      const sc = k.alloc(Math.max(32, n * 32)); const o = k.alloc(32); e.porw_merkle_root(lp, n >>> 0, sc, o);
      const r = new Uint8Array(k.u8(o, 32)); k.release(m); return r; },
    merkleProof: (leaves, index) => { const m = k.mark(); const n = leaves.length / 32; const lp = k.put(leaves);
      const sc = k.alloc(Math.max(32, n * 32)); const maxD = 40; const o = k.alloc(maxD * 32);
      const d = e.porw_merkle_proof(lp, n >>> 0, index >>> 0, sc, o, maxD) >>> 0;
      if (d >= 0xFFFFFFFE) { k.release(m); throw new Error("merkle proof error " + d); }
      const out = []; for (let i = 0; i < d; i++) out.push(new Uint8Array(k.u8(o + i * 32, 32))); k.release(m); return out; },
  };
  return k;
}

// ---- cached Merkle trees (build once, O(log n) proofs) ----
export function attachTrees(k) {
  const e = k.exports;
  k.treeNodes = (n) => e.porw_merkle_tree_nodes(n >>> 0) >>> 0;
  // build into a caller-provided region (ptr sized treeNodes(n)*32); returns { ptr, n, root }
  k.treeBuildInto = (leavesPtr, n, treePtr) => { e.porw_merkle_tree_build(leavesPtr, n >>> 0, treePtr);
    const nodes = k.treeNodes(n); return { ptr: treePtr, n, root: new Uint8Array(k.u8(treePtr + (nodes - 1) * 32, 32)) }; };
  k.treeProof = (tree, index) => { const m = k.mark(); const maxD = 40; const o = k.alloc(maxD * 32);
    const d = e.porw_merkle_tree_proof(tree.ptr, tree.n >>> 0, index >>> 0, o, maxD) >>> 0;
    if (d >= 0xFFFFFFFE) { k.release(m); throw new Error("tree proof error " + d); }
    const out = []; for (let i = 0; i < d; i++) out.push(new Uint8Array(k.u8(o + i * 32, 32))); k.release(m); return out; };
  return k;
}

// node (level, idx) of a cached tree: level 0 = leaves; widths halve (ceil) up to the root
export function treeWidths(n) { const w = [n]; while (w[w.length - 1] > 1) w.push((w[w.length - 1] + 1) >> 1); return w; }
export function treeNodeAt(k, tree, level, idx) {
  const w = treeWidths(tree.n); let off = 0; for (let l = 0; l < level; l++) off += w[l];
  if (level >= w.length || idx >= w[level]) throw new Error("tree node out of range");
  return new Uint8Array(k.u8(tree.ptr + (off + idx) * 32, 32));
}

// parallel cached-tree build over a pool: aligned 2^m-leaf blocks on workers, upper levels on main
export async function treeBuildParallel(pool, leavesPtr, n, treePtr) {
  const k = pool.kernel, e = k.exports;
  let m = Math.max(1, Math.floor(Math.log2(Math.max(2, Math.floor(n / (pool.workers * 2))))));
  const block = 1 << m, nBlocks = Math.ceil(n / block);
  await pool.map("porw_merkle_tree_build_blocks", nBlocks, (f, c) => [leavesPtr, n, treePtr, m, f, c]);
  if (e.porw_merkle_tree_build_upper(treePtr, n >>> 0, m) !== 0) throw new Error("tree upper build failed");
  const nodes = k.treeNodes(n);
  return { ptr: treePtr, n, root: new Uint8Array(k.u8(treePtr + (nodes - 1) * 32, 32)) };
}
