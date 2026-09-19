// The output of an int-lif task: every neuron's spike count, returned to the client that asks for it.
// Nothing new is trusted for it: execDigest is keccak(LE32 n || counts as LE u32) (lif.js countsDigest), so a client
// that is handed the counts checks them against the digest -- and the digest is what the task settles on.
//   - asked (`counts: true` in the announcement), the node returns them with its signed result; not asked, it does not
//   - they hash to the execDigest it signed, and are the counts a re-execution of the task produces
//   - what is submitted on-chain (`onResult`, which a page POSTs to a relayer as it is) never carries them
//   - a forged vector is caught by the digest
//   - over a real relay, at the size of a real brain: FlyWire's 139,255 neurons are ~743 kB of base64 in one frame
//   - int-spmv-q16 has no counts: asking is harmless
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js"; import { PorwNode } from "./node.js"; import { NodeService } from "./node_service.js"; import { synthesizePayload, synthesizePayloadV2 } from "./synth.js";
import { keypair } from "./claim.js"; import { startRelay } from "./relay.js"; import { RelayClient } from "./relay_client.js"; import * as L from "./lif.js"; import * as V from "./verify.js"; import * as Vf from "./verifier.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
/** what a client does with the field: base64 -> bytes -> u32, little-endian */
const decode = (b64) => { const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return new Uint32Array(raw.buffer, 0, raw.length / 4); };
const node = async (priv, name, payload, exec, steps) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: priv }); const st = await nd.loadModel(name, payload, { maxSteps: steps, exec }); return { nd, st, mepHex: V.hex(st.mep.mepId) }; };

// ---- the handler, called directly ----
{ const N = 3000, STEPS = 40, SEED = 5; const payload = synthesizePayloadV2("counts", N, 90000); const A = await node("0x" + "11".repeat(32), "counts", payload, "lif", STEPS);
  const handlers = {}; const submitted = []; const svc = new NodeService(A.nd, { serve: (type, id, fn) => { handlers[type] = fn; return () => {}; } }, { onResult: (r) => submitted.push(r) }); svc.serve(A.st.mep.mepId);
  const announce = (extra) => handlers["task-announce"]({ mepId: [...A.nd.models.keys()][0], payload: { taskId: "0x" + "ab".repeat(32), steps: STEPS, commitStride: 10, stimulusSeed: SEED, stimulusIds: Array.from({ length: 300 }, (_, j) => j * 7), ...extra } });
  const plain = await announce({}), asked = await announce({ counts: true });
  check("not asked, the result is what it always was: no counts", plain.type === "result" && !("counts" in plain.payload) && !("countsEncoding" in plain.payload));
  const counts = decode(asked.payload.counts);
  check(`asked, it returns ${counts.length} spike counts with the same signed result`, asked.type === "result" && asked.payload.countsEncoding === "u32le-base64" && counts.length === N && asked.payload.execDigest === plain.payload.execDigest && asked.payload.execRoot === plain.payload.execRoot && asked.payload.signature === plain.payload.signature);
  check("they hash to the execDigest it signed", V.hex(L.countsDigest(counts)) === asked.payload.execDigest && counts.some((c) => c > 0));
  check("and re-executing the task reproduces that digest", Vf.reexecuteLif(await loadKernelFromBytes(wasm), payload, { stimulusSeed: SEED, steps: STEPS, execDigest: V.unhex(asked.payload.execDigest) }, { stimulusIds: Uint32Array.from({ length: 300 }, (_, j) => j * 7) }).matches);
  check("what goes on-chain never carries them: onResult saw two results and no counts", submitted.length === 2 && submitted.every((r) => !("counts" in r)));
  const forged = Uint32Array.from(counts); forged[counts.findIndex((c) => c > 0)] += 1; check("one spike more in one neuron, and the digest says so", V.hex(L.countsDigest(forged)) !== asked.payload.execDigest);
  check("`counts` is asked for with true, not with anything truthy", !("counts" in (await announce({ counts: "yes" })).payload)); }

// ---- over a relay, at FlyWire's size ----
{ const N = 139255, STEPS = 5; const payload = synthesizePayloadV2("counts-big", N, 400000); const A = await node("0x" + "22".repeat(32), "counts-big", payload, "lif", STEPS);
  const R = await startRelay({ name: "r" }); const cA = new RelayClient([R.url], A.nd.key); await cA.connect(); const cC = new RelayClient([R.url], keypair("0x" + "55".repeat(32))); await cC.connect();
  new NodeService(A.nd, cA, {}).serve(A.st.mep.mepId);
  const resp = await cC.request(V.hex(A.nd.key.address), "task-announce", A.mepHex, { taskId: "0x" + "cd".repeat(32), stimulusSeed: 3, steps: STEPS, commitStride: 5, counts: true }, { timeoutMs: 60000, responseType: "result" });
  const counts = decode(resp.payload.counts);
  check(`a brain of ${N.toLocaleString()} neurons: ${(resp.payload.counts.length / 1024).toFixed(0)} kB of base64 crosses the relay in one signed envelope, and hashes to the digest`, counts.length === N && V.hex(L.countsDigest(counts)) === resp.payload.execDigest && R.stats.dropped === 0);
  cA.close(); cC.close(); await R.close(); }

// ---- int-spmv-q16 ----
{ const STEPS = 2; const payload = synthesizePayload("counts-spmv", 6000, 60000); const A = await node("0x" + "33".repeat(32), "counts-spmv", payload, undefined, STEPS);
  const handlers = {}; new NodeService(A.nd, { serve: (type, id, fn) => { handlers[type] = fn; return () => {}; } }, {}).serve(A.st.mep.mepId);
  const r = await handlers["task-announce"]({ mepId: [...A.nd.models.keys()][0], payload: { taskId: "0x" + "ef".repeat(32), steps: STEPS, commitStride: 1, stimulusSeed: 9, counts: true } });
  check("int-spmv-q16 has no spike counts: asking is harmless", r.type === "result" && !("counts" in r.payload)); }
console.log(fails ? `${fails} FAILURES` : "counts: all checks passed"); process.exit(fails ? 1 : 0);
