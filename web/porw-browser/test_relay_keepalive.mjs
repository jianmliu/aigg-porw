// Keepalive and reconnect on the stage-1 relay. A node holds its relay connection open across whole epochs with
// nothing to say, so anything in front of the relay (a CDN, a PaaS router) eventually cuts the idle connection.
// Before this, the server never pinged and the client's entire close handling was `open = false` -- so every tab
// silently stopped announcing claims and answering tasks, with nothing reporting that anything was wrong.
import { WebSocket as WS } from "ws";
import { startRelay } from "./relay.js";
import { RelayClient } from "./relay_client.js";
import { keypair } from "./claim.js";
import { topicMep } from "./envelope.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (p, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await sleep(50); } return false; };
const mepHex = "0x" + "ab".repeat(32); const topic = topicMep(mepHex);

const R = await startRelay({ name: "keepalive", pingMs: 150 });
const A = new RelayClient([R.url], keypair("0x" + "11".repeat(32)), { backoffMs: 100, maxBackoffMs: 400 });
const B = new RelayClient([R.url], keypair("0x" + "22".repeat(32)), { backoffMs: 100, maxBackoffMs: 400 });
await A.connect(); await B.connect();
const got = []; B.subscribe(topic, (env) => got.push(env.payload.n));
A.publish(topic, "claim", mepHex, { n: 1 });
check("baseline: a published envelope reaches the subscriber", await waitFor(() => got.includes(1)));

// ---- the connection is cut underneath the client, the way a proxy cuts an idle one ----
const before = B.reconnects; B.socks[0].ws.close();
check("the client noticed the drop", await waitFor(() => B.socks[0].open === false));
check("it dialled again on its own", await waitFor(() => B.reconnects > before && B.socks[0].open === true));
A.publish(topic, "claim", mepHex, { n: 2 });
check("and its subscription came back with it: envelopes flow again", await waitFor(() => got.includes(2)));

// ---- a peer that stops answering pings is reaped rather than left in the rooms forever ----
const clientsBefore = R.stats.clients;
const mute = new WS(R.url, { autoPong: false }); await waitFor(() => mute.readyState === 1);
check("a silent peer connected", R.stats.clients === clientsBefore + 1);
check("the relay reaped it once it stopped answering pings", await waitFor(() => R.stats.reaped >= 1 && R.stats.clients === clientsBefore, 6000));
check("the live clients were left alone", A.socks[0].open && B.socks[0].open && (await (async () => { A.publish(topic, "claim", mepHex, { n: 3 }); return waitFor(() => got.includes(3)); })()));

// ---- close() means closed: no redial after the caller is done ----
const r0 = B.reconnects; B.close(); await sleep(600);
check("close() stops the reconnect loop", B.reconnects === r0 && B.socks[0].open === false);

mute.close(); A.close(); await R.close();
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
