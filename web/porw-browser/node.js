// PorwNode: the browser/Node-side prover. Holds one or more models resident in wasm memory
// (e.g. the female and male fly brains, each its own MEP), answers challenges per MEP with a
// signed claim (residency + deterministic execution), and opens tiles.
import { TILE_BYTES, attachTrees, treeNodeAt, treeBuildParallel } from "./porw.js";
import { applyDelta, decodeDelta } from "./delta.js";
import { decodeHeader, attachSpmv } from "./model.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { claimHash, signHash, keypair } from "./claim.js";
import { makeMep } from "./mep.js";
import { hex, CSR_CHUNK } from "./verify.js";
import { claimDigest } from "./eip712.js";
import { lifExecKind, countsDigest, decodeState, encodeState, transition } from "./lif.js";
const LIF_STATE = 16, LIF_CHECKPOINT = 32;

export class PorwNode {
  async buildTree(leavesPtr, n, treePtr) { return this.pool ? treeBuildParallel(this.pool, leavesPtr, n, treePtr) : this.k.treeBuildInto(leavesPtr, n, treePtr); }
  /** `domains.claimManager` / `domains.market`: EIP-712 domains (chainId, verifying contract) — claims and results are then
   *  signed as typed data by this node's key (the wallet itself, or a session key the wallet delegated: `delegation`). */
  constructor(kernel, { privHex = null, deviceId = null, pool = null, domains = null, delegation = null } = {}) {
    this.domains = domains; this.delegation = delegation;
    this.k = attachTrees(attachSpmv(kernel, kernel.exports));
    this.pool = pool; // shared-memory worker pool (kernel must be pool.kernel when set)
    this.key = keypair(privHex);
    this.deviceId = deviceId || keccak_256(this.key.address); // demo: device id derived from the reward key
    this.models = new Map(); // mepId hex -> resident model state
    this.lies = new Map();   // test hook: `${mepIdHex}:${tileIdx}` -> corrupted sketch
  }
  /** Load a released fly-brain payload and register it under a MEP. */
  async loadModel(name, payloadBytes, { steps = 2, exec = null, commitStride = 10 } = {}) {
    const k = this.k, t0 = performance.now();
    const bufPtr = k.put(payloadBytes);
    const nTiles = Math.floor(payloadBytes.length / TILE_BYTES);
    const hdr = decodeHeader(payloadBytes);
    const e = k.exports, nodes = k.treeNodes(nTiles);
    const wLeavesPtr = k.alloc(nTiles * 32);
    if (this.pool) await this.pool.map("porw_weights_leaves", nTiles, (f, c) => [bufPtr + f * TILE_BYTES, c, f, wLeavesPtr + f * 32]);
    else e.porw_weights_leaves(bufPtr, nTiles >>> 0, 0, wLeavesPtr);
    const weightsTree = await this.buildTree(wLeavesPtr, nTiles, k.alloc(nodes * 32));
    const modelId = weightsTree.root;
    exec = exec || (hdr.version === 2 ? "lif" : "spmv"); if (exec === "lif" && hdr.version !== 2) throw new Error("int-lif needs a v2 payload");
    const mep = makeMep({ name, modelId, steps, execKind: exec === "lif" ? lifExecKind() : undefined, commitStride });
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
    csr.csrTree = await this.buildTree(csrLeaves, csr.nChunks, k.alloc(k.treeNodes(csr.nChunks) * 32));
    csr.rowTree = await this.buildTree(rowLeaves, n + 1, k.alloc(k.treeNodes(n + 1) * 32));
    csr.synapseRoot = k.keccak256(new Uint8Array([...csr.csrTree.root, ...csr.rowTree.root]));
    // per-step activation arrays + leaves + trees (act_0 = stimulus, act_1..steps)
    const actN = k.treeNodes(n);
    const acts = []; if (exec === "spmv") for (let sIdx = 0; sIdx <= steps; sIdx++) acts.push({ ptr: k.alloc(n * 4), leavesPtr: sIdx ? k.alloc(n * 32) : 0, treePtr: sIdx ? k.alloc(actN * 32) : 0, tree: null });
    // int-lif: ping-pong state buffers + checkpoints every LIF_CHECKPOINT steps (openings replay from the nearest one);
    // one leaves/tree region reused per step (only the roots are kept), a small materialized-step cache for disputes
    const lif = exec === "lif" ? { ping: k.alloc(n * LIF_STATE), pong: k.alloc(n * LIF_STATE), leavesPtr: k.alloc(n * 32), treePtr: k.alloc(actN * 32), acc: k.alloc(n * 8),
      checkpoints: new Map(), cache: new Map(), counts: k.alloc(n * 4) } : null;
    if (lif) for (let sIdx = 0; sIdx <= steps; sIdx += LIF_CHECKPOINT) lif.checkpoints.set(sIdx, k.alloc(n * LIF_STATE));
    const slot = { sketchesPtr: k.alloc(nTiles * 4), pLeavesPtr: k.alloc(nTiles * 32), pTreePtr: k.alloc(nodes * 32), acts, lif };
    const st = { mep, exec, bufPtr, nTiles, hdr, weightsTree, modelId, slot, csr, steps, leavesMs: performance.now() - t0 };
    this.models.set(hex(mep.mepId), st);
    return st;
  }
  /** Load a FLYDELTAv1 delta on top of its base payload: the applied bytes are the model (same model_id / MEP as
   *  publishing them directly); `st.delta` records the binding. `baseModelId` skips recomputing the base's id. */
  async loadDelta(baseBytes, deltaBytes, { baseModelId = null, ...opts } = {}) {
    const d = decodeDelta(deltaBytes); const applied = applyDelta(baseBytes, deltaBytes, { baseModelId });
    const st = await this.loadModel(d.name, applied, opts); st.delta = { baseModelId: d.baseModelId, baseDA: d.baseDA, ops: d.ops.length, bytes: deltaBytes.length }; return st;
  }
  async challenge(mepId, challenge32, { stimulusSeed = 1, stimulusIds = null } = {}) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP");
    const k = this.k, n = st.nTiles, t = {};
    let t0 = performance.now();
    st.slotSeed = k.slotSeed(challenge32, this.deviceId);
    const e = k.exports, sl = st.slot;
    if (this.pool) await this.pool.map("porw_sketch_tiles", n, (f, c) => [st.bufPtr + f * TILE_BYTES, c, f, st.slotSeed, sl.sketchesPtr + f * 4]);
    else k.sketch(st.bufPtr, n, 0, st.slotSeed, sl.sketchesPtr);
    // views into wasm memory detach when it grows: never cache them, re-view on access
    for (const [key, v] of this.lies) { const [mid, idx] = key.split(":"); if (mid === hex(mepId)) k.u32(sl.sketchesPtr, n)[+idx] = v; }
    t.sketchMs = performance.now() - t0; t0 = performance.now();
    if (this.pool) await this.pool.map("porw_partials_leaves", n, (f, c) => [0, sl.sketchesPtr + f * 4, c, f, sl.pLeavesPtr + f * 32]);
    else e.porw_partials_leaves(0, sl.sketchesPtr, n >>> 0, 0, sl.pLeavesPtr);
    st.partialsTree = await this.buildTree(sl.pLeavesPtr, n, sl.pTreePtr);
    st.partialsRoot = st.partialsTree.root;
    t.commitMs = performance.now() - t0; t0 = performance.now();
    if (st.exec === "lif") {
      // canonical stimulus set from the seed (or an explicit task set); commitments are folded into the run
      const r = await this.runLif(st, stimulusSeed, stimulusIds);
      st.execDigest = r.execDigest; st.actRoots = r.stateRoots; st.execRoot = r.execRoot; st.initStateRoot = r.initStateRoot; st.stimulated = r.stimulated;
      t.inferMs = r.inferMs; t.disputeCommitMs = r.commitMs;
    } else {
    e.porw_spmv_stimulus(sl.acts[0].ptr, st.hdr.neurons >>> 0, stimulusSeed >>> 0);
    await this.runInference(st);
    const last = sl.acts[st.steps].ptr, a = k.u32(last, st.hdr.neurons);
    st.execDigest = keccak_256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    t.inferMs = performance.now() - t0; t0 = performance.now();
    // dispute commitments: per-step activation roots, execRoot = merkle(actRoots)
    st.actRoots = [];
    for (let sIdx = 1; sIdx <= st.steps; sIdx++) {
      const A = sl.acts[sIdx], n = st.hdr.neurons;
      if (this.pool) await this.pool.map("porw_act_leaves", n, (f, c) => [A.ptr + f * 4, c, f, A.leavesPtr + f * 32]);
      else e.porw_act_leaves(A.ptr, n >>> 0, 0, A.leavesPtr);
      A.tree = await this.buildTree(A.leavesPtr, n, A.treePtr); st.actRoots.push(A.tree.root);
    }
    st.execRoot = k.merkleRoot(new Uint8Array(st.actRoots.flatMap((r) => [...r])));
    t.disputeCommitMs = performance.now() - t0;
    }
    const claim = { schemeDigest: st.mep.schemeDigest, mepId: st.mep.mepId, modelId: st.modelId, partialsRoot: st.partialsRoot,
      coverageBytes: n * TILE_BYTES, challenge: challenge32, deviceId: this.deviceId, execDigest: st.execDigest, stimulusSeed };
    const h = claimHash(claim); const digest = this.domains?.claimManager ? claimDigest(this.domains.claimManager, claim) : h; // EIP-712 when a domain is configured
    return { claim, claimHash: h, digest, signature: signHash(digest, this.key.priv), address: this.key.address, delegation: this.delegation, timings: t,
      result: { execDigest: st.execDigest, execRoot: st.execRoot, actRoots: st.actRoots, csrRoot: st.csr.csrTree.root, rowRoot: st.csr.rowTree.root, synapseRoot: st.csr.synapseRoot,
                initStateRoot: st.initStateRoot || null, stimulated: st.stimulated ?? null } };
  }
  /** steps of deterministic inference in place on actPtr; parallel CSR rows with a pool, scatter otherwise (bit-identical) */
  async runInference(st) {
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
  lifState0(st, dst, seed, ids) {
    const e = this.k.exports, n = st.hdr.neurons;
    if (!ids) return e.porw_lif_state0_canonical(dst, n >>> 0, seed >>> 0) >>> 0;
    const m = this.k.mark(); const p = this.k.alloc(ids.length * 4); this.k.u32(p, ids.length).set(ids);
    const rc = e.porw_lif_state0_set(dst, n >>> 0, p, ids.length >>> 0); this.k.release(m); if (rc !== 0) throw new Error("state0 rc=" + rc); return ids.length;
  }
  async lifStep(st, from, to, step, seed) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, syn = st.bufPtr + st.hdr.synOffset;
    let rc;
    if (this.pool && st.csr.sorted) await this.pool.map("porw_lif_step_rows_direct", n, (i0, c) => [syn, st.csr.rowStartPtr, from, to, n, i0, i0 + c, step, seed]);
    else if (this.pool) await this.pool.map("porw_lif_step_csr_range", n, (i0, c) => [syn, st.csr.permPtr, st.csr.rowStartPtr, from, to, n, i0, i0 + c, step, seed]);
    else { rc = e.porw_lif_step(syn, st.hdr.synapses >>> 0, from, to, st.slot.lif.acc, n >>> 0, step >>> 0, seed >>> 0); if (rc !== 0) throw new Error("lif rc=" + rc); }
    if (this.execLie && this.execLie.step === step) { // test hooks: a lying executor
      const L = this.execLie, i = L.neuron;
      if (L.kind === "input") { // lie in the accumulated input: state = transition(prev, I + delta) — consistent with lied partial sums
        const R = k.u32(st.csr.rowStartPtr, n + 1); const m = k.mark(); const out = k.alloc(Math.max(1, R[i + 1] - R[i]) * 8);
        if (e.porw_lif_partial_sums(syn, st.csr.permPtr, from, n >>> 0, R[i], R[i + 1], out) !== 0) throw new Error("sums"); const sums = new BigInt64Array(k.memory.buffer, out, R[i + 1] - R[i]);
        const I = sums.length ? sums[sums.length - 1] : 0n; k.release(m);
        const next = transition(decodeState(k.u8(from + i * LIF_STATE, LIF_STATE)), I + BigInt(L.delta), i, step, seed);
        k.u8(to + i * LIF_STATE, LIF_STATE).set(encodeState(next));
      } else { const b = k.u8(to + i * LIF_STATE, LIF_STATE); const dv = new DataView(b.buffer, b.byteOffset, LIF_STATE); dv.setInt32(0, dv.getInt32(0, true) + L.delta, true); } // lie in the state itself
    }
  }
  async lifCommit(st, statePtr) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, L = st.slot.lif;
    if (this.pool) await this.pool.map("porw_lif_state_leaves", n, (f, c) => [statePtr + f * LIF_STATE, c, f, L.leavesPtr + f * 32]);
    else e.porw_lif_state_leaves(statePtr, n >>> 0, 0, L.leavesPtr);
    return this.buildTree(L.leavesPtr, n, L.treePtr);
  }
  /** full run with per-step state commitments; keeps roots + checkpoints, returns the result artifacts */
  async runLif(st, seed, ids = null) {
    const k = this.k, e = k.exports, n = st.hdr.neurons, L = st.slot.lif; let t0 = performance.now(), inferMs = 0, commitMs = 0;
    L.seed = seed; L.ids = ids; L.cache.clear();
    const stimulated = this.lifState0(st, L.ping, seed, ids);
    k.u8(L.checkpoints.get(0), n * LIF_STATE).set(k.u8(L.ping, n * LIF_STATE));
    const initStateRoot = (await this.lifCommit(st, L.ping)).root; commitMs += performance.now() - t0;
    const roots = [], stride = st.mep.commitStride; let cur = L.ping, nxt = L.pong;
    for (let s = 1; s <= st.steps; s++) {
      t0 = performance.now(); await this.lifStep(st, cur, nxt, s, seed); inferMs += performance.now() - t0;
      if (s % stride === 0 || s === st.steps) { t0 = performance.now(); roots.push((await this.lifCommit(st, nxt)).root); commitMs += performance.now() - t0; } // segment root
      if (L.checkpoints.has(s)) k.u8(L.checkpoints.get(s), n * LIF_STATE).set(k.u8(nxt, n * LIF_STATE));
      [cur, nxt] = [nxt, cur];
    }
    e.porw_lif_counts(cur, n >>> 0, L.counts);
    const counts = new Uint32Array(k.u32(L.counts, n));
    return { initStateRoot, stateRoots: roots, segments: roots.length, execRoot: k.merkleRoot(new Uint8Array(roots.flatMap((r) => [...r]))), execDigest: countsDigest(counts), counts, stimulated, inferMs, commitMs };
  }
  /** materialize state_s (replay from the nearest checkpoint) and its tree; cached (small LRU) */
  async lifStateAt(st, s) {
    const k = this.k, n = st.hdr.neurons, L = st.slot.lif;
    if (L.cache.has(s)) return L.cache.get(s);
    let c = s - (s % LIF_CHECKPOINT); const m = k.mark();
    const a = k.alloc(n * LIF_STATE), b = k.alloc(n * LIF_STATE); k.u8(a, n * LIF_STATE).set(k.u8(L.checkpoints.get(c), n * LIF_STATE));
    let cur = a, nxt = b; for (let t = c + 1; t <= s; t++) { await this.lifStep(st, cur, nxt, t, L.seed); [cur, nxt] = [nxt, cur]; }
    const state = new Uint8Array(k.u8(cur, n * LIF_STATE)); k.release(m);
    // tree over a dedicated region so several steps can be cached at once
    const statePtr = k.alloc(n * LIF_STATE); k.u8(statePtr, n * LIF_STATE).set(state);
    const leavesPtr = k.alloc(n * 32), treePtr = k.alloc(k.treeNodes(n) * 32);
    if (this.pool) await this.pool.map("porw_lif_state_leaves", n, (f, cnt) => [statePtr + f * LIF_STATE, cnt, f, leavesPtr + f * 32]); else k.exports.porw_lif_state_leaves(statePtr, n >>> 0, 0, leavesPtr);
    const tree = await this.buildTree(leavesPtr, n, treePtr);
    const entry = { statePtr, tree }; L.cache.set(s, entry); return entry;
  }
  /** per-step state roots inside segment `seg` (steps seg*stride+1 .. min((seg+1)*stride, steps)); one replay pass */
  async lifSegmentRoots(mepId, seg) {
    const st = this.models.get(hex(mepId)), k = this.k, n = st.hdr.neurons, L = st.slot.lif, stride = st.mep.commitStride;
    const s0 = seg * stride, s1 = Math.min(s0 + stride, st.steps); const { statePtr } = await this.lifStateAt(st, s0);
    const m = k.mark(); const a = k.alloc(n * LIF_STATE), b = k.alloc(n * LIF_STATE); k.u8(a, n * LIF_STATE).set(k.u8(statePtr, n * LIF_STATE));
    let cur = a, nxt = b; const roots = [];
    for (let t = s0 + 1; t <= s1; t++) { await this.lifStep(st, cur, nxt, t, L.seed); roots.push((await this.lifCommit(st, nxt)).root); [cur, nxt] = [nxt, cur]; }
    k.release(m); return { s0, s1, roots };
  }
  async lifNode(mepId, step, level, idx) { const st = this.models.get(hex(mepId)); const { tree } = await this.lifStateAt(st, step); return treeNodeAt(this.k, tree, level, idx); }
  async lifOpenState(mepId, step, i) { const st = this.models.get(hex(mepId)); const { statePtr, tree } = await this.lifStateAt(st, step);
    return { step, i, state: decodeState(this.k.u8(statePtr + i * LIF_STATE, LIF_STATE)), proof: this.k.treeProof(tree, i) }; }
  async lifPartialSums(mepId, step, i) { const st = this.models.get(hex(mepId)), k = this.k, e = k.exports, n = st.hdr.neurons;
    const { statePtr } = await this.lifStateAt(st, step - 1);
    const R = k.u32(st.csr.rowStartPtr, n + 1); const k0 = R[i], k1 = R[i + 1]; const m = k.mark(); const out = k.alloc(Math.max(1, k1 - k0) * 8);
    const rc = e.porw_lif_partial_sums(st.bufPtr + st.hdr.synOffset, st.csr.permPtr, statePtr, n >>> 0, k0, k1, out);
    const sums = Array.from(new BigInt64Array(k.memory.buffer, out, k1 - k0)); k.release(m); if (rc !== 0) throw new Error("partial sums rc=" + rc);
    return { k0, k1, sums }; }
  lifStates(mepId, step) { return this.lifStateAt(this.models.get(hex(mepId)), step).then(({ statePtr }) => new Uint8Array(this.k.u8(statePtr, this.models.get(hex(mepId)).hdr.neurons * LIF_STATE))); }
}
