// Shared WASM glue for the PoRW browser PoC (used by the page and by workers).

export async function loadKernel(wasmUrl) {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  return {
    backend: e.porw_simd_backend() === 1 ? "simd128" : "scalar",
    memory: e.memory,
    alloc: (n) => { const p = e.porw_alloc(n >>> 0); if (!p) throw new Error("wasm alloc failed"); return p; },
    fill: (ptr, nWords, wordOffset, seed) => e.porw_fill_pattern(ptr, nWords >>> 0, wordOffset >>> 0, seed >>> 0),
    sketch: (bufPtr, nTiles, firstTile, slotSeed, outPtr) => {
      const rc = e.porw_sketch_tiles(bufPtr, nTiles >>> 0, firstTile >>> 0, slotSeed >>> 0, outPtr);
      if (rc !== 0) throw new Error("sketch rc=" + rc);
    },
    u32: (ptr, n) => new Uint32Array(e.memory.buffer, ptr, n),
  };
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
