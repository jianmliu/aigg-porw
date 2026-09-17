// One worker = one slice of the resident weights, sketched with its own kernel
// instance. No SharedArrayBuffer / cross-origin isolation required.
import { loadKernel, runSlice } from "./porw.js";

let kernel = null;

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      kernel = await loadKernel(m.wasmUrl);
      self.postMessage({ type: "ready", backend: kernel.backend });
    } else if (m.type === "run") {
      const r = runSlice(kernel, m);
      self.postMessage(
        { type: "done", id: m.id, fillMs: r.fillMs, medianMs: r.medianMs, bestMs: r.bestMs, sketches: r.sketches },
        [r.sketches.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ type: "error", error: String(err && err.stack || err) });
  }
};
