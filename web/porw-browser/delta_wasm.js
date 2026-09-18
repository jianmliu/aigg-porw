// Resident delta application. Handles own WASM allocations until the caller rewinds
// the kernel heap; no payload or genotype is retained in JavaScript.
import { decodeHeader } from "./model.js";
import {
  decodeDelta,
  decodeDelta2,
  decodeDelta3,
  isDelta2,
  isDelta3,
  deltaId,
} from "./delta.js";
import * as V from "./verify.js";
const handles = new WeakSet();
const decode = (b) =>
  isDelta3(b)
    ? decodeDelta3(b)
    : isDelta2(b)
      ? decodeDelta2(b)
      : decodeDelta(b);
function shape(h, length) {
  if (h.version !== 2) throw new Error("FLYBRAINv2 base required");
  if (
    !Number.isSafeInteger(h.neurons) ||
    h.neurons > 0xffffffff ||
    !Number.isSafeInteger(h.synapses) ||
    h.synapses > 0x7fffffff ||
    length % 4096
  )
    throw new Error("invalid base payload shape");
}
export function uploadDeltaBase(k, bytes, { baseModelId = null } = {}) {
  const mark = k.mark();
  try {
    const byteLength = bytes.byteLength;
    const hdr = decodeHeader(bytes);
    shape(hdr, byteLength);
    // A supplied identity has the same already-verified contract as applyDelta.
    if (baseModelId && baseModelId.length !== 32)
      throw new Error("baseModelId must be 32 bytes");
    const ptr = k.put(bytes);
    const rc = k.exports.porw_delta_validate(
      ptr + hdr.synOffset,
      hdr.synapses,
      hdr.neurons,
    );
    if (rc === -1)
      throw new Error("base records must be sorted by (post, pre) and unique");
    if (rc) throw new Error("base neuron index out of range");
    const modelId = baseModelId
      ? new Uint8Array(baseModelId)
      : k.merkleRoot(k.weightsLeaves(ptr, byteLength / 4096, 0));
    const h = Object.freeze({
      kernel: k,
      ptr,
      byteLength,
      hdr: Object.freeze(hdr),
      modelId,
      allocationBytes: k.mark() - mark,
    });
    handles.add(h);
    return h;
  } catch (e) {
    k.release(mark);
    throw e;
  }
}
export function applyDeltaWasm(k, base, deltaBytes, { resolve = null } = {}) {
  if (
    !handles.has(base) ||
    base.kernel !== k ||
    base.ptr + base.byteLength > k.mark()
  )
    throw new Error("invalid resident base handle or kernel");
  const mark = k.mark(),
    e = k.exports,
    h = base.hdr,
    rec = base.ptr + h.synOffset,
    n = h.synapses;
  try {
    const d = decode(deltaBytes),
      version = isDelta3(deltaBytes) ? 3 : isDelta2(deltaBytes) ? 2 : 1;
    const check = (d) => {
      if (d.neurons !== h.neurons)
        throw new Error(
          `neuron count mismatch: base ${h.neurons}, delta ${d.neurons}`,
        );
      if (!V.eq(d.baseModelId, base.modelId))
        throw new Error("base model id mismatch");
    };
    check(d);
    // The resident path writes the COMPACT materialization. An in-place cross (layout 1) keeps every base record at its
    // offset and has another model_id; producing the compact payload for it would silently load the wrong brain.
    if (version === 3 && d.layout === 1)
      throw new Error("in-place layout is not implemented in the WASM path: use applyDelta (delta.js)");
    const sample = (d, seed) => {
      const out = k.alloc(n * 4),
        scratch = k.mark(),
        rows = k.alloc(d.rTable.length * 8);
      k.u32(rows, d.rTable.length * 2).set(d.rTable.flat());
      const rc = e.porw_sample_records(
        rec,
        n,
        Number(seed & 0xffffffffn),
        Number(seed >> 32n),
        d.meanRatioQ16,
        rows,
        d.rTable.length,
        out,
      );
      k.release(scratch);
      if (rc < 0) throw new Error("WASM sampling failed: " + rc);
      return out;
    };
    const visiting = new Set(),
      cache = new Map();
    let ancestors = 0;
    const genotype = (bytes, asParent = false, depth = 0) => {
      if (depth > 64 || ++ancestors > 256)
        throw new Error("delta ancestor limit exceeded");
      const id = V.hex(deltaId(bytes)),
        is3 = isDelta3(bytes);
      if (!is3 && !isDelta2(bytes))
        throw new Error("a genotype needs a procedural delta (v2 or v3)");
      const dd = is3 ? decodeDelta3(bytes) : decodeDelta2(bytes);
      check(dd);
      if (asParent && dd.ops.length)
        throw new Error("a parent must carry no explicit ops");
      if (visiting.has(id)) throw new Error("delta ancestor cycle");
      if (cache.has(id)) return cache.get(id);
      visiting.add(id);
      let p;
      if (!is3) p = sample(dd, dd.seed);
      else {
        const parent = (pid) => {
          if (pid.every((x) => x === 0)) return 0;
          const key = V.hex(pid);
          if (visiting.has(key)) throw new Error("delta ancestor cycle");
          const b = resolve && resolve(key);
          if (!b) throw new Error(`parent delta ${key} not provided`);
          if (!V.eq(deltaId(b), pid))
            throw new Error(`parent delta ${key} hash identity mismatch`);
          return genotype(b, true, depth + 1);
        };
        const a = parent(dd.parentA),
          b = parent(dd.parentB);
        p = sample(dd, dd.seed ^ 0x4452415744524157n);
        e.porw_delta_cross(
          rec,
          n,
          a,
          b,
          p,
          Number(dd.seed & 0xffffffffn),
          Number(dd.seed >> 32n),
          dd.granularity,
          dd.mutRateQ32,
          p,
        );
      }
      visiting.delete(id);
      cache.set(id, p);
      return p;
    };
    const counts = version === 1 ? 0 : genotype(deltaBytes);
    const opPtr = k.alloc(d.ops.length * 10),
      opView = new DataView(k.memory.buffer, opPtr, d.ops.length * 10);
    d.ops.forEach((o, i) => {
      opView.setUint32(i * 10, o.pre, true);
      opView.setUint32(i * 10 + 4, o.post, true);
      opView.setInt16(i * 10 + 8, o.w, true);
    });
    const args = [
      rec,
      n,
      counts,
      version === 1 ? 0 : d.minSyn,
      opPtr,
      d.ops.length,
      version === 1 ? 1 : 0,
    ];
    const count = e.porw_delta_merge(...args, 0);
    if (count < 0) throw new Error("delete of a record the base lacks");
    const name = new TextEncoder().encode(d.name);
    if (name.length > 65535) throw new Error("name too long");
    const synOffset = 30 + name.length + h.neurons * 8,
      byteLength = Math.ceil((synOffset + count * 10) / 4096) * 4096;
    const tmp = k.alloc(byteLength);
    k.u8(tmp, byteLength).fill(0);
    const view = new DataView(k.memory.buffer, tmp, byteLength);
    k.u8(tmp, 12).set(new TextEncoder().encode("FLYBRAINv2\0\0"));
    view.setBigUint64(12, BigInt(h.neurons), true);
    view.setBigUint64(20, BigInt(count), true);
    view.setUint16(28, name.length, true);
    k.u8(tmp + 30, name.length).set(name);
    k.u8(tmp + 30 + name.length, h.neurons * 8).set(
      k.u8(base.ptr + h.neuronOffset, h.neurons * 8),
    );
    e.porw_delta_merge(...args, tmp + synOffset);
    // Move the result down over scratch before releasing it. copyWithin is memmove,
    // including for overlapping regions and shared WebAssembly memory.
    const ptr = Math.ceil(mark / 16) * 16;
    new Uint8Array(k.memory.buffer).copyWithin(ptr, tmp, tmp + byteLength);
    k.release(mark);
    const retained = k.alloc(byteLength);
    if (retained !== ptr) throw new Error("unexpected WASM alignment");
    const hdr = Object.freeze({
      name: d.name,
      neurons: h.neurons,
      synapses: count,
      synOffset,
      version: 2,
      neuronOffset: 30 + name.length,
    });
    return {
      kernel: k,
      ptr,
      byteLength,
      hdr,
      allocationBytes: k.mark() - mark,
      delta: d,
      version,
    };
  } catch (err) {
    k.release(mark);
    throw err;
  }
}
