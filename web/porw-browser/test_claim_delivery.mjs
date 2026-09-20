// A claim that reaches nobody is not a claim.
//
// A residency claim is the one thing a host does that nothing replies to, and for most of an epoch nothing depends
// on it -- so a claim that arrived nowhere looks exactly like one that worked. On BSC testnet a relayer redeploy
// left a live host announcing into nothing for six consecutive epochs: the host logged success every time, the
// aggregator counted zero, neither end reported anything, and the host's eligibility quietly lapsed until somebody
// restarted it. `publish` returning normally had meant only that a socket accepted the bytes.
//
// So the relay now says how many subscribers a publish reached, and `announce` refuses to call a delivery of zero a
// success: it redials and tries again on the new connection, and throws if that too reaches nobody.
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js"; import { PorwNode } from "./node.js"; import { NodeService } from "./node_service.js";
import { synthesizePayload } from "./synth.js"; import { keypair } from "./claim.js";
import { startRelay } from "./relay.js"; import { RelayClient } from "./relay_client.js";
import { topicMep } from "./envelope.js";
import * as V from "./verify.js";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8899;
let relay = await startRelay({ port: PORT, name: "test-relay" });
const url = `ws://127.0.0.1:${PORT}`;

const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const st = await nd.loadModel("brain", synthesizePayload("brain", 2000, 20000), { maxSteps: 2 });
const rc = new RelayClient([url], nd.key, { backoffMs: 100 }); await rc.connect();
const svc = new NodeService(nd, rc, {});
const challenge = new Uint8Array(32).fill(7);

// an aggregator: something subscribed to this brain's topic, as a relayer is
const listener = new RelayClient([url], keypair("0x" + "22".repeat(32))); await listener.connect();
let heard = 0; listener.subscribe(topicMep(V.hex(st.mep.mepId)), () => heard++);
await sleep(200);

{ const r = await svc.announce(st.mep.mepId, challenge);
  await sleep(200);
  check("a claim with an aggregator listening is delivered, and says so", r.delivered === 1 && heard === 1, `delivered ${r.delivered}, heard ${heard}`); }

// nobody is subscribed any more: the socket is open and the publish is accepted, which is the trap
listener.close(); await sleep(300);
{ let threw = null; const before = rc.reconnects;
  try { await svc.announce(st.mep.mepId, challenge, { redial: false }); } catch (e) { threw = String(e.message); }
  check("a claim nobody is subscribed to is a failure, not a success", /reached no relay/.test(threw || ""), String(threw));
  check("and it did not pretend by redialling when told not to", rc.reconnects === before); }

// the live shape: the relay restarts underneath a host that stays up
{ const listener2 = new RelayClient([url], keypair("0x" + "33".repeat(32))); await listener2.connect();
  let heard2 = 0; listener2.subscribe(topicMep(V.hex(st.mep.mepId)), () => heard2++); await sleep(200);
  // a redeploy kills the process, and the sockets with it -- `close()` alone waits for clients that never leave
  for (const set of relay.rooms.values()) for (const ws of set) { try { ws.terminate(); } catch {} }
  await relay.close(); await sleep(400);
  relay = await startRelay({ port: PORT, name: "test-relay-2" });
  const listener3 = new RelayClient([url], keypair("0x" + "44".repeat(32))); await listener3.connect();
  let heard3 = 0; listener3.subscribe(topicMep(V.hex(st.mep.mepId)), () => heard3++); await sleep(200);
  let threw = null, r = null;
  try { r = await svc.announce(st.mep.mepId, challenge); } catch (e) { threw = String(e.message); }
  await sleep(300);
  check("after the relay restarts under it, the host redials and the claim lands on the new one",
    !threw && r?.delivered >= 1 && heard3 === 1, `${threw || ""} delivered ${r?.delivered}, heard ${heard3}`);
  listener2.close(); listener3.close(); }

rc.close(); for (const set of relay.rooms.values()) for (const ws of set) { try { ws.terminate(); } catch {} } await relay.close();
console.log(fails ? `${fails} FAILURES` : "claim delivery: all checks passed");
process.exit(fails ? 1 : 0);
