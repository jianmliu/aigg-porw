// One subscriber must never silence another.
//
// Handlers on a topic belong to independent things: an Aggregator per epoch, a NodeService per brain. They were
// invoked in a bare loop, so the first one to throw stopped the message reaching any of the rest -- and nothing
// recorded that it had happened.
//
// This is what swallowed six consecutive epochs of a live host's residency claims on BSC testnet. The claim reached
// the relayer, the relay reported it delivered, an aggregator for a different epoch threw while considering it, and
// the aggregator it was actually FOR never saw it. `claims: 0, rejected: 0, delivered: 1` -- the three numbers that
// should not be able to occur together, and no error at either end. The host's eligibility lapsed and the first
// thing to notice was a gateway call returning model_cold, half an hour later.
import { startRelay } from "./relay.js"; import { RelayClient } from "./relay_client.js";
import { keypair } from "./claim.js"; import { topicMep } from "./envelope.js";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = await startRelay({ port: 8894, name: "isolation" }); const url = "ws://127.0.0.1:8894";
const MEP = "0x" + "cd".repeat(32), OTHER = "0x" + "ef".repeat(32);
const pub = new RelayClient([url], keypair("0x" + "11".repeat(32))); await pub.connect();
const sub = new RelayClient([url], keypair("0x" + "22".repeat(32))); await sub.connect();

let first = 0, second = 0, third = 0;
sub.subscribe(topicMep(MEP), () => { first++; });
sub.subscribe(topicMep(MEP), () => { throw new Error("an aggregator for another epoch blew up"); });
sub.subscribe(topicMep(MEP), () => { second++; });
sub.subscribe(topicMep(MEP), () => { third++; });
await sleep(200);

const r = await pub.publishTo(topicMep(MEP), "claim", MEP, { x: 1 });
await sleep(400);
check("the relay delivered it", r.delivered === 1);
check("the subscriber before the throwing one ran", first === 1);
check("AND the two after it ran: a throw does not end the message", second === 1 && third === 1, `second ${second}, third ${third}`);
check("the throw is counted rather than lost", sub.handlerErrors === 1, `handlerErrors ${sub.handlerErrors}`);

// and it keeps working afterwards: a poisoned handler must not poison the topic for good
const r2 = await pub.publishTo(topicMep(MEP), "claim", MEP, { x: 2 });
await sleep(300);
check("the next message is delivered to everyone too", r2.delivered === 1 && first === 2 && second === 2 && third === 2, `${first}/${second}/${third}`);

// a throwing handler on one topic does not touch another
let other = 0; sub.subscribe(topicMep(OTHER), () => { other++; });
await sleep(150); await pub.publishTo(topicMep(OTHER), "claim", OTHER, { x: 3 }); await sleep(300);
check("another topic is unaffected", other === 1);

pub.close(); sub.close(); await relay.close();
console.log(fails ? `${fails} FAILURES` : "handler isolation: all checks passed");
process.exit(fails ? 1 : 0);
