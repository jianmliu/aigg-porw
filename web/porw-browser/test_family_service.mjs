import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FamilyNodeService } from './family_service.js';
import { PorwNode } from './node.js';
import { loadKernelFromBytes } from './porw.js';
import { synthesizePayloadV2 } from './synth.js';
import { encodeDelta3, applyDelta, modelIdOf, deltaId } from './delta.js';
import { hex } from './verify.js';
const wasm = fs.readFileSync(new URL('./sketch.wasm', import.meta.url));
const createNode = async () => new PorwNode(await loadKernelFromBytes(wasm), { privHex: '11'.repeat(32) });
const node = await createNode(), base = synthesizePayloadV2('base', 16, 40);
const st = await node.loadModel('base', base), baseId = hex(st.mep.mepId); st.family = true;
const zero = new Uint8Array(32), delta = encodeDelta3({baseModelId:modelIdOf(base), neurons:16,parentA:zero,parentB:zero,seed:1n,name:'kid1',layout:1});
const reference = await createNode(), child = await reference.loadModel('kid1', applyDelta(base,delta), {baseMepId:baseId,maxSteps:2});
const childId = hex(child.mep.mepId), taskId = '0x'+'23'.repeat(32);
const run = await reference.execute(child.mep.mepId,{steps:2,commitStride:1,stimulusSeed:4});
const payload = {taskId,steps:2,commitStride:1,stimulusSeed:4,initStateRoot:hex(run.result.initStateRoot)};
const env = {type:'task-announce',mepId:childId,payload};
let manifest = {taskId,baseMepId:baseId,mep:{mepId:childId,modelId:hex(child.modelId),baseMepId:baseId,enrollmentMepId:baseId,exec:'lif',wUnitQ16:0,neurons:16,synapses:child.hdr.synapses},payload,delta,ancestors:[]};
let resolves=0, allocations=0, delivered=0;
const records = new Map(), journal={get:async id=>records.get(id),put:async r=>records.set(r.taskId,structuredClone(r))};
const service = new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>{resolves++;return structuredClone(manifest)},createNode:async()=>{allocations++;return createNode()},journal,onResult:()=>{delivered++}});
const mark=node.k.mark();
const [a,b]=await Promise.all([service.handle(env),service.handle(env)]);
assert.equal(a.type,'result'); assert.deepEqual(a,b); assert.equal(resolves,1); assert.equal(allocations,1); assert.equal(records.size,1); assert.equal(delivered,1); assert.equal(node.k.mark(),mark); assert.equal(node.models.size,1);
assert.equal((await service.handle({...env,mepId:'0x'+'99'.repeat(32)})).type,'result-refused');
assert.equal((await service.replay(taskId)).verified,true); assert.equal(node.k.mark(),mark);
const next = {...env,payload:{...payload,taskId:'0x'+'24'.repeat(32)}};
manifest={...manifest,taskId:next.payload.taskId,payload:next.payload};
assert.equal((await service.handle(next)).type,'result'); assert.equal(allocations,3);
manifest={...manifest,mep:{...manifest.mep,modelId:'0x'+'99'.repeat(32)},taskId:'0x'+'25'.repeat(32),payload:{...payload,taskId:'0x'+'25'.repeat(32)}};
assert.equal((await service.handle({...env,payload:manifest.payload})).type,'result-refused');
const fail = new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>({...manifest,mep:{...manifest.mep,modelId:hex(child.modelId)}}),createNode,journal:{get:async()=>null,put:async()=>{throw new Error('disk full')}},onResult:()=>{throw new Error('MUST NOT DELIVER')}});
assert.match((await fail.handle({...env,payload:manifest.payload})).payload.reason,/disk full/);
console.log('PASS family runtime: actual WASM child, dedup, isolation, journal, replay, identity, storage refusal');
// Admission concurrency: a new task cannot allocate while another is resolving.
let unblock; const gate=new Promise(r=>{unblock=r});
const slow=new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>{await gate;throw new Error('admission rejected')},createNode,journal:{get:async()=>null,put:async()=>{}}});
const waiting=slow.handle(env);assert.match((await slow.handle(next)).payload.reason,/busy/);unblock();await waiting;
const good={...manifest,mep:{...manifest.mep,modelId:hex(child.modelId)}};
for (const [label,change] of [
  ['wrong family',{baseMepId:'0x'+'44'.repeat(32)}],
  ['ancestor hash',{ancestors:[{id:'0x'+'11'.repeat(32),bytes:delta}]}],
  ['recipe bytes',{delta:new Uint8Array(512*1024+1)}],
  ['invalid recipe',{delta:new Uint8Array(8)}],
  ['step capacity',{payload:{...good.payload,steps:st.maxSteps+1}}],
]) {
  const s=new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>({...good,...change}),createNode,journal:{get:async()=>null,put:async()=>{throw new Error('must not journal invalid')}}});
  assert.equal((await s.handle({...env,payload:good.payload})).type,'result-refused',label);
}
// Root task admission uses the resident root but executes in isolated memory.
const rootRun=await node.execute(st.mep.mepId,{steps:2,commitStride:1,stimulusSeed:4});
const rootPayload={...payload,taskId:'0x'+'30'.repeat(32),initStateRoot:hex(rootRun.result.initStateRoot)};
const rootManifest={taskId:rootPayload.taskId,baseMepId:baseId,mep:{mepId:baseId,modelId:hex(st.modelId),enrollmentMepId:baseId,exec:'lif',neurons:st.hdr.neurons,synapses:st.hdr.synapses},payload:rootPayload,delta:null,ancestors:[]};
const roots=new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>rootManifest,createNode,journal});
assert.equal((await roots.handle({type:'task-announce',mepId:baseId,payload:rootPayload})).type,'result');
const baseClaim=await node.residency(st.mep.mepId,new Uint8Array(32).fill(1)); assert.ok(baseClaim.signature);
console.log('PASS family bounds, root admission, base residency after child execution');
const rotated=new FamilyNodeService(node,{serve:()=>()=>{}},{createNode:async()=>new PorwNode(await loadKernelFromBytes(wasm),{privHex:'22'.repeat(32)}),journal});
assert.deepEqual((await rotated.replay(taskId)).res,a.payload,'replay returns original signature after session rotation');
const delta2=encodeDelta3({baseModelId:modelIdOf(base),neurons:16,parentA:deltaId(delta),parentB:zero,seed:2n,name:'kid2',layout:1});
const child2=await reference.loadModel('kid2',applyDelta(base,delta2,{resolve:id=>id===hex(deltaId(delta))?delta:null}),{baseMepId:baseId,maxSteps:2});
const runs=[{stimulusSeed:1},{stimulusSeed:2}];const br=await reference.executeBatch(child2.mep.mepId,{steps:2,commitStride:1,runs});
const batchPayload={taskId:'0x'+'40'.repeat(32),steps:2,commitStride:1,runs,initStateRoot:hex(br.result.initStateRoot)};
const batchManifest={taskId:batchPayload.taskId,baseMepId:baseId,mep:{...good.mep,mepId:hex(child2.mep.mepId),modelId:hex(child2.modelId)},payload:batchPayload,delta:delta2,ancestors:[{id:hex(deltaId(delta)),bytes:delta}]};
const batch=new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>batchManifest,createNode,journal});
const bout=await batch.handle({type:'batch-announce',mepId:batchManifest.mep.mepId,payload:batchPayload});assert.equal(bout.type,'result');assert.equal(bout.payload.runs.length,2);
assert.equal((await batch.replay(batchPayload.taskId)).verified,true);
const missing=new FamilyNodeService(node,{serve:()=>()=>{}},{resolve:async()=>({...batchManifest,ancestors:[]}),createNode,journal:{get:async()=>null,put:async()=>{throw new Error('must not persist')}}});
assert.match((await missing.handle({type:'batch-announce',mepId:batchManifest.mep.mepId,payload:batchPayload})).payload.reason,/missing ancestor/);
console.log('PASS inherited child batch, missing ancestry, replay after signing-key rotation');
