// Signed message envelope for the mesh transport — transport-agnostic (relay today, gossipsub later).
//   env = { type, mepId (hex32), from (hex20), ts (ms), payload (any JSON), sig (hex65) }
//   msgHash = keccak256("porw-msg" || type || mepId || BE64 ts || keccak256(utf8(canonical JSON payload)))
// The signer is the instance's reward key (the same key that signs claims and results), so a relay,
// an auditor or a contract can attribute every message to a bonded instance. Relays never need to
// be trusted for correctness: receivers verify; relays only affect liveness.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { signHash, recoverAddress } from "./claim.js";
import { hex, unhex, eq } from "./verify.js";

const be64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export const utf8 = (s) => new TextEncoder().encode(s);
/** canonical JSON: sorted object keys, no whitespace (arrays keep order) */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
// "result-refused": an executor's answer to a task or batch whose announced initStateRoot is not the state_0 it built
export const TYPES = ["claim", "open-request", "open-response", "task-announce", "batch-announce", "result", "result-refused", "claim-proof-request", "claim-proof", "relay-hello"];
export function msgHash(type, mepIdHex, ts, payload) {
  return keccak_256(cat(utf8("porw-msg"), utf8(type), unhex(mepIdHex), be64(ts), keccak_256(utf8(canonical(payload)))));
}
export function seal(type, mepIdHex, payload, key, ts = Date.now()) {
  const h = msgHash(type, mepIdHex, ts, payload);
  return { type, mepId: mepIdHex, from: hex(key.address), ts, payload, sig: hex(signHash(h, key.priv)) };
}
/** returns the recovered sender (hex) or null; never throws on malformed input */
export function verifyEnvelope(env, { maxSkewMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  try {
    if (!env || typeof env.type !== "string" || !TYPES.includes(env.type)) return null;
    if (typeof env.mepId !== "string" || env.mepId.length !== 66 || typeof env.from !== "string" || env.from.length !== 42) return null;
    if (!Number.isInteger(env.ts) || Math.abs(now - env.ts) > maxSkewMs) return null;
    const h = msgHash(env.type, env.mepId, env.ts, env.payload);
    const addr = recoverAddress(h, unhex(env.sig));
    return eq(addr, unhex(env.from)) ? env.from : null;
  } catch { return null; }
}
export const envelopeId = (env) => hex(msgHash(env.type, env.mepId, env.ts, env.payload));
// topics: one per MEP (claims, task announcements) and one inbox per instance (requests, responses)
export const topicMep = (mepIdHex) => "mep:" + mepIdHex;
export const topicInbox = (addrHex) => "inst:" + addrHex.toLowerCase();
