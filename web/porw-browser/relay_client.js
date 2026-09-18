// Isomorphic multi-relay client (browser WebSocket or Node's global WebSocket): every publish goes to
// all connected relays, every received envelope is verified and de-duplicated by its message hash, so
// one honest relay is enough for delivery. Request/response rides on per-instance inbox topics.
import { verifyEnvelope, envelopeId, seal, topicInbox } from "./envelope.js";
import { hex } from "./verify.js";

export class RelayClient {
  constructor(urls, key, { onLog = null, seenCap = 10000, reconnect = true, backoffMs = 500, maxBackoffMs = 15000 } = {}) {
    this.urls = urls; this.key = key; this.address = hex(key.address); this.socks = []; this.subs = new Map(); // topic -> Set<handler>
    this.seen = new Map(); this.seenCap = seenCap; this.pending = new Map(); this.onLog = onLog; this.received = 0; this.duplicates = 0; this.rejected = 0;
    this.closed = false; this.reconnects = 0; this.opts = { reconnect, backoffMs, maxBackoffMs };
  }
  async connect() {
    this.socks = await Promise.all(this.urls.map((u) => new Promise((res) => this._dial({ url: u, ws: null, open: false, tries: 0, timer: null }, res))));
    this.subscribe(topicInbox(this.address), (env) => this._onInbox(env)); // own inbox: responses to our requests
    return this.socks.filter((s) => s.open).length;
  }
  // A relay connection is idle most of the time and anything in front of it will eventually cut it, so a drop is
  // normal operation rather than an error: redial with backoff and replay our subscriptions on the new socket.
  // Without this a tab stops announcing claims and answering tasks without ever reporting that anything is wrong.
  _dial(entry, done) {
    let settled = false; const finish = () => { if (!settled) { settled = true; done && done(entry); } };
    let ws; try { ws = new WebSocket(entry.url); } catch { finish(); this._retry(entry); return; }
    entry.ws = ws;
    ws.onopen = () => { entry.open = true; entry.tries = 0; for (const t of this.subs.keys()) try { ws.send(JSON.stringify({ op: "sub", topic: t })); } catch {} finish(); };
    ws.onerror = () => finish(); // a close event follows and schedules the retry
    ws.onclose = () => { const was = entry.open; entry.open = false; finish(); if (was && this.onLog) this.onLog(`relay ${entry.url} dropped, reconnecting`); this._retry(entry); };
    ws.onmessage = (ev) => this._onFrame(entry, ev.data);
  }
  _retry(entry) {
    if (this.closed || !this.opts.reconnect || entry.timer) return;
    const n = ++entry.tries; const cap = Math.min(this.opts.maxBackoffMs, this.opts.backoffMs * 2 ** (n - 1));
    entry.timer = setTimeout(() => { entry.timer = null; this.reconnects++; this._dial(entry); }, cap / 2 + Math.random() * (cap / 2)); // jittered, so a relay restart is not a stampede
    entry.timer.unref?.();
  }
  _onFrame(entry, data) {
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m.op !== "msg") return;
    const from = verifyEnvelope(m.env); if (!from) { this.rejected++; return; }       // never trust the relay's check
    const id = envelopeId(m.env); if (this.seen.has(id)) { this.duplicates++; return; } // same message via another relay
    this.seen.set(id, entry.url); if (this.seen.size > this.seenCap) this.seen.delete(this.seen.keys().next().value);
    this.received++;
    for (const h of this.subs.get(m.topic) || []) h(m.env, from, entry.url);
  }
  subscribe(topic, handler) {
    if (!this.subs.has(topic)) { this.subs.set(topic, new Set()); for (const s of this.socks) if (s.open && s.ws) try { s.ws.send(JSON.stringify({ op: "sub", topic })); } catch {} }
    this.subs.get(topic).add(handler); return () => this.subs.get(topic)?.delete(handler);
  }
  /** publish a signed envelope to every connected relay; returns the envelope */
  publish(topic, type, mepIdHex, payload) {
    const env = seal(type, mepIdHex, payload, this.key); const frame = JSON.stringify({ op: "pub", topic, env });
    let sent = 0; for (const s of this.socks) if (s.open && s.ws && s.ws.readyState === 1) { s.ws.send(frame); sent++; }
    if (!sent) throw new Error("no relay connected"); return env;
  }
  /** request/response to another instance's inbox; resolves with the response envelope or rejects on timeout */
  request(toAddrHex, type, mepIdHex, payload, { timeoutMs = 5000, responseType = null } = {}) {
    const reqId = hex(crypto.getRandomValues(new Uint8Array(16)));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(reqId); rej(new Error(`timeout waiting for ${responseType || type} from ${toAddrHex}`)); }, timeoutMs);
      this.pending.set(reqId, { res: (env) => { clearTimeout(t); this.pending.delete(reqId); res(env); }, responseType, to: toAddrHex.toLowerCase() });
      this.publish(topicInbox(toAddrHex), type, mepIdHex, { ...payload, reqId, replyTo: this.address });
    });
  }
  _onInbox(env) {
    const p = env.payload && this.pending.get(env.payload.reqId); if (!p) return;
    if (p.responseType && env.type !== p.responseType) return;
    if (env.from.toLowerCase() !== p.to) return; // only the addressee may answer
    p.res(env);
  }
  /** handle requests addressed to us: handler(env, from) -> response payload (or null to ignore) */
  serve(type, mepIdHex, handler) {
    return this.subscribe(topicInbox(this.address), async (env, from) => {
      if (env.type !== type || !env.payload || !env.payload.reqId || !env.payload.replyTo) return;
      const out = await handler(env, from); if (out === null || out === undefined) return;
      this.publish(topicInbox(env.payload.replyTo), out.type, env.mepId, { ...out.payload, reqId: env.payload.reqId });
    });
  }
  close() { this.closed = true; for (const s of this.socks) { if (s.timer) { clearTimeout(s.timer); s.timer = null; } try { s.ws && s.ws.close(); } catch {} } }
}
