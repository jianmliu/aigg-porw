// Wallet flow in a real browser tab: an injected EIP-1193 wallet (simulated OUTSIDE the page — the page only
// sees window.ethereum; signing happens in this process through the generic typed-data path, like MetaMask)
// signs one EIP-712 Delegation for the tab's ephemeral session key; the tab then signs its claim as typed data
// with the session key over the relay; this process (auditor) verifies signature, delegation and openings.
//   PW_CHROMIUM=/path/to/chrome node run_wallet_browser.mjs
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { TILE_BYTES } from "./porw.js";
import { makeMep } from "./mep.js";
import { decodeHeader } from "./model.js";
import { keypair } from "./claim.js";
import { synthesizePayload } from "./synth.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
import * as E from "./eip712.js";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { Auditor } from "./auditor.js";
import { domains, CHAIN_ID, CM_ADDR, MK_ADDR, REG_ADDR } from "./export_fixtures_common.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const payload = synthesizePayload("wallet-browser", 6000, 60000); const steps = 2;
const prof = V.profileOf(payload, decodeHeader(payload));
const mep = makeMep({ name: "wallet-browser", ...prof }); const mepHex = V.hex(mep.mepId);
const R1 = await startRelay({ name: "r1" });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const server = http.createServer((req, res) => { const u = new URL(req.url, "http://x");
  if (u.pathname === "/payload.bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.from(payload.buffer, payload.byteOffset, payload.length)); }
  const f = path.join(here, decodeURIComponent(u.pathname)); if (!f.startsWith(here) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f)); });
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
// the "wallet": a key held by this process; the page gets an EIP-1193 shim whose requests are answered here
const wallet = E.localWallet("0x" + "ab".repeat(32)); const prompts = [];
const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
const browser = await chromium.launch(launch); const page = await browser.newPage(); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
await page.exposeFunction("__walletRequest", async (method, params) => {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet.address];
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_signTypedData_v4") { const td = JSON.parse(params[1]); prompts.push(td.primaryType); if (params[0].toLowerCase() !== wallet.address) throw new Error("wrong account"); return wallet.signTypedData(td); } // generic path, as a wallet does
  throw new Error("unsupported " + method);
});
await page.addInitScript(() => { window.ethereum = { isPorwTestWallet: true, request: ({ method, params }) => window.__walletRequest(method, params || []) }; });
await page.goto(`http://127.0.0.1:${port}/node_page.html?steps=${steps}&name=wallet-browser&relays=${encodeURIComponent(R1.url)}&wallet=1&chain=${CHAIN_ID}&cm=${CM_ADDR}&market=${MK_ADDR}&registry=${REG_ADDR}`);
await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 5 * 60 * 1000 });
const err = await page.evaluate(() => window.__error); if (err) { console.error(err); process.exit(1); }
const w = await page.evaluate(() => window.porwNode.wallet());
console.log(`tab: wallet ${w.wallet} delegated session ${w.session}; wallet prompts so far: ${prompts.join(",")}`);
const U = keypair("0x" + "44".repeat(32)); const cU = new RelayClient([R1.url], U); await cU.connect();
const challenge = Vf.freshChallenge(); const aud = new Auditor(cU, mep, challenge, { samples: 16, timeoutMs: 20000, domain: domains.claimManager, blockNumber: 1000 }); aud.watch();
const chHex = Array.from(challenge, (x) => x.toString(16).padStart(2, "0")).join("");
const ann = await page.evaluate(([c]) => window.porwNode.announce(c), [chHex]); await new Promise((r) => setTimeout(r, 200)); const res = await aud.audits[0];
const delOk = E.verifyDelegation(domains.registry, w.delegation, w.session, 1000) === wallet.address.toLowerCase();
console.log(`audit: claim ok=${res.claimOk} (EIP-712, signer = session ${res.from}), resolved instance = ${res.instance} (wallet? ${res.instance === wallet.address.toLowerCase()}), delegation valid=${delOk}, ${res.verdicts.length} openings ${res.verdicts.every((v) => v.verdict === "no_fraud") ? "all no_fraud" : "NOT all"}, claimId ${res.escalation ? "n/a" : "keyed by the wallet"}`);
const onePrompt = prompts.length === 1 && prompts[0] === "Delegation";
console.log(`wallet prompted exactly once (Delegation), never for the claim: ${onePrompt}`);
const ok = res.claimOk && res.ok && res.instance === wallet.address.toLowerCase() && delOk && onePrompt && ann.claimHash;
await browser.close(); server.close(); cU.close(); await R1.close();
console.log(ok ? "ALL PASS" : "FAILURES"); process.exit(ok ? 0 : 1);
