// Full independent Python apply oracle (requires numpy and pycryptodome).
// uv run --with numpy --with pycryptodome -- node test_delta_python.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { synthesizePayloadV2 } from './synth.js';
import { encodeDelta, encodeDelta2, encodeDelta3, modelIdOf } from './delta.js';
import { loadKernelFromBytes } from './porw.js';
import { uploadDeltaBase, applyDeltaWasm } from './delta_wasm.js';
import { deltaId } from './delta.js';
import { hex } from './verify.js';

const base = synthesizePayloadV2('python-oracle', 64, 300), mid = modelIdOf(base);
const common = { baseModelId: mid, neurons: 64, name: 'oracle' };
const v1 = encodeDelta({ ...common, ops: [{ pre: 0, post: 0, w: -32768 }] });
const a = encodeDelta2({ ...common, seed: 0xffffffffffffffffn, minSyn: 1 });
const b = encodeDelta2({ ...common, seed: 2n, meanRatioQ16: 32768, minSyn: 9 });
const crosses = [0, 1, 2].map(granularity => encodeDelta3({ ...common, parentA: deltaId(a), parentB: deltaId(b), seed: 3n, granularity, mutRateQ32: 0x80000000 }));
const grandchild = encodeDelta3({ ...common, parentA: deltaId(crosses[0]), parentB: deltaId(crosses[1]), seed: 4n });
const all = [v1, a, b, ...crosses, grandchild];
const parents = new Map(all.map(d => [hex(deltaId(d)), d]));
const b64 = b => Buffer.from(b).toString('base64');
const py = `import importlib.util,sys,json,base64
s=importlib.util.spec_from_file_location('flywire_delta',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
d=json.load(sys.stdin);base=base64.b64decode(d['base']);deltas=[base64.b64decode(x) for x in d['deltas']]
parents={m.delta_id(x):x for x in deltas}
print(json.dumps([base64.b64encode(m.apply_any(base,x,parents)).decode() for x in deltas]))
`;
const expected = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', py, new URL('../../gpu/triton/demo/fly_brain/flywire_delta.py', import.meta.url).pathname],
  { input: JSON.stringify({ base: b64(base), deltas: all.map(b64) }), maxBuffer: 8 * 1024 ** 2 }));
const k = await loadKernelFromBytes(fs.readFileSync(new URL('./sketch.wasm', import.meta.url))), handle = uploadDeltaBase(k, base);
for (let i = 0; i < all.length; i++) {
  const mark = k.mark(), result = applyDeltaWasm(k, handle, all[i], { resolve: id => parents.get(id) });
  assert.equal(b64(k.u8(result.ptr, result.byteLength)), expected[i], `Python applied bytes, case ${i}`);
  k.release(mark);
}
console.log('ALL PASS: Python/WASM full v1/v2/v3 payloads, all inheritance granularities and grandchild');
