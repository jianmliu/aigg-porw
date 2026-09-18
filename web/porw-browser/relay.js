// Stage-1 relay: a stateless WebSocket pub/sub hub. Anyone can run one; instances connect to several.
// Wire protocol (JSON text frames):
//   client -> relay : { op: "sub", topic } | { op: "unsub", topic } | { op: "pub", topic, env }
//   relay  -> client: { op: "msg", topic, env } | { op: "hello", relay, topics? } | { op: "err", reason }
// The relay verifies envelope signatures and freshness before forwarding (cheap spam control) but is
// NOT trusted: every receiver verifies again, and settlement is on-chain. A relay can only drop or
// delay messages (liveness), which is why clients fan out to >= 2 relays and the chain keeps the
// fallback paths (respondOpening / dispute moves are direct transactions).
import { WebSocketServer } from "ws";
import { verifyEnvelope } from "./envelope.js";

export function startRelay({ port = 0, host = "127.0.0.1", name = "relay", censor = null, maxFrame = 4 * 1024 * 1024 } = {}) {
  const wss = new WebSocketServer({ port, host, maxPayload: maxFrame });
  const rooms = new Map(); // topic -> Set<ws>
  const stats = { received: 0, forwarded: 0, dropped: 0, censored: 0 };
  const join = (t, ws) => { if (!rooms.has(t)) rooms.set(t, new Set()); rooms.get(t).add(ws); };
  const leave = (t, ws) => { const r = rooms.get(t); if (r) { r.delete(ws); if (!r.size) rooms.delete(t); } };
  wss.on("connection", (ws) => {
    const mine = new Set();
    ws.send(JSON.stringify({ op: "hello", relay: name }));
    ws.on("message", (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return ws.send(JSON.stringify({ op: "err", reason: "json" })); }
      if (m.op === "sub" && typeof m.topic === "string") { join(m.topic, ws); mine.add(m.topic); return; }
      if (m.op === "unsub" && typeof m.topic === "string") { leave(m.topic, ws); mine.delete(m.topic); return; }
      if (m.op === "pub" && typeof m.topic === "string") {
        stats.received++;
        const from = verifyEnvelope(m.env);
        if (!from) { stats.dropped++; return ws.send(JSON.stringify({ op: "err", reason: "bad envelope" })); }
        if (censor && censor(from, m.topic, m.env)) { stats.censored++; return; } // a misbehaving relay (test mode): silently drops
        const frame = JSON.stringify({ op: "msg", topic: m.topic, env: m.env });
        for (const peer of rooms.get(m.topic) || []) if (peer.readyState === 1) { peer.send(frame); stats.forwarded++; }
        return;
      }
      ws.send(JSON.stringify({ op: "err", reason: "op" }));
    });
    ws.on("close", () => { for (const t of mine) leave(t, ws); });
  });
  return new Promise((res) => wss.on("listening", () => res({ name, port: wss.address().port, url: `ws://${host}:${wss.address().port}`, stats, rooms, close: () => new Promise((r) => wss.close(r)) })));
}
