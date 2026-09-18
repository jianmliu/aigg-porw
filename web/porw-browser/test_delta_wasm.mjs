import assert from "node:assert/strict";
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { synthesizePayloadV2 } from "./synth.js";
import {
  applyDelta,
  encodeDelta,
  encodeDelta2,
  encodeDelta3,
  modelIdOf,
  deltaId,
  encodePayload,
  records,
} from "./delta.js";
import * as V from "./verify.js";
const api = await import("./delta_wasm.js").catch(() => ({}));
assert.equal(
  typeof api.uploadDeltaBase,
  "function",
  "resident delta upload API exists",
);
const { uploadDeltaBase, applyDeltaWasm } = api;
const k = await loadKernelFromBytes(
  fs.readFileSync(new URL("./sketch.wasm", import.meta.url)),
);
const base = synthesizePayloadV2("base", 100, 1000),
  mid = modelIdOf(base),
  h = uploadDeltaBase(k, base);
assert.deepEqual(h.modelId, mid);
assert.equal(h.kernel, k);
assert.equal(h.bytes, undefined);
const common = { baseModelId: mid, neurons: 100, name: "child" };
const ops = [
  { pre: 0, post: 0, w: 0 },
  { pre: 1, post: 0, w: -12 },
];
const p1 = encodeDelta2({ ...common, seed: 7n }),
  p2 = encodeDelta2({ ...common, seed: 0xffffffffffffffffn });
const ancestors = new Map([p1, p2].map((b) => [V.hex(deltaId(b)), b]));
const resolve = (id) => ancestors.get(id);
function compare(delta) {
  const mark = k.mark();
  const expected = applyDelta(base, delta, { resolve });
  const out = applyDeltaWasm(k, h, delta, { resolve });
  assert.deepEqual(k.u8(out.ptr, out.byteLength), expected);
  assert.equal(k.mark() - mark, out.allocationBytes);
  assert.ok(out.allocationBytes <= out.byteLength + 31);
  assert.deepEqual(k.u8(h.ptr, h.byteLength), base);
  k.release(mark);
}
compare(
  encodeDelta({
    ...common,
    ops: [
      { ...records(base)[0], w: 0 },
      { pre: 0, post: 0, w: 5 },
    ],
  }),
);
for (const minSyn of [0, 1, 5, 32767])
  compare(encodeDelta2({ ...common, seed: 99n, minSyn, ops }));
