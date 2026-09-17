// Drive the PoRW browser PoC in headless Chromium and write a JSON report.
//   node run_browser.mjs --mib 521 --workers 4 --repeats 3 --out result.json
// Serves this directory over local HTTP (module workers need http, not file://).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
  return a;
}, []));
const mib = args.mib || "521", workers = args.workers || "4", repeats = args.repeats || "3";
const out = args.out || path.join(here, "result.json");

const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const p = path.join(here, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html");
  if (!p.startsWith(here) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": mime[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { chromium } = await import("playwright");
const launch = { headless: true, args: ["--no-sandbox", "--js-flags=--max-old-space-size=4096"] };
if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const browser = await chromium.launch(launch);
const page = await browser.newPage();
page.on("console", (m) => process.stderr.write("[page] " + m.text() + "\n"));
page.on("pageerror", (e) => process.stderr.write("[pageerror] " + e.message + "\n"));
const url = `http://127.0.0.1:${port}/index.html?mib=${mib}&workers=${workers}&repeats=${repeats}`;
await page.goto(url);
await page.waitForFunction(() => window.__porwResult !== undefined, null, { timeout: 15 * 60 * 1000 });
const result = await page.evaluate(() => window.__porwResult);
result.chromium = browser.version();
await browser.close();
server.close();

fs.writeFileSync(out, JSON.stringify(result));
const s = result.single, m = result.multi;
console.log(`chromium ${result.chromium}  backend=${result.backend}  ${result.mib} MiB (${result.nTiles} tiles)`);
if (s) console.log(`single : ${s.medianMs.toFixed(1)} ms  ${s.gibPerS.toFixed(2)} GiB/s  (fill ${s.fillMs.toFixed(0)} ms)`);
if (m) console.log(`multi  : x${m.workers} workers, slowest median ${m.medianMs.toFixed(1)} ms  ${m.gibPerS.toFixed(2)} GiB/s  per-worker ${m.perWorkerMedianMs.map((x) => x.toFixed(0)).join("/")} ms`);
console.log(`ok=${result.ok}${result.error ? " error=" + result.error : ""}  -> ${out}`);
process.exit(result.ok ? 0 : 1);
