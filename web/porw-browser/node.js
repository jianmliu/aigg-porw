// PorwNode: the browser/Node-side prover. Holds one or more models resident in wasm memory
// (e.g. the female and male fly brains, each its own MEP), answers epoch challenges per MEP with a
// signed RESIDENCY claim, executes TASKS on request, and opens tiles.
//
// Those are two jobs, and scheme sketch-tile-keccak (since v2) stops pretending they are one: `residency()`
// sketches the resident tiles and signs the claim (no inference -- nothing ever adjudicated it), and
// `execute()` runs the model for a task with the step count and commit stride the task specifies.
import { TILE_BYTES, attachTrees, treeNodeAt, treeBuildParallel } from "./porw.js";
import { isDelta2, isDelta3, decodeDelta3, applyDelta } from "./delta.js";
import { uploadDeltaBase, applyDeltaWasm } from "./delta_wasm.js";
import { decodeHeader, attachSpmv } from "./model.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { claimHash, signHash, keypair } from "./claim.js";
import { makeMep, withTerms } from "./mep.js";
import { hex, CSR_CHUNK, instanceWord, merkleProof, merkleRoot } from "./verify.js";
import { batchTrees, levelsOf, childrenAt, runLeaf } from "./batch.js";
import { claimDigest } from "./eip712.js";
import { lifExecKind, countsDigest, decodeState, encodeState, transition } from "./lif.js";
const LIF_STATE = 16, LIF_CHECKPOINT = 32;
const busyMemories = new WeakSet();

