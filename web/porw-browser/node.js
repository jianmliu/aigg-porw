// PorwNode: the browser/Node-side prover. Holds one or more models resident in wasm memory
// (e.g. the female and male fly brains, each its own MEP), answers challenges per MEP with a
// signed claim (residency + deterministic execution), and opens tiles.
import { TILE_BYTES, attachTrees, treeNodeAt, treeBuildParallel } from "./porw.js";
import { decodeHeader, attachSpmv } from "./model.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { claimHash, signHash, keypair } from "./claim.js";
import { makeMep } from "./mep.js";
import { hex, CSR_CHUNK } from "./verify.js";

export class PorwNode {
  async buildTree(leavesPtr, n, treePtr) { return this.pool ? treeBuildParallel(this.pool, leavesPtr, n, treePtr) : this.k.treeBuildInto(leavesPtr, n, treePtr); }
  constructor(kernel, { privHex = null, deviceId = null, pool = null } = {}) {
    this.k = attachTrees(attachSpmv(kernel, kernel.exports));
    this.pool = pool; // shared-memory worker pool (kernel must be pool.kernel when set)
    this.key = keypair(privHex);
    this.deviceId = deviceId || keccak_256(this.key.address); // demo: device id derived from the reward key
    this.models = new Map(); // mepId hex -> resident model state
    this.lies = new Map();   // test hook: `${mepIdHex}:${tileIdx}` -> corrupted sketch
  }
  /** Load a released fly-brain payload and register it under a MEP. */
  async loadModel(name, payloadBytes, { steps = 2 } = {}) {
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
    const mep = makeMep({ name, modelId, steps });
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
    const acts = []; for (let sIdx = 0; sIdx <= steps; sIdx++) acts.push({ ptr: k.alloc(n * 4), leavesPtr: sIdx ? k.alloc(n * 32) : 0, treePtr: sIdx ? k.alloc(actN * 32) : 0, tree: null });
    const slot = { sketchesPtr: k.alloc(nTiles * 4), pLeavesPtr: k.alloc(nTiles * 32), pTreePtr: k.alloc(nodes * 32), acts };
    const st = { mep, bufPtr, nTiles, hdr, weightsTree, modelId, slot, csr, steps, leavesMs: performance.now() - t0 };
    this.models.set(hex(mep.mepId), st);
    return st;
  }
  async challenge(mepId, challenge32, { stimulusSeed = 1 } = {}) {
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
    const claim = { schemeDigest: st.mep.schemeDigest, mepId: st.mep.mepId, modelId: st.modelId, partialsRoot: st.partialsRoot,
      coverageBytes: n * TILE_BYTES, challenge: challenge32, deviceId: this.deviceId, execDigest: st.execDigest, stimulusSeed };
    const h = claimHash(claim);
    return { claim, claimHash: h, signature: signHash(h, this.key.priv), address: this.key.address, timings: t,
      result: { execDigest: st.execDigest, execRoot: st.execRoot, actRoots: st.actRoots, csrRoot: st.csr.csrTree.root, rowRoot: st.csr.rowTree.root, synapseRoot: st.csr.synapseRoot } };
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
}
