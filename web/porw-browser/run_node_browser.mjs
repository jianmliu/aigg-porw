// Drive the full browser-node loop in headless Chromium: the page is the prover (resident
// model, signed claims, openings); this process is the verifier (noble-only checks, sampled
// openings, redundant re-execution). Usage:
//   node run_node_browser.mjs --payload /path/payload.bin [--steps 2] [--samples 16] [--rounds 3] [--out result.json]
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import { makeMep } from "./mep.js";
import * as Vf from "./verifier.js";
import * as V from "./verify.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]); return acc; }, []));
const payloadPath = a.payload, steps = Number(a.steps || 2), samples = Number(a.samples || 16), rounds = Number(a.rounds || 3);
const payload = new Uint8Array(fs.readFileSync(payloadPath));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/payload.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length }); return res.end(Buffer.from(payload.buffer, payload.byteOffset, payload.length)); }
  const p = path.join(here, decodeURIComponent(u.pathname).replace(/^\/+/, "") || "node_page.html");
  if (!p.startsWith(here) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": mime[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const port = server.address().port;

// verifier's independent view of the model: MEP from the public bytes (noble keccak, no wasm)
let t0 = performance.now(); const nT = Math.floor(payload.length / TILE_BYTES); const lv = [];
for (let t = 0; t < nT; t++) lv.push(V.weightsLeaf(t, payload.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES)));
const mep = makeMep({ name: "flywire-female", modelId: V.merkleRoot(lv), steps }); const verifierModelMs = performance.now() - t0;

const { chromium } = await import("playwright");
const launch = { headless: true, args: ["--no-sandbox", "--js-flags=--max-old-space-size=4096"] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const browser = await chromium.launch(launch); const page = await browser.newPage();
page.on("pageerror", (e) => process.stderr.write("[pageerror] " + e.message + "\n"));
await page.goto(`http://127.0.0.1:${port}/node_page.html?steps=${steps}`);
await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 15 * 60 * 1000 });
const err = await page.evaluate(() => window.__error); if (err) { console.error(err); process.exit(1); }
const info = await page.evaluate(() => window.porwNode.info());
const out = { info, verifierModelMs, mepMatches: info.mepId === V.hex(mep.mepId), rounds: [] };
console.log(`page: ${info.nTiles} tiles, ${info.neurons} neurons / ${info.synapses} synapses, backend ${info.backend}, hc ${info.hc}`);
console.log(`load: fetch ${info.fetchMs.toFixed(0)} ms, weights leaves + model id ${info.leavesMs.toFixed(0)} ms (one-time) | verifier independent model id ${verifierModelMs.toFixed(0)} ms, MEP match=${out.mepMatches}`);
const kernel = await loadKernelFromBytes(fs.readFileSync(path.join(here, "sketch.wasm")));
for (let r = 0; r < rounds; r++) {
  const ch = Vf.freshChallenge(); const chHex = Array.from(ch, (x) => x.toString(16).padStart(2, "0")).join("");
  const resp = await page.evaluate(([c, s]) => window.porwNode.challenge(c, s), [chHex, r + 1]);
  const R = { claim: Object.fromEntries(Object.entries(resp.claim).map(([k, v]) => [k, typeof v === "string" ? V.unhex(v) : v])), claimHash: V.unhex(resp.claimHash), signature: V.unhex(resp.signature), address: V.unhex(resp.address) };
  const vc = Vf.verifyClaim(R, mep, ch);
  const sample = Vf.sampleTiles(ch, nT, samples); t0 = performance.now();
  const opens = await page.evaluate((ts) => ts.map((t) => window.porwNode.open(t)), sample); const openMs = performance.now() - t0;
  const verdicts = opens.map((o) => Vf.verifyOpening({ ...o, tile: V.unhex(o.tile), partialsProof: o.partialsProof.map(V.unhex), weightsProof: o.weightsProof.map(V.unhex) }, R.claim, vc.slotSeed, nT).verdict);
  t0 = performance.now(); const re = Vf.reexecute(kernel, payload, R.claim, mep); const reMs = performance.now() - t0;
  const t = resp.timings; const slotMs = t.sketchMs + t.commitMs + t.inferMs;
  out.rounds.push({ claimOk: vc.ok, signer: V.hex(vc.signer), verdicts, reexecMatches: re.matches, timings: t, slotMs, openMs, reMs });
  console.log(`round ${r + 1}: claim ok=${vc.ok} | sketch ${t.sketchMs.toFixed(0)} + commit ${t.commitMs.toFixed(0)} + infer ${t.inferMs.toFixed(0)} = ${slotMs.toFixed(0)} ms per slot | ${sample.length} openings ${verdicts.every((v) => v === "no_fraud") ? "all no_fraud" : verdicts.join(",")} (${openMs.toFixed(0)} ms) | re-exec match=${re.matches} (${reMs.toFixed(0)} ms)`);
}
await browser.close(); server.close();
if (a.out) fs.writeFileSync(a.out, JSON.stringify(out, null, 2));
const ok = out.mepMatches && out.rounds.every((x) => x.claimOk && x.reexecMatches && x.verdicts.every((v) => v === "no_fraud"));
console.log(ok ? "ALL PASS" : "FAILURES"); process.exit(ok ? 0 : 1);