for (const granularity of [0, 1, 2]) {
  const child = encodeDelta3({
    ...common,
    seed: 81n,
    parentA: deltaId(p1),
    parentB: deltaId(p2),
    granularity,
    mutRateQ32: 0xafffffff,
    ops: [],
  });
  compare(child);
  ancestors.set(V.hex(deltaId(child)), child);
  compare(
    encodeDelta3({
      ...common,
      seed: 90n,
      parentA: deltaId(child),
      parentB: new Uint8Array(32),
      granularity,
      ops,
    }),
  );
}
const mark = k.mark();
assert.throws(
  () =>
    applyDeltaWasm(
      k,
      h,
      encodeDelta({ ...common, ops: [{ pre: 0, post: 0, w: 0 }] }),
    ),
  /base lacks/,
);
assert.equal(k.mark(), mark);
const child = encodeDelta3({
  ...common,
  seed: 1n,
  parentA: deltaId(p1),
  parentB: new Uint8Array(32),
});
assert.throws(
  () => applyDeltaWasm(k, h, child, { resolve: () => p2 }),
  /parent delta.*hash|identity/,
);
assert.equal(k.mark(), mark);
assert.throws(() => applyDeltaWasm(k, h, child), /not provided/);
assert.throws(
  () =>
    applyDeltaWasm(k, h, encodeDelta2({ ...common, seed: 1n, neurons: 101 })),
  /neuron count/,
);
assert.throws(
  () => uploadDeltaBase(k, encodePayload(base, "bad", records(base).reverse())),
  /sorted/,
);
assert.equal(k.mark(), mark);
console.log(
  "resident delta WASM: v1/v2/v3 bytes, inheritance, signs, errors and scratch reclamation passed",
);
// Ancestors obey identity, shape and no-explicit-ops constraints even when cached.
const badParents = [
  [encodeDelta2({ ...common, seed: 2n, neurons: 101 }), /neuron count/],
  [
    encodeDelta2({ ...common, seed: 2n, baseModelId: new Uint8Array(32) }),
    /base model id/,
  ],
  [
    encodeDelta2({ ...common, seed: 2n, ops: [{ pre: 1, post: 1, w: 3 }] }),
    /parent must carry no explicit ops/,
  ],
  [encodeDelta({ ...common, ops: [] }), /procedural delta/],
];
for (const [p, re] of badParents) {
  const c = encodeDelta3({
    ...common,
    seed: 1n,
    parentA: deltaId(p),
    parentB: new Uint8Array(32),
  });
  assert.throws(() => applyDeltaWasm(k, h, c, { resolve: () => p }), re);
  assert.equal(k.mark(), mark);
}
const otherKernel = await loadKernelFromBytes(
  fs.readFileSync(new URL("./sketch.wasm", import.meta.url)),
);
assert.throws(() => applyDeltaWasm(otherKernel, h, p1), /resident base handle/);
assert.throws(() => applyDeltaWasm(k, { ...h }, p1), /resident base handle/);
// Zero mutation inherits the signed base, including i16 minimum; maximal mutation
// and minSyn zero preserve the JS oracle's zero-weight records.
const edgeBase = encodePayload(base, "edges", [
  { pre: 0, post: 0, w: -32768 },
  { pre: 1, post: 0, w: 0 },
  { pre: 2, post: 0, w: 32767 },
]);
const eh = uploadDeltaBase(k, edgeBase),
  ec = {
    baseModelId: eh.modelId,
    neurons: 100,
    name: "edges-child",
    seed: 91n,
    parentA: new Uint8Array(32),
    parentB: new Uint8Array(32),
    minSyn: 0,
    rTable: [[1, 65535]],
  };
for (const mutRateQ32 of [0, 0xffffffff]) {
  const c = encodeDelta3({ ...ec, mutRateQ32 });
  const expected = applyDelta(edgeBase, c);
  const start = k.mark();
  const out = applyDeltaWasm(k, eh, c);
  assert.deepEqual(k.u8(out.ptr, out.byteLength), expected);
  k.release(start);
}
// Force memory.grow after obtaining a resident base: no saved view may detach.
k.memory.grow(1);
const grown = applyDeltaWasm(k, h, p1);
assert.deepEqual(k.u8(grown.ptr, grown.byteLength), applyDelta(base, p1));
console.log(
  "ancestor validation, handle ownership, i16 boundaries and memory growth passed",
);
const { wrap } = await import("./porw.js");
const memory = new WebAssembly.Memory({
  initial: 256,
  maximum: 65536,
  shared: true,
});
const sharedInstance = await WebAssembly.instantiate(
  fs.readFileSync(new URL("./porw-shared.wasm", import.meta.url)),
  { env: { memory } },
);
const shared = wrap(sharedInstance.instance.exports, memory),
  sh = uploadDeltaBase(shared, base);
const sharedMark = shared.mark(),
  so = applyDeltaWasm(shared, sh, child, { resolve });
assert.deepEqual(
  shared.u8(so.ptr, so.byteLength),
  applyDelta(base, child, { resolve }),
);
assert.equal(shared.mark() - sharedMark, so.allocationBytes);
console.log("shared WASM resident delta application passed");
// Uploading an existing view of this kernel must survive allocation growth.
const viewKernel = await loadKernelFromBytes(
  fs.readFileSync(new URL("./sketch.wasm", import.meta.url)),
);
const sourcePtr = viewKernel.put(base);
const sourceView = viewKernel.u8(sourcePtr, base.length);
viewKernel.alloc(viewKernel.memory.buffer.byteLength - viewKernel.mark() - 16);
const viewHandle = uploadDeltaBase(viewKernel, sourceView);
assert.equal(viewHandle.byteLength, base.length);
assert.deepEqual(viewHandle.modelId, mid);
assert.deepEqual(viewKernel.u8(viewHandle.ptr, viewHandle.byteLength), base);
console.log("same-kernel input view upload survives allocation growth");
