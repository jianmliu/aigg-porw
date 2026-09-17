// PorwNode: the browser/Node-side prover. Holds one or more models resident in wasm memory
// (e.g. the female and male fly brains, each its own MEP), answers challenges per MEP with a
// signed claim (residency + deterministic execution), and opens tiles.
import { TILE_BYTES, attachTrees } from "./porw.js";
import { decodeHeader, attachSpmv } from "./model.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { claimHash, signHash, keypair } from "./claim.js";
import { makeMep } from "./mep.js";
import { hex } from "./verify.js";

export class PorwNode {
  constructor(kernel, { privHex = null, deviceId = null } = {}) {
    this.k = attachTrees(attachSpmv(kernel, kernel.exports));
    this.key = keypair(privHex);
    this.deviceId = deviceId || keccak_256(this.key.address); // demo: device id derived from the reward key
    this.models = new Map(); // mepId hex -> resident model state
    this.lies = new Map();   // test hook: `${mepIdHex}:${tileIdx}` -> corrupted sketch
  }
  /** Load a released fly-brain payload and register it under a MEP. */
  loadModel(name, payloadBytes, { steps = 2 } = {}) {
    const k = this.k, t0 = performance.now();
    const bufPtr = k.put(payloadBytes);
    const nTiles = Math.floor(payloadBytes.length / TILE_BYTES);
    const hdr = decodeHeader(payloadBytes);
    const e = k.exports, nodes = k.treeNodes(nTiles);
    const wLeavesPtr = k.alloc(nTiles * 32); e.porw_weights_leaves(bufPtr, nTiles >>> 0, 0, wLeavesPtr);
    const weightsTree = k.treeBuildInto(wLeavesPtr, nTiles, k.alloc(nodes * 32));
    const modelId = weightsTree.root;
    const mep = makeMep({ name, modelId, steps });
    // fixed per-slot regions, reused every challenge (no allocation growth)
    const slot = { sketchesPtr: k.alloc(nTiles * 4), pLeavesPtr: k.alloc(nTiles * 32), pTreePtr: k.alloc(nodes * 32), actPtr: k.alloc(hdr.neurons * 4) };
    const st = { mep, bufPtr, nTiles, hdr, weightsTree, modelId, slot, leavesMs: performance.now() - t0 };
    this.models.set(hex(mep.mepId), st);
    return st;
  }
  challenge(mepId, challenge32, { stimulusSeed = 1 } = {}) {
    const st = this.models.get(hex(mepId)); if (!st) throw new Error("unknown MEP");
    const k = this.k, n = st.nTiles, t = {};
    let t0 = performance.now();
    st.slotSeed = k.slotSeed(challenge32, this.deviceId);
    const e = k.exports, sl = st.slot;
    k.sketch(st.bufPtr, n, 0, st.slotSeed, sl.sketchesPtr);
    // views into wasm memory detach when it grows: never cache them, re-view on access
    for (const [key, v] of this.lies) { const [mid, idx] = key.split(":"); if (mid === hex(mepId)) k.u32(sl.sketchesPtr, n)[+idx] = v; }
    t.sketchMs = performance.now() - t0; t0 = performance.now();
    e.porw_partials_leaves(0, sl.sketchesPtr, n >>> 0, 0, sl.pLeavesPtr);
    st.partialsTree = k.treeBuildInto(sl.pLeavesPtr, n, sl.pTreePtr);
    st.partialsRoot = st.partialsTree.root;
    t.commitMs = performance.now() - t0; t0 = performance.now();
    e.porw_spmv_stimulus(sl.actPtr, st.hdr.neurons >>> 0, stimulusSeed >>> 0);
    k.spmvRun(st.bufPtr, st.hdr, sl.actPtr, st.mep.steps);
    const a = k.u32(sl.actPtr, st.hdr.neurons);
    st.execDigest = keccak_256(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    t.inferMs = performance.now() - t0;
    const claim = { schemeDigest: st.mep.schemeDigest, mepId: st.mep.mepId, modelId: st.modelId, partialsRoot: st.partialsRoot,
      coverageBytes: n * TILE_BYTES, challenge: challenge32, deviceId: this.deviceId, execDigest: st.execDigest, stimulusSeed };
    const h = claimHash(claim);
    return { claim, claimHash: h, signature: signHash(h, this.key.priv), address: this.key.address, timings: t };
  }
  open(mepId, tileIdx) {
    const st = this.models.get(hex(mepId)), k = this.k;
    return { tileIdx, position: tileIdx, tile: new Uint8Array(k.u8(st.bufPtr + tileIdx * TILE_BYTES, TILE_BYTES)),
      sketch: k.u32(st.slot.sketchesPtr, st.nTiles)[tileIdx], partialsProof: k.treeProof(st.partialsTree, tileIdx), weightsProof: k.treeProof(st.weightsTree, tileIdx) };
  }
}
