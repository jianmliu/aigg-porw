import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PorwNode } from './node.js';
import { loadKernelFromBytes, wrap } from './porw.js';
import { synthesizePayloadV2 } from './synth.js';
import { applyDelta, encodeDelta, encodeDelta2, encodeDelta3, deltaId, modelIdOf } from './delta.js';
import { modelMemoryBytes } from './mem.js';
import { hex } from './verify.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const wasm = fs.readFileSync(new URL('./sketch.wasm', import.meta.url));
{
  const k = await loadKernelFromBytes(wasm);
  const p = k.alloc(32); k.u8(p, 32).fill(123);
  const view = k.u8(p, 32);
  k.alloc(k.memory.buffer.byteLength - k.mark());
  const copy = k.put(view); // allocation grows memory, detaching the original view
  assert.deepEqual(k.u8(copy, 32), new Uint8Array(32).fill(123));
  const input = k.u8(copy, 32);
  k.alloc(k.memory.buffer.byteLength - k.mark() - 16);
  assert.deepEqual(k.keccak256(input), keccak_256(new Uint8Array(32).fill(123)), 'hashing a resident view must preserve length across growth');
}
const node = new PorwNode(await loadKernelFromBytes(wasm));
assert.equal(typeof node.loadDeltaBase, 'function', 'node must support a reusable WASM-resident delta base');
const bytes = synthesizePayloadV2('resident-base', 128, 1000);
const mid = modelIdOf(bytes), base = node.loadDeltaBase(bytes);
assert.equal(base.kernel, node.k);
assert.equal(node.loadDeltaBase(bytes), base, 'same byte input reuses the base');
assert.equal(node.loadDeltaBase(bytes.slice()), base, 'identical base bytes deduplicate by identity');
assert.equal(node.deltaBases.size, 1);
assert.ok(!Object.values(base).some(v => v === bytes), 'handle does not retain JS payload');
const founder = encodeDelta2({ baseModelId: mid, neurons: 128, seed: 0xffffffffffffffffn, name: 'founder' });
const child = encodeDelta3({ baseModelId: mid, neurons: 128, parentA: deltaId(founder), parentB: new Uint8Array(32), seed: 7n, name: 'child' });
const resolve = id => id === hex(deltaId(founder)) ? founder : null;
const deltas = [encodeDelta({ baseModelId: mid, neurons: 128, name: 'edits', ops: [{ pre: 0, post: 0, w: -7 }] }), founder, child];
// Force a growth after base upload. Handles must use offsets, never detached cached views.
node.k.alloc(2 * 1024 ** 2);
const put = node.k.put;
node.k.put = b => { assert.ok(b.length < bytes.length, 'applied payload must not be copied back from JS'); return put(b); };
for (const delta of deltas) {
  const expected = applyDelta(bytes, delta, { resolve });
  const reference = new PorwNode(await loadKernelFromBytes(wasm));
  const direct = await reference.loadModel('unused', expected, { maxSteps: 4 });
  const before = node.k.mark();
  const actual = await node.loadDelta(base, delta, { resolve, maxSteps: 4 });
  assert.equal(hex(actual.modelId), hex(direct.modelId));
  assert.equal(hex(actual.csr.synapseRoot), hex(direct.csr.synapseRoot));
  assert.equal(hex(actual.mep.mepId), hex(direct.mep.mepId));
  assert.deepEqual(node.k.u8(actual.bufPtr, actual.nTiles * 4096), expected);
  const predicted = modelMemoryBytes({ nTiles: actual.nTiles, neurons: actual.hdr.neurons, synapses: actual.hdr.synapses, maxSteps: 4, exec: 'lif' });
  assert.ok(node.k.mark() - before < predicted + 4096, 'scratch and duplicate payload must not remain resident');
  const [a, b] = await Promise.all([node.execute(actual.mep.mepId, { steps: 4 }), reference.execute(direct.mep.mepId, { steps: 4 })]);
  assert.equal(hex(a.result.execDigest), hex(b.result.execDigest));
}
const before = node.k.mark();
const broken = founder.slice(); broken[12] ^= 1;
await assert.rejects(node.loadDelta(base, broken), /base.*mismatch/);
assert.equal(node.k.mark(), before, 'failure restores scratch without damaging prior residents');
const other = new PorwNode(await loadKernelFromBytes(wasm));
await assert.rejects(other.loadDelta(base, founder), /kernel|owner/);
node.k.put = put;
const pending = node.loadModel('parallel', bytes, { maxSteps: 2 });
await assert.rejects(node.loadDelta(base, founder), /progress|concurrent|busy/);
await pending;
console.log('ALL PASS: resident delta node integration, commitments, execution, memory and ownership');

