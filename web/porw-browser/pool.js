// Shared-memory worker pool: one resident copy of the model in a shared WebAssembly.Memory,
// N worker instances of porw-shared.wasm computing disjoint ranges in place. Isomorphic:
// browser Workers (needs cross-origin isolation for SharedArrayBuffer) or Node worker_threads.
import { wrap } from "./porw.js";

const STACK_BYTES = 262144;

export async function createPool({ wasmBytes, workers, initialPages = 256, maximumPages = 65536, nodeWorkers = false }) {
  const memory = new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true });
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env: { memory } });
  const k = wrap(instance.exports, memory);
  const spawn = nodeWorkers
    ? async () => { const { Worker } = await import("node:worker_threads"); const w = new Worker(new URL("./pool_worker.js", import.meta.url)); return { post: (m) => w.postMessage(m), on: (f) => w.on("message", f), kill: () => w.terminate() }; }
    : async () => { const w = new Worker(new URL("./pool_worker.js", import.meta.url), { type: "module" }); return { post: (m) => w.postMessage(m), on: (f) => { w.onmessage = (ev) => f(ev.data); }, kill: () => w.terminate() }; };
  const ws = [];
  for (let i = 0; i < workers; i++) {
    const w = await spawn(); const stackTop = k.alloc(STACK_BYTES) + STACK_BYTES; // stack grows down
    await new Promise((res, rej) => { w.on((m) => (m.type === "ready" ? res() : rej(new Error(m.error)))); w.post({ type: "init", wasmBytes, memory, stackTop }); });
    ws.push(w);
  }
  let nextId = 1;
  const runOn = (w, op, args) => new Promise((res, rej) => { const id = nextId++; w.on((m) => { if (m.id !== id) return; m.type === "done" ? res(m.rc) : rej(new Error(m.error)); }); w.post({ type: "run", id, op, args }); });
  return {
    kernel: k, memory, workers: ws.length,
    /** split [0,total) into contiguous ranges and run op(...argsFor(first, count)) on each worker in parallel */
    async map(op, total, argsFor) {
      const n = ws.length, per = Math.floor(total / n), rem = total % n; let pos = 0; const jobs = [];
      for (let i = 0; i < n; i++) { const cnt = per + (i < rem ? 1 : 0); if (cnt === 0) continue; jobs.push(runOn(ws[i], op, argsFor(pos, cnt))); pos += cnt; }
      const rcs = await Promise.all(jobs); const bad = rcs.find((r) => r !== 0); if (bad !== undefined) throw new Error(`${op} rc=${bad}`);
    },
    close() { ws.forEach((w) => w.kill()); },
  };
}