export class PorwNode {
  // Internal helpers compose within the operation; public entry points acquire it once.
  buildTree(...args) { return this.withKernelOperation(() => this._buildTree(...args)); }
  residency(...args) { return this.withKernelOperation(() => this._residency(...args)); }
  execute(...args) { return this.withKernelOperation(() => this._execute(...args)); }
  executeBatch(...args) { return this.withKernelOperation(() => this._executeBatch(...args)); }
  batchOpenRun(...args) { return this.withKernelOperation(() => this._batchOpenRun(...args)); }
  batchRunsRoot(...args) { return this.withKernelOperation(() => this._batchRunsRoot(...args)); }
  challenge(...args) { return this.withKernelOperation(() => this._challenge(...args)); }
  runInference(...args) { return this.withKernelOperation(() => this._runInference(...args)); }
  lifStep(...args) { return this.withKernelOperation(() => this._lifStep(...args)); }
  lifCommit(...args) { return this.withKernelOperation(() => this._lifCommit(...args)); }
  runLif(...args) { return this.withKernelOperation(() => this._runLif(...args)); }
  lifStateAt(...args) { return this.withKernelOperation(() => this._lifStateAt(...args)); }
  lifSegmentRoots(...args) { return this.withKernelOperation(() => this._lifSegmentRoots(...args)); }
  lifNode(...args) { return this.withKernelOperation(() => this._lifNode(...args)); }
  lifOpenState(...args) { return this.withKernelOperation(() => this._lifOpenState(...args)); }
  lifPartialSums(...args) { return this.withKernelOperation(() => this._lifPartialSums(...args)); }
  lifStates(...args) { return this.withKernelOperation(() => this._lifStates(...args)); }
  async _buildTree(leavesPtr, n, treePtr) { return this.pool ? treeBuildParallel(this.pool, leavesPtr, n, treePtr) : this.k.treeBuildInto(leavesPtr, n, treePtr); }
  /** `domains.claimManager` / `domains.market`: EIP-712 domains (chainId, verifying contract) — claims and results are then
   *  signed as typed data by this node's key (the wallet itself, or a session key the wallet delegated: `delegation`). */
  constructor(kernel, { privHex = null, pool = null, domains = null, delegation = null } = {}) {
    this.domains = domains; this.delegation = delegation;
    this.k = attachTrees(attachSpmv(kernel, kernel.exports));
    this.pool = pool; // shared-memory worker pool (kernel must be pool.kernel when set)
    this.key = keypair(privHex);
    this.models = new Map(); // mepId hex -> resident model state
    this.deltaBases = new Map(); // model id -> immutable resident base handle; no JS payload retained
    this.lies = new Map();   // test hook: `${mepIdHex}:${tileIdx}` -> corrupted sketch
  }
  /** Load a released fly-brain payload and register it under a MEP. */
  /** `maxSteps`: the largest task this slot's per-step buffers are sized for. It is a local capacity, not
   *  part of the MEP -- the step count of an actual run comes from the task. */
  // Heap marks are shared by every wrapper of a memory. A replay may rewind
  // scratch after an await, so it must not overlap loading or another replay.
  async withKernelOperation(fn) {
    if (busyMemories.has(this.k.memory)) throw new Error("a kernel operation is already in progress");
    busyMemories.add(this.k.memory);
    try { return await fn(); } finally { busyMemories.delete(this.k.memory); }
  }
  async withModelLoad(fn) {
    return this.withKernelOperation(async () => {
      const mark = this.k.mark(), bases = new Set(this.deltaBases.keys());
      try { return await fn(); }
      catch (error) {
        this.k.release(mark);
        for (const id of this.deltaBases.keys()) if (!bases.has(id)) this.deltaBases.delete(id);
        throw error;
      }
    });
  }
  async loadModel(name, payloadBytes, opts = {}) {
    return this.withModelLoad(() => {
      const hdr = decodeHeader(payloadBytes), byteLength = payloadBytes.length;
      return this._loadResidentModel(name, { kernel: this.k, ptr: this.k.put(payloadBytes), byteLength, hdr }, opts);
    });
  }
  /** Internal adoption: the caller owns this payload in the same kernel, with no second k.put. */
  async _loadResidentModel(name, resident, { maxSteps = 2, exec = null, wUnitQ16 = 0, terms = null } = {}) {
    const k = this.k, t0 = performance.now();
    if (resident.kernel !== k) throw new Error("resident payload belongs to another kernel");
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
    const bufPtr = resident.ptr, nTiles = Math.floor(resident.byteLength / TILE_BYTES), hdr = resident.hdr;
    const e = k.exports, nodes = k.treeNodes(nTiles);
    const wLeavesPtr = k.alloc(nTiles * 32);
    if (this.pool) await this.pool.map("porw_weights_leaves", nTiles, (f, c) => [bufPtr + f * TILE_BYTES, c, f, wLeavesPtr + f * 32]);
    else e.porw_weights_leaves(bufPtr, nTiles >>> 0, 0, wLeavesPtr);
    const weightsTree = await this._buildTree(wLeavesPtr, nTiles, k.alloc(nodes * 32));
    const modelId = weightsTree.root;
    exec = exec || (hdr.version === 2 ? "lif" : "spmv"); if (exec === "lif" && hdr.version !== 2) throw new Error("int-lif needs a v2 payload");
    // fixed per-slot regions, reused every challenge (no allocation growth)
    const csr = { rowStartPtr: k.alloc((hdr.neurons + 1) * 4), permPtr: k.alloc(hdr.synapses * 4) };
    { const cur = k.mark(); const cursor = k.alloc(hdr.neurons * 4); const rc = e.porw_csr_build(bufPtr + hdr.synOffset, hdr.synapses >>> 0, hdr.neurons >>> 0, csr.rowStartPtr, csr.permPtr, cursor); k.release(cur); if (rc !== 0) throw new Error("csr build rc=" + rc); }
    // CSR commitments (once per model): chunk leaves over perm order, rowStart leaves; synapseRoot = keccak(csrRoot || rowRoot)
    const syn = bufPtr + hdr.synOffset, n = hdr.neurons, ns = hdr.synapses;
    csr.chunk = CSR_CHUNK; csr.nChunks = Math.ceil(ns / CSR_CHUNK);
    csr.sorted = e.porw_csr_is_identity(csr.permPtr, ns >>> 0) === 1; // publication convention: records post-sorted -> direct streaming rows
    const csrLeaves = k.alloc(csr.nChunks * 32), rowLeaves = k.alloc((n + 1) * 32);
    if (this.pool) { await this.pool.map("porw_csr_chunk_leaves", csr.nChunks, (f, c) => [syn, csr.permPtr, ns, CSR_CHUNK, f, c, csrLeaves + f * 32]);
                     await this.pool.map("porw_rowstart_leaves", n + 1, (f, c) => [csr.rowStartPtr + f * 4, c, f, rowLeaves + f * 32]); }
    else { if (e.porw_csr_chunk_leaves(syn, csr.permPtr, ns >>> 0, CSR_CHUNK, 0, csr.nChunks >>> 0, csrLeaves) !== 0) throw new Error("csr leaves");
           e.porw_rowstart_leaves(csr.rowStartPtr, (n + 1) >>> 0, 0, rowLeaves); }
    csr.csrTree = await this._buildTree(csrLeaves, csr.nChunks, k.alloc(k.treeNodes(csr.nChunks) * 32));
    csr.rowTree = await this._buildTree(rowLeaves, n + 1, k.alloc(k.treeNodes(n + 1) * 32));
    csr.synapseRoot = k.keccak256(new Uint8Array([...csr.csrTree.root, ...csr.rowTree.root]));
    // the MEP is derivable only now: mep_id binds the CSR structure as well as the weights
    let mep = makeMep({ name, modelId, execKind: exec === "lif" ? lifExecKind(wUnitQ16 || undefined) : undefined, neurons: hdr.neurons, synapses: hdr.synapses, synapseRoot: csr.synapseRoot });
    // A profile registered under TERMS is a different mep_id from the very same bytes -- keccak(profileId,
    // beneficiary, royaltyBps) -- and the terms are nowhere in the payload, so a node cannot derive them. A host
    // serving such a profile has to be TOLD them, or it registers the model under the bare id while the chain draws
    // it under the other one, and every announcement and execution for that task looks up a model this node has
    // never heard of. `terms` is that telling: { beneficiary, royaltyBps }, checked by withTerms.
    if (terms) mep = withTerms(mep, terms.beneficiary, terms.royaltyBps);
    // per-step activation arrays + leaves + trees (act_0 = stimulus, act_1..steps)
    const actN = k.treeNodes(n);
    const acts = []; if (exec === "spmv") for (let sIdx = 0; sIdx <= maxSteps; sIdx++) acts.push({ ptr: k.alloc(n * 4), leavesPtr: sIdx ? k.alloc(n * 32) : 0, treePtr: sIdx ? k.alloc(actN * 32) : 0, tree: null });
    // int-lif: ping-pong state buffers + checkpoints every LIF_CHECKPOINT steps (openings replay from the nearest one);
    // one leaves/tree region reused per step (only the roots are kept), a small materialized-step cache for disputes
    const lif = exec === "lif" ? { ping: k.alloc(n * LIF_STATE), pong: k.alloc(n * LIF_STATE), leavesPtr: k.alloc(n * 32), treePtr: k.alloc(actN * 32), acc: k.alloc(n * 8),
      checkpoints: new Map(), cache: new Map(), counts: k.alloc(n * 4) } : null;
    if (lif) for (let sIdx = 0; sIdx <= maxSteps; sIdx += LIF_CHECKPOINT) lif.checkpoints.set(sIdx, k.alloc(n * LIF_STATE));
    const slot = { sketchesPtr: k.alloc(nTiles * 4), pLeavesPtr: k.alloc(nTiles * 32), pTreePtr: k.alloc(nodes * 32), acts, lif };
    const st = { mep, exec, wUnitQ16: exec === "lif" ? (wUnitQ16 >>> 0) : 0, bufPtr, nTiles, hdr, weightsTree, modelId, slot, csr, maxSteps, steps: 0, commitStride: 1, leavesMs: performance.now() - t0 }; // wUnitQ16 0: the kind's default unit
    this.models.set(hex(mep.mepId), st);
    return st;
  }
  /** Load a FLYDELTA delta on top of its base payload: the applied bytes are the model (same model_id / MEP as
   *  publishing them directly); `st.delta` records the binding. `baseModelId` skips recomputing the base's id.
   *  `opts` reaches loadModel, so a caller sizes this slot with `maxSteps` the same way. */
  loadDeltaBase(bytes, opts = {}) {
    if (busyMemories.has(this.k.memory)) throw new Error("a kernel operation is already in progress");
    return this._registerDeltaBase(bytes, opts);
  }
  _registerDeltaBase(bytes, opts) {
    const mark = this.k.mark(), candidate = uploadDeltaBase(this.k, bytes, opts), id = hex(candidate.modelId);
    const resident = this.deltaBases.get(id);
    if (resident) this.k.release(mark); else this.deltaBases.set(id, candidate);
    const handle = resident || candidate;
    return handle;
  }
  async loadDelta(baseBytes, deltaBytes, { baseModelId = null, resolve = null, ...opts } = {}) {
    if (isDelta3(deltaBytes) && decodeDelta3(deltaBytes).layout === 1) {
      // in-place layout: the reference implementation writes it (delta.js); the resident WASM path only knows the compact one
      const bytes = baseBytes instanceof Uint8Array ? baseBytes : new Uint8Array(this.k.u8(baseBytes.ptr, baseBytes.byteLength));
      const d3 = decodeDelta3(deltaBytes); const payload = applyDelta(bytes, deltaBytes, { baseModelId: baseBytes instanceof Uint8Array ? baseModelId : baseBytes.modelId, resolve });
      const st3 = await this.loadModel(d3.name, payload, opts);
      st3.delta = { version: 3, layout: 1, parents: [d3.parentA, d3.parentB], baseModelId: d3.baseModelId, baseDA: d3.baseDA, ops: 0, seed: d3.seed, bytes: deltaBytes.length };
      return st3;
    }
    return this.withModelLoad(async () => {
      const base = baseBytes instanceof Uint8Array ? this._registerDeltaBase(baseBytes, { baseModelId }) : baseBytes;
      const applied = applyDeltaWasm(this.k, base, deltaBytes, { resolve }), d = applied.delta;
      const st = await this._loadResidentModel(d.name, applied, opts);
      st.delta = { version: isDelta3(deltaBytes) ? 3 : isDelta2(deltaBytes) ? 2 : 1, parents: d.parentA ? [d.parentA, d.parentB] : null, baseModelId: d.baseModelId, baseDA: d.baseDA, ops: d.ops.length, seed: d.seed ?? null, bytes: deltaBytes.length };
      return st;
    });
  }
  /** A residency claim: sketch every resident tile under a challenge the instance cannot choose, commit the
   *  sketches, sign. That is all of it. No inference happens here, because no verdict ever read one: a claim
   *  is invalidated only by the tile fraud proof, which adjudicates a challenged tile against `partialsRoot`
   *  and the model root. Execution belongs to `execute()` and is attested per task. */
  async _residency(mepId, challenge32) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP");
    const k = this.k, n = st.nTiles, t = {};
    let t0 = performance.now();
    // the seed is the claiming INSTANCE's: the bonded wallet when this key is a delegated session key, else this key's address
    st.slotSeed = k.slotSeed(challenge32, instanceWord(this.delegation?.instance || this.key.address));
    const e = k.exports, sl = st.slot;
    if (this.pool) await this.pool.map("porw_sketch_tiles", n, (f, c) => [st.bufPtr + f * TILE_BYTES, c, f, st.slotSeed, sl.sketchesPtr + f * 4]);
    else k.sketch(st.bufPtr, n, 0, st.slotSeed, sl.sketchesPtr);
    // views into wasm memory detach when it grows: never cache them, re-view on access
    for (const [key, v] of this.lies) { const [mid, idx] = key.split(":"); if (mid === hex(mepId)) k.u32(sl.sketchesPtr, n)[+idx] = v; }
    t.sketchMs = performance.now() - t0; t0 = performance.now();
    if (this.pool) await this.pool.map("porw_partials_leaves", n, (f, c) => [0, sl.sketchesPtr + f * 4, c, f, sl.pLeavesPtr + f * 32]);
    else e.porw_partials_leaves(0, sl.sketchesPtr, n >>> 0, 0, sl.pLeavesPtr);
    st.partialsTree = await this._buildTree(sl.pLeavesPtr, n, sl.pTreePtr);
    st.partialsRoot = st.partialsTree.root;
    t.commitMs = performance.now() - t0;
    const claim = { schemeDigest: st.mep.schemeDigest, mepId: st.mep.mepId, modelId: st.modelId, partialsRoot: st.partialsRoot,
      coverageBytes: n * TILE_BYTES, challenge: challenge32 };
    const h = claimHash(claim); const digest = this.domains?.claimManager ? claimDigest(this.domains.claimManager, claim) : h; // EIP-712 when a domain is configured
    return { claim, claimHash: h, digest, signature: signHash(digest, this.key.priv), address: this.key.address, delegation: this.delegation, timings: t };
  }

  /** Execute this model for a task. `steps` and `commitStride` come from the Task, not from the MEP.
   *  `commit`: also build the per-step (spmv) or per-segment (int-lif) state commitments an execution
   *  DISPUTE needs -- on the real brain that is the majority of the work, and it is only ever read when
   *  two executors of the same task disagree, so a caller that just wants the answer can skip it. */
  async _execute(mepId, { steps = 1, commitStride = 1, stimulusSeed = 1, stimulusIds = null, silenceIds = null, commit = true } = {}) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP");
    if (!(steps >= 1 && steps <= st.maxSteps)) throw new Error(`steps ${steps} exceeds this slot's capacity (${st.maxSteps})`);
    if (!(commitStride >= 1 && commitStride <= steps)) throw new Error("commitStride must be in 1..steps");
    st.steps = steps; st.commitStride = commitStride;
    const k = this.k, sl = st.slot, t = {}; let t0 = performance.now();
    if (st.exec === "lif") {
      // canonical stimulus set from the seed (or an explicit task set); commitments are folded into the run
      const r = await this._runLif(st, stimulusSeed, stimulusIds, commit, silenceIds);
      st.execDigest = r.execDigest; st.actRoots = r.stateRoots; st.execRoot = r.execRoot; st.initStateRoot = r.initStateRoot; st.stimulated = r.stimulated; st.counts = r.counts;
      t.inferMs = r.inferMs; t.disputeCommitMs = r.commitMs;
    } else {
      const e = k.exports;
      e.porw_spmv_stimulus(sl.acts[0].ptr, st.hdr.neurons >>> 0, stimulusSeed >>> 0);
      await this._runInference(st);
      const last = sl.acts[st.steps].ptr, a = k.u32(last, st.hdr.neurons);
      st.execDigest = keccak_256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      t.inferMs = performance.now() - t0; t0 = performance.now();
      // dispute commitments: per-step activation roots, execRoot = merkle(actRoots)
      st.actRoots = [];
      if (commit) for (let sIdx = 1; sIdx <= st.steps; sIdx++) {
        const A = sl.acts[sIdx], nn = st.hdr.neurons;
        if (this.pool) await this.pool.map("porw_act_leaves", nn, (f, c) => [A.ptr + f * 4, c, f, A.leavesPtr + f * 32]);
        else e.porw_act_leaves(A.ptr, nn >>> 0, 0, A.leavesPtr);
        A.tree = await this._buildTree(A.leavesPtr, nn, A.treePtr); st.actRoots.push(A.tree.root);
      }
      st.execRoot = commit ? k.merkleRoot(new Uint8Array(st.actRoots.flatMap((r) => [...r]))) : null;
      t.disputeCommitMs = performance.now() - t0;
    }
    return { steps, commitStride, timings: t,
      result: { execDigest: st.execDigest, execRoot: st.execRoot, actRoots: st.actRoots, csrRoot: st.csr.csrTree.root, rowRoot: st.csr.rowTree.root, synapseRoot: st.csr.synapseRoot,
                initStateRoot: st.initStateRoot || null, stimulated: st.stimulated ?? null,
                // int-lif: every neuron's spike count -- the run's readable output, and exactly what execDigest hashes
                // (lif.js countsDigest), so whoever is handed it can check it against the digest the task settled on
                counts: st.exec === "lif" ? st.counts : null } };
  }

  /** Execute a BATCH (TaskMarket.postBatch): `runs` = [{ stimulusSeed, stimulusIds?, silenceIds? }], all under the
   *  task's `steps` and `commitStride`. Each run is an ordinary committed run; what is kept of it is its seed, its
   *  state_0 root and its execRoot (and its counts digest, which is for the dataset and is not consensus). The result
   *  is the batch's: execRoot over runResultLeaf(k, execRoot_k), execDigest a function of it. `runsRoot` is what the
   *  task's initStateRoot has to be; a caller that was given the task's compares them before it signs.
   *  Only the LAST run's state is left in the slot. A dispute finds a run first (`batchNode`) and then reopens it
   *  (`batchOpenRun`), which re-executes that run so that the ordinary int-lif dispute helpers answer for it. */
  async _executeBatch(mepId, { steps = 1, commitStride = 1, runs } = {}) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP"); if (st.exec !== "lif") throw new Error("batches are int-lif only");
    const t0 = performance.now(), recs = []; let last = null;
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]; this.execLie = this.batchLie && this.batchLie.run === k ? this.batchLie.lie : null; // test hook: a lie in ONE run
      const x = await this._execute(mepId, { steps, commitStride, stimulusSeed: r.stimulusSeed >>> 0, stimulusIds: r.stimulusIds || null, silenceIds: r.silenceIds || null, commit: true });
      recs.push({ seed: r.stimulusSeed >>> 0, initStateRoot: x.result.initStateRoot, execRoot: x.result.execRoot, countsDigest: x.result.execDigest }); last = x.result;
    }
    const lieOf = (k) => (this.batchLie && this.batchLie.run === k ? this.batchLie.lie : null); this.execLie = lieOf(runs.length - 1); // the open run is the last: its replays are its own
    const T = batchTrees(recs); st.batch = { steps, commitStride, inputs: runs, runs: recs, trees: T, levels: levelsOf(T.resultLeaves), open: runs.length - 1, openResult: last };
    return { steps, commitStride, timings: { batchMs: performance.now() - t0 }, runs: recs,
      result: { execDigest: T.execDigest, execRoot: T.execRoot, initStateRoot: T.runsRoot, csrRoot: st.csr.csrTree.root, rowRoot: st.csr.rowTree.root, synapseRoot: st.csr.synapseRoot } };
  }
  /** What a CLIENT needs before it can post a batch: the task's initStateRoot, i.e. the root over the runs' seeds and
   *  state_0 roots. Builds and commits each run's state_0 and executes nothing, so it costs one state tree per run. */
  async _batchRunsRoot(mepId, runs) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP"); if (st.exec !== "lif") throw new Error("batches are int-lif only");
    const L = st.slot.lif, leaves = [], inits = [];
    for (let k = 0; k < runs.length; k++) { const r = runs[k]; this.lifState0(st, L.ping, r.stimulusSeed >>> 0, r.stimulusIds || null, r.silenceIds || null);
      const root = (await this._lifCommit(st, L.ping)).root; inits.push(root); leaves.push(runLeaf(k, r.stimulusSeed >>> 0, root)); }
    L.cache.clear(); if (st.batch) st.batch.open = -1; // the slot's state is no run's any more
    return { runsRoot: merkleRoot(leaves), initStateRoots: inits };
  }
  /** the pair this node posts to `postChildren` in the Run phase, for node (level, idx) of its run-result tree */
  batchNode(mepId, level, idx) { const b = this.models.get(hex(mepId))?.batch; if (!b) throw new Error("no batch"); return childrenAt(b.levels, level, idx); }
  /** `openRun`'s arguments for run k, and the run itself reopened: after this the int-lif dispute helpers are run k's */
  async _batchOpenRun(mepId, k) {
    const st = this.models.get(hex(mepId)), b = st?.batch; if (!b) throw new Error("no batch"); if (!(k >= 0 && k < b.runs.length)) throw new Error("run out of range");
    if (b.open !== k) { const r = b.inputs[k]; this.execLie = this.batchLie && this.batchLie.run === k ? this.batchLie.lie : null;
      const x = await this._execute(mepId, { steps: b.steps, commitStride: b.commitStride, stimulusSeed: r.stimulusSeed >>> 0, stimulusIds: r.stimulusIds || null, silenceIds: r.silenceIds || null, commit: true }); // execLie stays: the dispute helpers replay THIS run
      if (hex(x.result.execRoot) !== hex(b.runs[k].execRoot)) throw new Error("run " + k + " did not reproduce its committed execRoot"); b.open = k; b.openResult = x.result; }
    // `result` is the reopened run's own (its segment roots, its execRoot): what a single task's dispute starts from
    return { run: k, result: b.openResult, execRoot: b.runs[k].execRoot, seed: b.runs[k].seed, initStateRoot: b.runs[k].initStateRoot, inputProof: merkleProof(b.trees.inputLeaves, k), resultProof: merkleProof(b.trees.resultLeaves, k) };
  }

  /** residency + execution in one call, for callers (tests, benches) that want both under one challenge */
  async _challenge(mepId, challenge32, { steps = 1, commitStride = 1, stimulusSeed = 1, stimulusIds = null, silenceIds = null, commit = true } = {}) {
    const R = await this._residency(mepId, challenge32);
    const X = await this._execute(mepId, { steps, commitStride, stimulusSeed, stimulusIds, silenceIds, commit });
    return { ...R, result: X.result, timings: { ...R.timings, ...X.timings } };
  }

  /** steps of deterministic inference in place on actPtr; parallel CSR rows with a pool, scatter otherwise (bit-identical) */
  async _runInference(st) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, syn = st.bufPtr + st.hdr.synOffset, acts = st.slot.acts;
    for (let s = 1; s <= st.steps; s++) {
      const a = acts[s - 1].ptr, b = acts[s].ptr;
      if (this.pool && st.csr.sorted) await this.pool.map("porw_spmv_step_rows_direct", n, (i0, c) => [syn, st.csr.rowStartPtr, a, b, n, i0, i0 + c]);
      else if (this.pool) await this.pool.map("porw_spmv_step_csr_range", n, (i0, c) => [syn, st.csr.permPtr, st.csr.rowStartPtr, a, b, n, i0, i0 + c]);
      else { const m = k.mark(); const acc = k.alloc(n * 8); const rc = e.porw_spmv_step(syn, st.hdr.synapses >>> 0, a, b, acc, n >>> 0); k.release(m); if (rc !== 0) throw new Error("spmv rc=" + rc); }
      if (this.execLie && this.execLie.step === s) { const v = k.u32(b, n); v[this.execLie.neuron] = (v[this.execLie.neuron] + this.execLie.delta) >>> 0; } // test hook: a lying executor
    }
  }
  // ---- dispute openings (all from cached trees; verified by the other side with noble) ----
  activations(mepId, step) { const st = this.models.get(hex(mepId)); return new Uint32Array(this.k.u32(st.slot.acts[step].ptr, st.hdr.neurons)); }
  actNode(mepId, step, level, idx) { const st = this.models.get(hex(mepId)); return treeNodeAt(this.k, st.slot.acts[step].tree, level, idx); }
  openActivation(mepId, step, i) { const st = this.models.get(hex(mepId)); const A = st.slot.acts[step];
    return { step, i, act: this.k.u32(A.ptr, st.hdr.neurons)[i], proof: step ? this.k.treeProof(A.tree, i) : [] }; }
  openRowStart(mepId, i) { const st = this.models.get(hex(mepId)); return { i, value: this.k.u32(st.csr.rowStartPtr, st.hdr.neurons + 1)[i], proof: this.k.treeProof(st.csr.rowTree, i) }; }
  openCsrChunk(mepId, c) { const st = this.models.get(hex(mepId)), k = this.k, ns = st.hdr.synapses, CH = st.csr.chunk;
    const k0 = c * CH, k1 = Math.min(k0 + CH, ns); const perm = k.u32(st.csr.permPtr, ns); const syn = st.bufPtr + st.hdr.synOffset;
    const records = new Uint8Array((k1 - k0) * 10); for (let kk = k0; kk < k1; kk++) records.set(k.u8(syn + perm[kk] * 10, 10), (kk - k0) * 10);
    return { c, k0, records, proof: k.treeProof(st.csr.csrTree, c) }; }
  partialSums(mepId, step, i) { const st = this.models.get(hex(mepId)), k = this.k, e = k.exports, n = st.hdr.neurons;
    const R = k.u32(st.csr.rowStartPtr, n + 1); const k0 = R[i], k1 = R[i + 1]; const m = k.mark(); const out = k.alloc(Math.max(1, k1 - k0) * 8);
    const rc = e.porw_csr_partial_sums(st.bufPtr + st.hdr.synOffset, st.csr.permPtr, st.slot.acts[step - 1].ptr, n >>> 0, k0, k1, out);
    const sums = new BigUint64Array(new BigUint64Array(k.memory.buffer, out, k1 - k0)); k.release(m); if (rc !== 0) throw new Error("partial sums rc=" + rc);
    return { k0, k1, sums }; }
  open(mepId, tileIdx) {
    const st = this.models.get(hex(mepId)), k = this.k;
    return { tileIdx, position: tileIdx, tile: new Uint8Array(k.u8(st.bufPtr + tileIdx * TILE_BYTES, TILE_BYTES)),
      sketch: k.u32(st.slot.sketchesPtr, st.nTiles)[tileIdx], partialsProof: k.treeProof(st.partialsTree, tileIdx), weightsProof: k.treeProof(st.weightsTree, tileIdx) };
  }

  // ---- `aigg:exec:int-lif:v1` ----
  /** state_0 into `dst`: canonical set from the seed, or an explicit sorted id list (task input) */
  lifState0(st, dst, seed, ids, silence = null) {
    const e = this.k.exports, n = st.hdr.neurons; let stimulated;
    if (!ids) stimulated = e.porw_lif_state0_canonical(dst, n >>> 0, seed >>> 0) >>> 0;
    else { const m = this.k.mark(); const p = this.k.alloc(ids.length * 4); this.k.u32(p, ids.length).set(ids);
      const rc = e.porw_lif_state0_set(dst, n >>> 0, p, ids.length >>> 0); this.k.release(m); if (rc !== 0) throw new Error("state0 rc=" + rc); stimulated = ids.length; }
    // the silence set (flags bit2): neurons that never spike. Part of state_0, so of the task's initStateRoot
    if (silence && silence.length) { const m = this.k.mark(); const p = this.k.alloc(silence.length * 4); this.k.u32(p, silence.length).set(silence);
      const rc = e.porw_lif_state0_silence(dst, n >>> 0, p, silence.length >>> 0); this.k.release(m); if (rc !== 0) throw new Error("silence rc=" + rc); }
    return stimulated;
  }
  /** Arm the event-driven path on `statePtr` (lif_wasm.c): the index by pre, built once per model and 4 bytes a
   *  synapse, plus the touched set. `build` is false inside a mark -- a release would take the index back. Armed, a
   *  step walks the out-edges of the spikers and updates the touched instead of visiting every record: the same
   *  trajectory, bit for bit, for a fraction of the work. Unarmed (no room, or a caller that did not ask), the scatter
   *  path runs as before. The caller must have BOTH buffers holding `statePtr`'s state: untouched entries are not written. */
  _lifEventsArm(st, statePtr, build = true) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, L = st.slot.lif;
    if (L.events === undefined && build) {
      L.events = null;
      try {
        const outStart = k.alloc((n + 1) * 4), outPerm = k.alloc((st.hdr.synapses >>> 0) * 4), touched = k.alloc(n * 4), isTouched = k.alloc(n), work = k.alloc(n * 4);
        if (e.porw_lif_build_out_index(st.bufPtr + st.hdr.synOffset, st.hdr.synapses >>> 0, n >>> 0, outStart, outPerm) === 0) L.events = { outStart, outPerm, touched, isTouched, work };
      } catch { L.events = null; } // no room for the index: the scatter path is the fallback, and it is the reference
    }
    L.treeBuilt = false; // a new sequence: the first commit of it builds the whole tree, and the rest update it
    if (!L.events) { L.nTouched = null; return false; }
    L.nTouched = e.porw_lif_events_init(statePtr, n >>> 0, L.events.touched, L.events.isTouched, L.acc);
    return true;
  }
  async _lifStep(st, from, to, step, seed) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, syn = st.bufPtr + st.hdr.synOffset;
    let rc; const L = st.slot.lif;
    if (L.events && L.nTouched !== null && L.nTouched !== undefined) {
      const m = e.porw_lif_step_events(syn, L.events.outStart, L.events.outPerm, from, to, L.acc, n >>> 0, L.events.touched, L.events.isTouched, L.nTouched >>> 0, step >>> 0, seed >>> 0, st.wUnitQ16 >>> 0);
      if (m < 0) throw new Error("lif events rc=" + m);
      L.nTouched = m;
    } else if (this.pool && st.csr.sorted) await this.pool.map("porw_lif_step_rows_direct", n, (i0, c) => [syn, st.csr.rowStartPtr, from, to, n, i0, i0 + c, step, seed, st.wUnitQ16]);
    else if (this.pool) await this.pool.map("porw_lif_step_csr_range", n, (i0, c) => [syn, st.csr.permPtr, st.csr.rowStartPtr, from, to, n, i0, i0 + c, step, seed, st.wUnitQ16]);
    else { rc = e.porw_lif_step(syn, st.hdr.synapses >>> 0, from, to, st.slot.lif.acc, n >>> 0, step >>> 0, seed >>> 0, st.wUnitQ16 >>> 0); if (rc !== 0) throw new Error("lif rc=" + rc); }
    // Anything that writes a neuron's state from outside the rule has to say so, or the event-driven path will not
    // follow it: an untouched neuron is only a fixed point while nothing has touched it.
    const touch = (i) => { if (!(L.events && L.nTouched !== null && L.nTouched !== undefined)) return;
      const f = k.u8(L.events.isTouched + i, 1); if (!f[0]) { f[0] = 1; k.u32(L.events.touched + L.nTouched * 4, 1)[0] = i; L.nTouched++; } };
    if (this.execLie && this.execLie.step === step) { // test hooks: a lying executor
      const L = this.execLie, i = L.neuron;
      if (L.kind === "input") { // lie in the accumulated input: state = transition(prev, I + delta) — consistent with lied partial sums
        const R = k.u32(st.csr.rowStartPtr, n + 1); const m = k.mark(); const out = k.alloc(Math.max(1, R[i + 1] - R[i]) * 8);
        if (e.porw_lif_partial_sums(syn, st.csr.permPtr, from, n >>> 0, R[i], R[i + 1], out) !== 0) throw new Error("sums"); const sums = new BigInt64Array(k.memory.buffer, out, R[i + 1] - R[i]);
        const I = sums.length ? sums[sums.length - 1] : 0n; k.release(m);
        const next = transition(decodeState(k.u8(from + i * LIF_STATE, LIF_STATE)), I + BigInt(L.delta), i, step, seed, st.wUnitQ16 || undefined);
        k.u8(to + i * LIF_STATE, LIF_STATE).set(encodeState(next));
      } else { const b = k.u8(to + i * LIF_STATE, LIF_STATE); const dv = new DataView(b.buffer, b.byteOffset, LIF_STATE); dv.setInt32(0, dv.getInt32(0, true) + L.delta, true); } // lie in the state itself
      touch(i); // the lie is a write from outside the rule: without this the event path would not follow it
    }
  }
  /** The segment root over the state. Between two commits only the neurons a step touched can have changed, and the
   *  leaves of the rest are what they were -- so once the tree exists, a commit rehashes those leaves and the nodes
   *  above them (O(k log n)) instead of all 139,255 (O(n)). The tree it leaves behind is the one a full build would
   *  produce, which is what makes this safe: same root, same proofs. Above half the neurons a full build is cheaper. */
  async _lifCommit(st, statePtr) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, L = st.slot.lif;
    if (L.treeBuilt && L.events && L.nTouched > 0 && L.nTouched < n / 2) {
      const ids = k.u32(L.events.touched, L.nTouched); ids.sort(); // the update walks levels in order; a set has no order to lose
      if (e.porw_lif_state_leaves_at(statePtr, n >>> 0, L.events.touched, L.nTouched >>> 0, L.leavesPtr) !== 0) throw new Error("lif leaves_at");
      const lv = e.porw_merkle_tree_update(L.treePtr, n >>> 0, L.leavesPtr, L.events.touched, L.nTouched >>> 0, L.events.work) >>> 0;
      if (lv >= 0xFFFFFFFE) throw new Error("tree update error " + lv);
      return { ptr: L.treePtr, n, root: new Uint8Array(k.u8(L.treePtr + (k.treeNodes(n) - 1) * 32, 32)) };
    }
    if (this.pool) await this.pool.map("porw_lif_state_leaves", n, (f, c) => [statePtr + f * LIF_STATE, c, f, L.leavesPtr + f * 32]);
    else e.porw_lif_state_leaves(statePtr, n >>> 0, 0, L.leavesPtr);
    const t = await this._buildTree(L.leavesPtr, n, L.treePtr); L.treeBuilt = true; return t;
  }
  /** full run with per-step state commitments; keeps roots + checkpoints, returns the result artifacts */
  async _runLif(st, seed, ids = null, commit = true, silence = null) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, L = st.slot.lif; let t0 = performance.now(), inferMs = 0, commitMs = 0;
    L.seed = seed; L.ids = ids; L.cache.clear();
    const stimulated = this.lifState0(st, L.ping, seed, ids, silence);
    k.u8(L.checkpoints.get(0), n * LIF_STATE).set(k.u8(L.ping, n * LIF_STATE));
    k.u8(L.pong, n * LIF_STATE).set(k.u8(L.ping, n * LIF_STATE)); this._lifEventsArm(st, L.ping); // both buffers hold state_0
    const initStateRoot = commit ? (await this._lifCommit(st, L.ping)).root : null; commitMs += performance.now() - t0;
    const roots = [], stride = st.commitStride; let cur = L.ping, nxt = L.pong;
    for (let s = 1; s <= st.steps; s++) {
      t0 = performance.now(); await this._lifStep(st, cur, nxt, s, seed); inferMs += performance.now() - t0;
      if (commit && (s % stride === 0 || s === st.steps)) { t0 = performance.now(); roots.push((await this._lifCommit(st, nxt)).root); commitMs += performance.now() - t0; } // segment root
      if (L.checkpoints.has(s)) k.u8(L.checkpoints.get(s), n * LIF_STATE).set(k.u8(nxt, n * LIF_STATE));
      [cur, nxt] = [nxt, cur];
    }
    e.porw_lif_counts(cur, n >>> 0, L.counts);
    const counts = new Uint32Array(k.u32(L.counts, n));
    // execDigest is a digest of the spike counts -- independent of the commitments, which is why a claim can skip them
    return { initStateRoot, stateRoots: roots, segments: roots.length, execRoot: commit ? k.merkleRoot(new Uint8Array(roots.flatMap((r) => [...r]))) : null, execDigest: countsDigest(counts), counts, stimulated, inferMs, commitMs };
  }
  /** materialize state_s (replay from the nearest checkpoint) and its tree; cached (small LRU) */
  async _lifStateAt(st, s) {
    const k = this.k, n = st.hdr.neurons, L = st.slot.lif;
    if (L.cache.has(s)) return L.cache.get(s);
    let c = s - (s % LIF_CHECKPOINT); const m = k.mark();
    const a = k.alloc(n * LIF_STATE), b = k.alloc(n * LIF_STATE); k.u8(a, n * LIF_STATE).set(k.u8(L.checkpoints.get(c), n * LIF_STATE));
    k.u8(b, n * LIF_STATE).set(k.u8(a, n * LIF_STATE)); this._lifEventsArm(st, a, false); // the touched set of a checkpoint is what its state says it is
    let cur = a, nxt = b; for (let t = c + 1; t <= s; t++) { await this._lifStep(st, cur, nxt, t, L.seed); [cur, nxt] = [nxt, cur]; }
    const state = new Uint8Array(k.u8(cur, n * LIF_STATE)); k.release(m);
    // tree over a dedicated region so several steps can be cached at once
    const statePtr = k.alloc(n * LIF_STATE); k.u8(statePtr, n * LIF_STATE).set(state);
    const leavesPtr = k.alloc(n * 32), treePtr = k.alloc(k.treeNodes(n) * 32);
    if (this.pool) await this.pool.map("porw_lif_state_leaves", n, (f, cnt) => [statePtr + f * LIF_STATE, cnt, f, leavesPtr + f * 32]); else k.exports.porw_lif_state_leaves(statePtr, n >>> 0, 0, leavesPtr);
    const tree = await this._buildTree(leavesPtr, n, treePtr);
    const entry = { statePtr, tree }; L.cache.set(s, entry); return entry;
  }
  /** per-step state roots inside segment `seg` (steps seg*stride+1 .. min((seg+1)*stride, steps)); one replay pass */
  async _lifSegmentRoots(mepId, seg) {
    const st = this.models.get(hex(mepId)), k = this.k, n = st.hdr.neurons, L = st.slot.lif, stride = st.commitStride;
    const s0 = seg * stride, s1 = Math.min(s0 + stride, st.steps); const { statePtr } = await this._lifStateAt(st, s0);
    const m = k.mark(); const a = k.alloc(n * LIF_STATE), b = k.alloc(n * LIF_STATE); k.u8(a, n * LIF_STATE).set(k.u8(statePtr, n * LIF_STATE));
    k.u8(b, n * LIF_STATE).set(k.u8(a, n * LIF_STATE)); this._lifEventsArm(st, a, false);
    let cur = a, nxt = b; const roots = [];
    for (let t = s0 + 1; t <= s1; t++) { await this._lifStep(st, cur, nxt, t, L.seed); roots.push((await this._lifCommit(st, nxt)).root); [cur, nxt] = [nxt, cur]; }
    k.release(m); return { s0, s1, roots };
  }
  async _lifNode(mepId, step, level, idx) { const st = this.models.get(hex(mepId)); const { tree } = await this._lifStateAt(st, step); return treeNodeAt(this.k, tree, level, idx); }
  async _lifOpenState(mepId, step, i) { const st = this.models.get(hex(mepId)); const { statePtr, tree } = await this._lifStateAt(st, step);
    return { step, i, state: decodeState(this.k.u8(statePtr + i * LIF_STATE, LIF_STATE)), proof: this.k.treeProof(tree, i) }; }
  async _lifPartialSums(mepId, step, i) { const st = this.models.get(hex(mepId)), k = this.k, e = k.exports, n = st.hdr.neurons;
    const { statePtr } = await this._lifStateAt(st, step - 1);
    const R = k.u32(st.csr.rowStartPtr, n + 1); const k0 = R[i], k1 = R[i + 1]; const m = k.mark(); const out = k.alloc(Math.max(1, k1 - k0) * 8);
    const rc = e.porw_lif_partial_sums(st.bufPtr + st.hdr.synOffset, st.csr.permPtr, statePtr, n >>> 0, k0, k1, out);
    const sums = Array.from(new BigInt64Array(k.memory.buffer, out, k1 - k0)); k.release(m); if (rc !== 0) throw new Error("partial sums rc=" + rc);
    return { k0, k1, sums }; }
  _lifStates(mepId, step) { return this._lifStateAt(this.models.get(hex(mepId)), step).then(({ statePtr }) => new Uint8Array(this.k.u8(statePtr, this.models.get(hex(mepId)).hdr.neurons * LIF_STATE))); }
}
