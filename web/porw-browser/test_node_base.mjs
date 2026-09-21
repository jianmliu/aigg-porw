import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PorwNode } from './node.js';
import { loadKernelFromBytes } from './porw.js';
import { synthesizePayloadV2 } from './synth.js';
import { withBase, withTerms } from './mep.js';
import { applyDelta, encodeDelta, encodeDelta2, encodeDelta3, deltaId, modelIdOf } from './delta.js';
import { hex } from './verify.js';
const wasm = fs.readFileSync(new URL('./sketch.wasm', import.meta.url));
const node = new PorwNode(await loadKernelFromBytes(wasm));
const payload = synthesizePayloadV2('base-runtime', 32, 100);
const root = await node.loadModel('root', payload);
const baseMepId = root.mep.mepId;
const terms = { beneficiary: '0x0000000000000000000000000000000000000b0b', royaltyBps: 1000 };
const derived = await node.loadModel('derived', payload, { baseMepId, terms });
const expected = withTerms(withBase(root.mep, baseMepId), terms.beneficiary, terms.royaltyBps);
assert.equal(hex(derived.mep.mepId), hex(expected.mepId), 'loadModel must bind base before terms');
assert.notEqual(hex(derived.mep.mepId), hex(root.mep.mepId));
assert.equal(node.models.get(hex(derived.mep.mepId)), derived);
assert.equal(node.models.get(hex(root.mep.mepId)), root);
const mid = modelIdOf(payload), zero = new Uint8Array(32);
const founder = encodeDelta2({ baseModelId: mid, neurons: 32, seed: 9n, name: 'founder' });
const resolve = id => id === hex(deltaId(founder)) ? founder : null;
const deltas = [
  encodeDelta({ baseModelId: mid, neurons: 32, name: 'edits', ops: [{ pre: 0, post: 0, w: 7 }] }),
  founder,
  encodeDelta3({ baseModelId: mid, neurons: 32, name: 'compact', seed: 7n, parentA: deltaId(founder), parentB: zero }),
  encodeDelta3({ baseModelId: mid, neurons: 32, name: 'inplace-test', seed: 7n, parentA: zero, parentB: zero, layout: 1 }),
];
for (const delta of deltas) {
  const plain = await node.loadModel('reference', applyDelta(payload, delta, { resolve }));
  const st = await node.loadDelta(payload, delta, { baseMepId: hex(baseMepId), terms, resolve });
  assert.equal(hex(st.mep.mepId), hex(withTerms(withBase(plain.mep, baseMepId), terms.beneficiary, terms.royaltyBps).mepId));
  assert.equal(hex(st.modelId), hex(plain.modelId));
  const [a, b] = [await node.execute(st.mep.mepId), await node.execute(plain.mep.mepId)];
  assert.equal(hex(a.result.execDigest), hex(b.result.execDigest));
  assert.equal(node.models.get(hex(st.mep.mepId)), st);
}
const mark = node.k.mark();
await assert.rejects(node.loadModel('invalid', payload, { baseMepId: '0x1234' }), /base/);
assert.equal(node.k.mark(), mark, 'failed identity validation must rewind the allocation');
console.log('ALL PASS: base loadModel and delta v1/v2/v3 compact/in-place identity and execution');
