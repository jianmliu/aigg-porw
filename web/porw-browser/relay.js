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

// `server` attaches the hub to an existing http server (optionally under `path`) instead of opening a port of
// its own, so an API and the hub can share one port -- which is all a single-port host gives you.
// `pingMs` is the keepalive sweep: idle WebSocket connections are closed by everything that sits in front of a
// relay (CDNs and PaaS routers cut them at around 100 s), and a node holds its connection open across whole
// epochs with nothing to say, so without this every peer silently disappears between claims. A ping also puts
// traffic on the path in both directions, and a peer that stops answering is reaped instead of lingering.
export function startRelay({ port = 0, host = "127.0.0.1", name = "relay", censor = null, maxFrame = 4 * 1024 * 1024, server = null, path = null, pingMs = 25000 } = {}) {
  const wss = server ? new WebSocketServer({ server, path, maxPayload: maxFrame }) : new WebSocketServer({ port, host, maxPayload: maxFrame });
  const rooms = new Map(); // topic -> Set<ws>
  const stats = { received: 0, forwarded: 0, dropped: 0, censored: 0, reaped: 0, get clients() { return wss.clients.size; } };
  const join = (t, ws) => { if (!rooms.has(t)) rooms.set(t, new Set()); rooms.get(t).add(ws); };
  const leave = (t, ws) => { const r = rooms.get(t); if (r) { r.delete(ws); if (!r.size) rooms.delete(t); } };
  wss.on("connection", (ws) => {
    const mine = new Set();
    ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
    ws.on("error", () => {}); // a peer that resets its connection must not take the relay's process down
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
  const sweep = pingMs > 0 ? setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { stats.reaped++; ws.terminate(); continue; } // never answered the last ping
      ws.isAlive = false; try { ws.ping(); } catch {}
    }
  }, pingMs) : null;
  sweep?.unref?.(); // never hold a process open just to keep pinging
  const close = () => { if (sweep) clearInterval(sweep); return new Promise((r) => wss.close(r)); };
  if (server) return Promise.resolve({ name, port: null, path, url: null, stats, rooms, close }); // the caller owns the port
  return new Promise((res) => wss.on("listening", () => res({ name, port: wss.address().port, url: `ws://${host}:${wss.address().port}`, path: null, stats, rooms, close })));
}
