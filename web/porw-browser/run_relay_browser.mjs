// The relay transport with a REAL browser tab as the instance: headless Chromium loads the node page,
// connects to two in-process relays (native WebSocket), announces its claim and serves audits and a task;
// this process is the auditor and the task client. Usage:
//   PW_CHROMIUM=/path/to/chrome node run_relay_browser.mjs [--payload file.bin] [--steps 2] [--samples 16]
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { loadKernelFromBytes, TILE_BYTES } from "./porw.js";
import { makeMep } from "./mep.js";
import { decodeHeader } from "./model.js";
import { keypair, recoverAddress } from "./claim.js";
import { synthesizePayload } from "./synth.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { Auditor } from "./auditor.js";
import { resultHash } from "./node_service.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]); return acc; }, []));
const steps = Number(a.steps || 2), samples = Number(a.samples || 16);
const payload = a.payload ? new Uint8Array(fs.readFileSync(a.payload)) : synthesizePayload("relay-browser", 8000, 80000);
const prof = V.profileOf(payload, decodeHeader(payload));
const mep = makeMep({ name: "relay-browser", ...prof }); const mepHex = V.hex(mep.mepId);
const R1 = await startRelay({ name: "r1" }), R2 = await startRelay({ name: "r2" });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const server = http.createServer((req, res) => { const u = new URL(req.url, "http://x");
  if (u.pathname === "/payload.bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.from(payload.buffer, payload.byteOffset, payload.length)); }
  const f = path.join(here, decodeURIComponent(u.pathname)); if (!f.startsWith(here) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const browser = await chromium.launch(launch); const page = await browser.newPage(); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
await page.goto(`http://127.0.0.1:${port}/node_page.html?steps=${steps}&name=relay-browser&relays=${encodeURIComponent(R1.url + "," + R2.url)}`);
await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 5 * 60 * 1000 });
const err = await page.evaluate(() => window.__error); if (err) { console.error(err); process.exit(1); }
const info = await page.evaluate(() => window.porwNode.info()); const tabAddr = (await page.evaluate(() => window.porwNode.served())).address;
console.log(`tab: ${info.nTiles} tiles, ${info.neurons} neurons, mep match=${info.mepId === mepHex}, instance ${tabAddr}`);
// auditor (this process) on both relays
const U = keypair("0x" + "44".repeat(32)); const cU = new RelayClient([R1.url, R2.url], U); await cU.connect();
const challenge = Vf.freshChallenge(); const aud = new Auditor(cU, mep, challenge, { samples, timeoutMs: 20000 }); aud.watch();
const chHex = Array.from(challenge, (x) => x.toString(16).padStart(2, "0")).join("");
let t0 = performance.now(); const ann = await page.evaluate(([c]) => window.porwNode.announce(c), [chHex]);
await new Promise((r) => setTimeout(r, 200)); const res = await aud.audits[0]; const auditMs = performance.now() - t0;
console.log(`audit over the relay: claim ok=${res.claimOk}, ${res.verdicts.length} openings ${res.verdicts.every((v) => v.verdict === "no_fraud") ? "all no_fraud" : "NOT all no_fraud"} in ${auditMs.toFixed(0)} ms (tab served ${JSON.stringify((await page.evaluate(() => window.porwNode.served())))}, auditor dedupe ${cU.duplicates})`);
// a task from a client process -> the tab executes and returns a signed result
const C = keypair("0x" + "55".repeat(32)); const cC = new RelayClient([R2.url], C); await cC.connect();
const taskId = new Uint8Array(32).fill(0x31); t0 = performance.now();
const resp = await cC.request(tabAddr, "task-announce", mepHex, { taskId: V.hex(taskId), stimulusSeed: 4 }, { timeoutMs: 60000, responseType: "result" }); const taskMs = performance.now() - t0;
const rp = resp.payload; const sigOk = V.hex(recoverAddress(resultHash(taskId, V.unhex(rp.execDigest), V.unhex(rp.execRoot)), V.unhex(rp.signature))) === tabAddr;
const re = Vf.reexecute(await loadKernelFromBytes(fs.readFileSync(path.join(here, "sketch.wasm"))), payload, { stimulusSeed: 4, execDigest: V.unhex(rp.execDigest) }, mep);
console.log(`task over the relay: result signed by the tab=${sigOk}, client re-execution matches=${re.matches}, ${taskMs.toFixed(0)} ms round trip`);
const ok = info.mepId === mepHex && res.ok && sigOk && re.matches;
await browser.close(); server.close(); cU.close(); cC.close(); await Promise.all([R1.close(), R2.close()]);
console.log(ok ? "ALL PASS" : "FAILURES"); process.exit(ok ? 0 : 1);
