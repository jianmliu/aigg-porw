// A local HTTP server stands in for a Greenfield SP: the honest object verifies against model_id; a
// tampered / stale object is rejected before the node would load it.
import http from "node:http";
import { synthesizePayload } from "../../../web/porw-browser/synth.js";
import { fetchVerified, parsePointer, modelIdOf } from "./greenfield.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const good = synthesizePayload("flywire-female", 3000, 30000); const stale = synthesizePayload("flywire-female-old", 3000, 30000); const tampered = Uint8Array.from(good); tampered[5000] ^= 1;
const objects = { "aigg-brains/flywire-fafb-v783-min5.bin": good, "aigg-brains/stale.bin": stale, "aigg-brains/tampered.bin": tampered };
const sp = http.createServer((req, res) => { const key = req.url.replace(/^\/view\//, ""); const o = objects[key]; if (!o) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.from(o)); });
await new Promise((r) => sp.listen(0, "127.0.0.1", r)); const ep = `http://127.0.0.1:${sp.address().port}`;
const modelId = modelIdOf(good);
check("pointer parses", JSON.stringify(parsePointer("gnfd://aigg-brains/flywire-fafb-v783-min5.bin")) === JSON.stringify({ bucket: "aigg-brains", object: "flywire-fafb-v783-min5.bin" }));
let threw = false; try { parsePointer("ipfs://x"); } catch { threw = true; } check("non-gnfd pointer rejected", threw);
const r = await fetchVerified(ep, "gnfd://aigg-brains/flywire-fafb-v783-min5.bin", modelId); check("honest object verifies against model_id", r.bytes.length === good.length && r.url.endsWith("/view/aigg-brains/flywire-fafb-v783-min5.bin"));
for (const [name, obj] of [["stale", "stale.bin"], ["tampered", "tampered.bin"]]) { let e = null; try { await fetchVerified(ep, "gnfd://aigg-brains/" + obj, modelId); } catch (x) { e = x.message; } check(`${name} object rejected before load (${e && e.split(":")[0]})`, e && e.startsWith("model id mismatch")); }
let e404 = null; try { await fetchVerified(ep, "gnfd://aigg-brains/missing.bin", modelId); } catch (x) { e404 = x.message; } check("missing object -> SP error surfaced", e404 && e404.startsWith("SP 404"));
sp.close(); console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
