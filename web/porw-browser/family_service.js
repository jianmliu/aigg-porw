// Family execution is isolated from residency memory. The resolver supplies chain-verified admission;
// this boundary re-derives exact child identity and journals every obligation before any delivery.
import { NodeService } from './node_service.js';
import { hex, unhex } from './verify.js';
import { applyDelta, decodeDelta3, deltaId, LAYOUT } from './delta.js';
const id32 = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const lower = x => typeof x === 'string' ? x.toLowerCase() : x;
const canonical = x => JSON.stringify(sort(x));
function sort(x) { if (Array.isArray(x)) return x.map(sort); if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])); return x; }
function request(env) { const {reqId,replyTo,...payload}=env.payload; return {type:env.type,mepId:lower(env.mepId),payload}; }
const bytes = x => x instanceof Uint8Array ? x : new Uint8Array(x);
const ZERO = '0x'+'00'.repeat(32);
export class FamilyNodeService {
  constructor(node,client,{resolve,createNode,journal,onResult=null,onStatus=null,maxAncestors=8,maxDepth=8,maxRecipeBytes=512*1024,maxWorkingBytes=2*1024*1024*1024,maxRuns=64}={}) {
    Object.assign(this,{node,client,resolve,createNode,journal,onResult,onStatus,maxAncestors,maxDepth,maxRecipeBytes,maxWorkingBytes,maxRuns});
    this.active=null; this.stopped=false; this.unsubs=[];
  }
  serve() { for(const type of ['task-announce','batch-announce']) this.unsubs.push(this.client.serve(type,null,env=>this.handle(env))); }
  stop() { this.stopped=true; for(const u of this.unsubs)u(); }
  status(env,phase,error) { this.onStatus?.({taskId:env.payload.taskId,mepId:env.mepId,phase,...(error?{error}: {})}); }
  handle(env) {
    if(!['task-announce','batch-announce'].includes(env.type)||!env.payload||!id32(env.payload.taskId)||!id32(env.mepId))return Promise.resolve(null);
    // Loaded legacy models are owned by their own service, unless enrolled explicitly as a family root.
    const resident=this.node.models.get(lower(env.mepId)); if(resident&&!resident.family)return Promise.resolve(null);
    const taskId=lower(env.payload.taskId), fingerprint=canonical(request(env));
    const refuse=reason=>({type:'result-refused',payload:{taskId,reason}});
    if(this.stopped)return Promise.resolve(refuse('family service stopped'));
    if(this.active) return this.active.taskId===taskId&&this.active.fingerprint===fingerprint ? this.active.promise : Promise.resolve(refuse('family execution slot busy or task identity conflict'));
    const promise=this.run(env,fingerprint).catch(e=>{this.status(env,'refused',String(e.message||e));return refuse(String(e.message||e));}).finally(()=>{this.active=null;});
    this.active={taskId,fingerprint,promise}; return promise;
  }
  async run(env,fingerprint) {
    this.status(env,'validating');
    const old=await this.journal.get(lower(env.payload.taskId));
    if(old) { if(old.fingerprint!==fingerprint)throw new Error('task identity conflicts with replay journal'); this.status(env,'replayed'); try { await this.onResult?.(this.submission(old.response.payload)); } catch {} return old.response; }
    const manifest=await this.resolve(env);
    if(this.stopped)throw new Error('family service stopped');
    if(lower(manifest.taskId)!==lower(env.payload.taskId)||lower(manifest.mep?.mepId)!==lower(env.mepId)||lower(manifest.payload?.taskId)!==lower(manifest.taskId))throw new Error('manifest task identity mismatch');
    this.status(env,'deriving');
    const response=await this.execute(manifest,env.type);
    if(this.stopped)throw new Error('family service stopped');
    const record={taskId:lower(manifest.taskId),fingerprint,request:request(env),manifest,response,createdAt:Date.now()};
    // Atomic bounded put MUST finish before a signature reaches either transport or onResult.
    await this.journal.put(record);
    this.status(env,'journaled');
    try { await this.onResult?.(this.submission(response.payload)); } catch {} // journal remains available for retry
    return response;
  }
  submission(payload) { const { counts, countsEncoding, ...result } = payload; return result; }
  async execute(manifest,type) {
    const m=manifest.mep,p=manifest.payload,baseId=lower(manifest.baseMepId),base=this.node.models.get(baseId);
    if(!base?.family||lower(m.enrollmentMepId)!==baseId)throw new Error('family base is not hosted');
    const root=lower(m.mepId)===baseId;
    if(!root&&lower(m.baseMepId)!==baseId)throw new Error('child base binding mismatch');
    if(!Number.isSafeInteger(p.steps)||p.steps<1||p.steps>base.maxSteps||!Number.isSafeInteger(p.commitStride)||p.commitStride<1||p.commitStride>0xffffffff||!id32(p.initStateRoot))throw new Error('task exceeds family execution capacity or has invalid parameters');
    if(type==='batch-announce'&&(!Array.isArray(p.runs)||p.runs.length<2||p.runs.length>this.maxRuns))throw new Error('batch exceeds family execution capacity');
    const ancestors=manifest.ancestors||[]; if(ancestors.length>this.maxAncestors)throw new Error('ancestry count limit');
    let total=manifest.delta?bytes(manifest.delta).length:0; const recipes=new Map();
    for(const a of ancestors) { const b=bytes(a.bytes),id=lower(a.id); total+=b.length; if(!id32(id)||hex(deltaId(b))!==id||recipes.has(id))throw new Error('ancestor content hash mismatch or duplicate'); recipes.set(id,b); }
    if(total>this.maxRecipeBytes)throw new Error('recipe byte limit');
    // JS keeps a genotype per ancestor; the ephemeral kernel also needs CSR, proofs and checkpoints.
    const estimated=base.nTiles*4096*3+base.hdr.synapses*(32+(ancestors.length+1)*4)+base.hdr.neurons*(512+(["spmv","int-spmv-q16"].includes(m.exec)?128*p.steps:16*Math.ceil(p.steps/32)));
    if(estimated>this.maxWorkingBytes)throw new Error('family derivation and execution memory limit');
    let payload=new Uint8Array(this.node.k.u8(base.bufPtr,base.nTiles*4096));
    if(!root) {
      if(!manifest.delta)throw new Error('child recipe missing');
      const delta=bytes(manifest.delta),path=new Set(),depths=new Map();
      const visit=(b,depth)=>{if(depth>this.maxDepth)throw new Error('ancestry depth limit'); const id=hex(deltaId(b));if(path.has(id))throw new Error('ancestry cycle');if((depths.get(id)??-1)>=depth)return;depths.set(id,depth);path.add(id);
        const d=decodeDelta3(b);if(d.layout!==LAYOUT.inplace||hex(d.baseModelId)!==hex(base.modelId)||d.neurons!==base.hdr.neurons||new TextEncoder().encode(d.name).length!==base.hdr.neuronOffset-30)throw new Error('recipe family or layout mismatch');
        for(const pid of [d.parentA,d.parentB].map(hex))if(pid!==ZERO){const par=recipes.get(pid);if(!par)throw new Error('missing ancestor recipe');visit(par,depth+1);}path.delete(id);};
      visit(delta,0);
      if(depths.size!==recipes.size+1)throw new Error('unused or duplicate ancestor recipe');
      payload=applyDelta(payload,delta,{baseModelId:base.modelId,resolve:id=>recipes.get(id)});
    } else if(manifest.delta||ancestors.length)throw new Error('root task cannot use child recipe');
    let child=await this.createNode();
    try {
      const terms=m.beneficiary&&lower(m.beneficiary)!=='0x'+'00'.repeat(20)?{beneficiary:m.beneficiary,royaltyBps:Number(m.royaltyBps)}:null;
      const st=await child.loadModel('family-task',payload,{maxSteps:p.steps,exec:({ 'int-lif':'lif','int-spmv-q16':'spmv' }[m.exec]||m.exec),wUnitQ16:Number(m.wUnitQ16||0),baseMepId:root?null:m.baseMepId,terms});
      if(hex(st.modelId)!==lower(m.modelId)||hex(st.mep.mepId)!==lower(m.mepId)||st.hdr.neurons!==Number(m.neurons)||st.hdr.synapses!==Number(m.synapses))throw new Error('derived child model or exact MEP mismatch');
      const handlers=new Map(); const service=new NodeService(child,{serve:(t,id,h)=>{handlers.set(t,h);return ()=>{};}},{maxRunsPerBatch:this.maxRuns});
      service.serve(st.mep.mepId);
      const response=await handlers.get(type)({type,mepId:hex(st.mep.mepId),payload:p});
      if(response?.type!=='result')throw new Error(response?.payload?.reason||'execution refused');
      return response;
    } finally { child.models.clear();child.deltaBases.clear();child=null;payload=null; }
  }
  async replay(taskId) {
    if(this.active)throw new Error('family execution slot busy');
    const promise=(async()=>{const record=await this.journal.get(lower(taskId));if(!record)throw new Error('replay record missing');
      const response=await this.execute(record.manifest,record.request.type);
      const commitments = r => { const { signature, signer, delegation, ...rest } = r.payload; return rest; };
      if(canonical(commitments(response))!==canonical(commitments(record.response)))throw new Error('replay result mismatch');
      return {verified:true,taskId:record.taskId,res:record.response.payload};})();
    this.active={taskId:lower(taskId),fingerprint:'replay',promise};try{return await promise;}finally{this.active=null;}
  }
}
