// Worker for the shared-memory pool: instantiates porw-shared.wasm on the SAME shared memory
// as the main thread, sets its own stack region, and runs exported ops over pointer args.
// Works as a browser Worker (self.onmessage) or a Node worker_threads Worker (parentPort).
const isNode = typeof self === "undefined";
let post, onmsg;
if (isNode) { const { parentPort } = await import("node:worker_threads"); post = (m) => parentPort.postMessage(m); onmsg = (f) => parentPort.on("message", f); }
else { post = (m) => self.postMessage(m); onmsg = (f) => { self.onmessage = (ev) => f(ev.data); }; }
let exports = null;
onmsg(async (m) => {
  try {
    if (m.type === "init") {
      const { instance } = await WebAssembly.instantiate(m.wasmBytes, { env: { memory: m.memory } });
      exports = instance.exports;
      exports.__stack_pointer.value = m.stackTop; // private stack region inside the shared memory
      post({ type: "ready" });
    } else if (m.type === "run") {
      const rc = exports[m.op](...m.args);
      post({ type: "done", id: m.id, rc: typeof rc === "number" ? rc : 0 });
    }
  } catch (err) { post({ type: "error", id: m.id, error: String(err && err.stack || err) }); }
});