let reviewFailures = 0;
async function reviewCheck(label, fn) {
  try { await fn(); console.log('ok', label); }
  catch (error) { reviewFailures++; console.error('FAIL', label, error.message); }
}
await reviewCheck('mutated byte input is verified again instead of using its old identity', async () => {
  const n = new PorwNode(await loadKernelFromBytes(wasm));
  const input = synthesizePayloadV2('mutable-base', 32, 100);
  const old = n.loadDeltaBase(input);
  input[30] = 'M'.charCodeAt(0);
  const d = encodeDelta2({ baseModelId: modelIdOf(input), neurons: 32, seed: 7n, name: 'changed' });
  const st = await n.loadDelta(input, d, { maxSteps: 4 });
  assert.deepEqual(n.k.u8(st.bufPtr, st.nTiles * 4096), applyDelta(input, d));
  assert.notEqual(hex(st.delta.baseModelId), hex(old.modelId));
});
await reviewCheck('dispute replay and resident loading cannot rewind each other', async () => {
  const n = new PorwNode(await loadKernelFromBytes(wasm));
  const b = synthesizePayloadV2('replay-base', 32, 100);
  const st = await n.loadModel('base', b, { maxSteps: 4 });
  await n.execute(st.mep.mepId, { steps: 4 });
  const h = n.loadDeltaBase(b), d = encodeDelta2({ baseModelId: modelIdOf(b), neurons: 32, seed: 7n, name: 'child' });
  const replay = n.lifStates(st.mep.mepId, 1);
  try { await assert.rejects(n.loadDelta(h, d, { maxSteps: 4 }), /progress|concurrent|busy/); }
  finally { await replay; }
  const child = await n.loadDelta(h, d, { maxSteps: 4 });
  assert.deepEqual(n.k.u8(child.bufPtr, child.nTiles * 4096), applyDelta(b, d));
  const sibling = new PorwNode(wrap(n.k.exports, n.k.memory));
  const loading = n.loadDelta(h, d, { maxSteps: 4 });
  const rejected = [
    n.lifStates(st.mep.mepId, 2),
    n.execute(st.mep.mepId, { steps: 4 }),
    sibling.loadModel('other', b),
  ];
  try { await Promise.all(rejected.map(p => assert.rejects(p, /progress|concurrent|busy/))); }
  finally { await loading; }
  await n.challenge(st.mep.mepId, new Uint8Array(32), { steps: 4 });
});
await reviewCheck('failed adoption rolls back new base and output while preserving older residents', async () => {
  const n = new PorwNode(await loadKernelFromBytes(wasm));
  const original = synthesizePayloadV2('old', 32, 100);
  const st = await n.loadModel('old', original, { maxSteps: 4 });
  const before = n.k.mark(), initialBases = n.deltaBases.size;
  const b = synthesizePayloadV2('new', 32, 100);
  const d = encodeDelta2({ baseModelId: modelIdOf(b), neurons: 32, seed: 7n, name: 'child' });
  const buildTree = n._buildTree;
  let builds = 0;
  n._buildTree = (...args) => { if (++builds === 2) throw new Error('injected CSR tree failure'); return buildTree.apply(n, args); };
  try { await assert.rejects(n.loadDelta(b, d, { maxSteps: 4 }), /injected CSR/); }
  finally { n._buildTree = buildTree; }
  assert.equal(n.k.mark(), before);
  assert.equal(n.deltaBases.size, initialBases);
  assert.equal(n.models.size, 1);
  assert.deepEqual(n.k.u8(st.bufPtr, st.nTiles * 4096), original);
  await n.execute(st.mep.mepId, { steps: 4 });
  await n.loadDelta(b, d, { maxSteps: 4 });
});
assert.equal(reviewFailures, 0, 'review regression checks');
