// mem.js against the real allocator, and the two bounds a host has to tell apart.
import fs from "node:fs";
import { loadKernelFromBytes, wrap, TILE_BYTES } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload, synthesizePayloadV2 } from "./synth.js";
import { modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES } from "./mem.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const MB = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const k = node.k;

// the closed form is the allocator, not an estimate: a bump allocator's mark is an exact high-water mark
for (const [exec, maxSteps, make] of [["lif", 20, synthesizePayloadV2], ["lif", 200, synthesizePayloadV2], ["spmv", 3, synthesizePayload]]) {
  const name = `mem-${exec}-${maxSteps}`; const payload = make(name, 4000, 60000);
  const shape = { nTiles: Math.floor(payload.length / TILE_BYTES), neurons: 4000, synapses: 60000, exec };
  const before = k.mark(); await node.loadModel(name, payload, { maxSteps, exec }); const used = k.mark() - before;
  const predicted = modelMemoryBytes({ ...shape, maxSteps });
  check(`${exec} maxSteps ${maxSteps}: predicted ${MB(predicted)} == measured ${MB(used)}`, Math.abs(used - predicted) / predicted < 0.01);
}

// maxSteps is the knob, and for int-lif it buys a checkpoint every 32 steps
{ const shape = { nTiles: 6866, neurons: 139255, synapses: 2700513, exec: "lif" }; // the real FlyWire v783 min-5 shape
  const at = (s) => modelMemoryBytes({ ...shape, maxSteps: s });
  const MiB = 1024 ** 2;
  check(`real brain at 100 steps is ${MB(at(100))}, at 5000 steps ${MB(at(5000))}`, at(100) > 80 * MiB && at(100) < 85 * MiB && at(5000) > 400 * MiB && at(5000) < 415 * MiB);
  check("the payload is a minority of the cost at 100 steps and a fifteenth at 5000", 6866 * TILE_BYTES / at(100) < 0.4 && 6866 * TILE_BYTES / at(5000) < 0.1);
  const budget = 1024 ** 3;
  const fits = maxStepsWithin(shape, budget);
  check(`maxStepsWithin inverts: ${fits} steps fit 1 GB, ${fits + 1} do not`, at(fits) <= budget && at(fits + 1) > budget);
  // TaskMarket bounds the arrays a dispute round posts (MAX_ROOTS), which is not a memory bound
  const CONTRACT_MAX_LIF = 512 * 512;
  check(`TaskMarket's int-lif limit (${CONTRACT_MAX_LIF} steps) is ${MB(at(CONTRACT_MAX_LIF))} — past wasm32's 4 GB, so a host must use the memory bound instead`,
    at(CONTRACT_MAX_LIF) > WASM32_MAX_BYTES && maxStepsWithin(shape, WASM32_MAX_BYTES) < CONTRACT_MAX_LIF);
  check("a brain too big for any budget yields 0 rather than a step count", maxStepsWithin(shape, 1024) === 0);
}
// A wasm i32 result reaches JS signed, so a heap past 2 GiB used to hand the TypedArray constructors a
// negative offset ("Start offset ... is outside the bounds of the buffer") — half of what wasm32 addresses,
// and squarely inside the range a tab hosting several brains reaches. Checked here without allocating 2 GiB.
{ const NEG = -2147416800, UNS = NEG >>> 0; // 2,147,550,496: the first 64 KiB page past 2 GiB
  const stub = wrap({ porw_simd_backend: () => 0, porw_alloc: () => NEG, porw_heap_mark: () => NEG }, { buffer: new ArrayBuffer(16) });
  check(`a pointer past 2 GiB comes back unsigned from alloc (${UNS}, not ${NEG})`, stub.alloc(16) === UNS);
  check("and from mark, which is what every size measurement here differences", stub.mark() === UNS);
  check("the raw export really is signed there (so the coercion is doing the work)", (-2147416800 | 0) < 0 && UNS > 2 ** 31);
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
