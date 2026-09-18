import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

import {DEFAULT_R_TABLE, hash64, nbTable, rOf, sampleFromTable} from './sample.js';

const {instance: {exports: w}} =
    await WebAssembly.instantiate(readFileSync(new URL('./sketch.wasm', import.meta.url)));
for (const name of ['porw_nb_table', 'porw_hash64', 'porw_sample_records'])
  assert.equal(typeof w[name], 'function', name);
const ptr = w.porw_alloc(32768 * 8);
const cases = [
  [0, 423, 65536, 256], [1, 423, 0, 264], [1, 423, 65536, 264], [100, 4412, 65536, 1056],
  [32768, 65535, 0xffffffff, 32767], [32768, 1, 0xffffffff, 32767], [32768, 65535, 65536, 32767],
  [1, 1, 1, 264], [200, 65535, 1, 1856], [32768, 1, 1, 32767]
];
let rng = 0x12345678;
const rand = () => {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng;
};
for (let i = 0; i < 40; i++) cases.push([rand() % 32769, 1 + rand() % 65535, rand(), 500 + rand() % 1000]);
for (let i = 0; i < 200; i++) cases.push([1 + rand() % 1000, 1 + rand() % 5000, 1 + rand() % 131072, 256]);
for (const c of [1, 2, 3, 5, 8, 12, 20, 35, 60, 100, 200, 1000])
  for (const mr of [1, 32768, 65536, 131072])
    cases.push([c, rOf(c, DEFAULT_R_TABLE), mr, Math.min(32767, 8 * c + 256)]);
for (const [c, R, MR, kmax] of cases) {
  const expected = nbTable(c, R, MR, kmax);
  const n = w.porw_nb_table(c, R, MR, kmax, ptr, 32768);
  assert.equal(n, expected.length, `${c}/${R}/${MR} length`);
  assert.deepEqual(new BigUint64Array(w.memory.buffer, ptr, n), expected, `${c}/${R}/${MR} CDF`);
  for (const u of [0n, expected[0], expected[Math.floor(n / 2)], (1n << 64n) - 1n])
    assert.equal(w.porw_sample_from_table(ptr, n, BigInt.asIntN(64, u)), sampleFromTable(expected, u));
}
for (let i = 0; i < 100; i++)
  assert.equal(
      BigInt.asUintN(64, w.porw_hash64(i, 0xffffffff - i, i * 314159, i * 271828)),
      hash64(i, 0xffffffff - i, i * 314159, i * 271828));
const n = 200, records = w.porw_alloc(n * 10), rows = w.porw_alloc(DEFAULT_R_TABLE.length * 8),
      counts = w.porw_alloc(n * 4);
new Uint32Array(w.memory.buffer, rows, DEFAULT_R_TABLE.length * 2).set(DEFAULT_R_TABLE.flat());
let dv = new DataView(w.memory.buffer);
for (let i = 0; i < n; i++) {
  dv.setUint32(records + i * 10, i, true);
  dv.setUint32(records + i * 10 + 4, n - i, true);
  dv.setInt16(records + i * 10 + 8, (i % 2 ? -1 : 1) * (i % 7 + 1), true);
}
const mark = w.porw_heap_mark();
for (let run = 0; run < 3; run++) {
  assert.equal(w.porw_sample_records(records, n, 123, 456, 65536, rows, DEFAULT_R_TABLE.length, counts), 0);
  assert.equal(w.porw_heap_mark(), mark);
  const actual = new Uint32Array(w.memory.buffer, counts, n);
  for (let i = 0; i < n; i++) {
    const c = i % 7 + 1;
    assert.equal(
        actual[i], sampleFromTable(nbTable(c, rOf(c, DEFAULT_R_TABLE), 65536), hash64(123, 456, i, n - i)));
  }
}
assert.equal(w.porw_nb_table(1, 0, 65536, 264, ptr, 32768), -1);
assert.equal(w.porw_nb_table(1, 423, 65536, 264, ptr, 1), -1);
assert.equal(w.porw_nb_table(1, 423, 65536, 264, 0xfffffff0, 32768), -1);
assert.equal(w.porw_sample_records(records, n, 0, 0, 65536, rows, 10, records), -1);
assert.equal(w.porw_sample_records(records, 0xffffffff, 0, 0, 65536, rows, 10, counts), -1);
assert.equal(w.porw_sample_records(records, n, 0, 0, 65536, rows, 65536, counts), -1);
assert.equal(w.porw_sample_records(records, n, 0, 0, 65536, 0xfffffff0, 10, counts), -1);
new Uint32Array(w.memory.buffer, rows, 1)[0] = 2;
assert.equal(w.porw_sample_records(records, n, 0, 0, 65536, rows, 10, counts), -1);
new Uint32Array(w.memory.buffer, rows, 1)[0] = 1;
console.log('exact WASM sampler: CDF extremes, hashes, records, scratch reuse passed');

