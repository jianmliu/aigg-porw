// node --expose-gc bench_delta_wasm.mjs [base.bin]
// The JS reference runs first for byte equality; its payload is not retained by the WASM API.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadKernelFromBytes, attachTrees } from './porw.js';
import { synthesizePayloadV2 } from './synth.js';
import { decodeHeader } from './model.js';
import { applyDelta, encodeDelta2, modelIdOf } from './delta.js';
import { uploadDeltaBase, applyDeltaWasm } from './delta_wasm.js';

let bytes = process.argv[2] ? new Uint8Array(fs.readFileSync(process.argv[2])) : synthesizePayloadV2('bench-wasm-sampler', 4000, 60000);
const hdr = decodeHeader(bytes), mid = modelIdOf(bytes);
const delta = encodeDelta2({ baseModelId: mid, neurons: hdr.neurons, seed: 7n, name: 'bench-wasm-individual' });
let t = performance.now(), expected = applyDelta(bytes, delta, { baseModelId: mid });
const jsMs = performance.now() - t;
const k = attachTrees(await loadKernelFromBytes(fs.readFileSync(new URL('./sketch.wasm', import.meta.url))));
t = performance.now();
const base = uploadDeltaBase(k, bytes, { baseModelId: mid });
const uploadMs = performance.now() - t;
bytes = null; globalThis.gc?.();
const before = k.mark(), bufferBefore = k.memory.buffer.byteLength;
t = performance.now();
const applied = applyDeltaWasm(k, base, delta);
const wasmMs = performance.now() - t;
assert.deepEqual(k.u8(applied.ptr, applied.byteLength), expected);
expected = null; globalThis.gc?.();
const row = { neurons: hdr.neurons, baseRecords: hdr.synapses, appliedRecords: applied.hdr.synapses,
  jsMs: +jsMs.toFixed(2), wasmMs: +wasmMs.toFixed(2), speedup: +(jsMs / wasmMs).toFixed(2),
  baseUploadMs: +uploadMs.toFixed(2), residentBaseBytes: base.allocationBytes,
  residentOutputBytes: k.mark() - before, outputBytes: applied.byteLength,
  retainedScratchBytes: k.mark() - before - applied.allocationBytes,
  wasmBufferBefore: bufferBefore, wasmBufferHighWaterBytes: k.memory.buffer.byteLength,
  scratchUpperBoundBytes: k.memory.buffer.byteLength - k.mark(), byteIdentical: true };
console.log(JSON.stringify(row, null, 2));
