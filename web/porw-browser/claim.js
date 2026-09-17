// PoRW browser-node claim: EVM-packed encoding + secp256k1 signing (ecrecover-compatible).
// The claim binds residency (partials root over the model) and execution (deterministic
// inference digest) to one model_id, a fresh challenge, and the node's device id.
//
// claimHash = keccak256(abi.encodePacked(
//   bytes32 schemeDigest, bytes32 mepId, bytes32 modelId, bytes32 partialsRoot, uint64 coverageBytes,
//   bytes32 challenge, bytes32 deviceId, bytes32 execDigest, uint32 stimulusSeed))
// Signed raw (no EIP-191) in this PoC; a wallet deployment signs the same struct via EIP-712.
import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

const be64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export function encodeClaim(c) {
  return cat(c.schemeDigest, c.mepId, c.modelId, c.partialsRoot, be64(c.coverageBytes), c.challenge, c.deviceId, c.execDigest, be32(c.stimulusSeed));
}
export const claimHash = (c) => keccak_256(encodeClaim(c));

export function addressOf(pubUncompressed65) { return keccak_256(pubUncompressed65.subarray(1)).subarray(12); }
export function keypair(privHex) {
  const priv = privHex ? Uint8Array.from(privHex.replace(/^0x/, "").match(/../g).map((h) => parseInt(h, 16))) : secp.utils.randomSecretKey();
  const pub = secp.getPublicKey(priv, false);
  return { priv, pub, address: addressOf(pub) };
}
// returns Ethereum-style 65-byte signature r||s||v (v = 27 + recovery)
export function signHash(hash32, priv) {
  const sig = secp.sign(hash32, priv, { prehash: false, format: "recovered" }); // [rec][r][s]
  const out = new Uint8Array(65); out.set(sig.subarray(1, 65), 0); out[64] = 27 + sig[0];
  return out;
}
export function recoverAddress(hash32, sig65) {
  const rec = new Uint8Array(65); rec[0] = sig65[64] - 27; rec.set(sig65.subarray(0, 64), 1);
  const pub = secp.recoverPublicKey(rec, hash32, { prehash: false });
  const un = pub.length === 65 ? pub : secp.Point.fromBytes(pub).toBytes(false);
  return addressOf(un);
}