// Execute the Python reference arithmetic without its unrelated NumPy/exporter dependencies.
const python = `import ast,json,sys,types
source=ast.parse(open(sys.argv[1]).read())
names={'fmix32','hash64','ln_q60','exp_q256','nb_table'}
module=ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[])
ns={'Q60':1<<60,'Q256':1<<256,'LN2_Q60':799144290325165978,'M32':0xffffffff,'GOLDEN32':0x9e3779b9,'np':types.SimpleNamespace(array=lambda a,**kw:a,uint64=None)}
exec(compile(module,'flywire_delta.py','exec'),ns)
cases=json.loads(sys.stdin.read())
print(json.dumps([[str(v) for v in ns['nb_table'](*c)] for c in cases]))
`;
const pythonTables = JSON.parse(execFileSync(
    'python3',
    ['-c', python, new URL('../../gpu/triton/demo/fly_brain/flywire_delta.py', import.meta.url).pathname],
    {input: JSON.stringify(cases), maxBuffer: 16 * 1024 * 1024}));
for (let i = 0; i < cases.length; i++)
  assert.deepEqual(Array.from(nbTable(...cases[i]), String), pythonTables[i]);
const sharedMemory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true});
const {instance: {exports: sw}} = await WebAssembly.instantiate(
    readFileSync(new URL('./porw-shared.wasm', import.meta.url)), {env: {memory: sharedMemory}});
const sp = sw.porw_alloc(32768 * 8);
for (const c of cases.slice(0, 10)) {
  const n = sw.porw_nb_table(...c, sp, 32768);
  assert.deepEqual(new BigUint64Array(sharedMemory.buffer, sp, n), nbTable(...c));
}
// Distinct tables would exceed 8 MiB if retained; grouped sampling uses one reusable CDF.
const many = w.porw_alloc(50 * 10), manyOut = w.porw_alloc(50 * 4), oneRow = w.porw_alloc(8);
new Uint32Array(w.memory.buffer, oneRow, 2).set([1, 65535]);
dv = new DataView(w.memory.buffer);
for (let i = 0; i < 50; i++) {
  dv.setUint32(many + i * 10, i, true);
  dv.setUint32(many + i * 10 + 4, i + 1, true);
  dv.setInt16(many + i * 10 + 8, 4096 + i, true);
}
const before = w.porw_heap_mark();
const memoryBefore = w.memory.buffer.byteLength;
assert.equal(w.porw_sample_records(many, 50, 0, 0, 0xffffffff, oneRow, 1, manyOut), 0);
assert.equal(w.porw_heap_mark(), before);
assert.ok(
    w.memory.buffer.byteLength - memoryBefore <= 7 * 65536, 'fixed scratch independent of distinct counts');
console.log(
    'Python reference, random CDFs, inverse boundaries, shared kernel, bounded grouped scratch passed');
