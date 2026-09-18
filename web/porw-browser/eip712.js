// EIP-712 typed data for the mesh (mirrors contracts/evm/src/mesh/PorwEIP712.sol):
//   Claim(bytes32 schemeDigest,bytes32 mepId,bytes32 modelId,bytes32 partialsRoot,uint64 coverageBytes,bytes32 challenge,bytes32 deviceId)
//   Result(bytes32 taskId,bytes32 execDigest,bytes32 execRoot)
//   Delegation(address instance,address session,uint64 expiry)
// Two independent hashing paths: hand-coded struct digests (what the node signs) and a generic
// hashTypedData over the eth_signTypedData_v4 JSON (what a wallet computes) — tests require both to
// agree with each other and with Solidity.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { signHash, recoverAddress, keypair } from "./claim.js";
import { hex, unhex, eq } from "./verify.js";

export const NAME = "PoRW Mesh", VERSION = "1";
const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const word = (bytes) => { const o = new Uint8Array(32); o.set(bytes, 32 - bytes.length); return o; }; // right-aligned (numbers, addresses)
const wordBig = (n) => { const o = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; };
export const TYPES = {
  EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
  Claim: [{ name: "schemeDigest", type: "bytes32" }, { name: "mepId", type: "bytes32" }, { name: "modelId", type: "bytes32" }, { name: "partialsRoot", type: "bytes32" }, { name: "coverageBytes", type: "uint64" }, { name: "challenge", type: "bytes32" }, { name: "deviceId", type: "bytes32" }],
  Result: [{ name: "taskId", type: "bytes32" }, { name: "execDigest", type: "bytes32" }, { name: "execRoot", type: "bytes32" }],
  Delegation: [{ name: "instance", type: "address" }, { name: "session", type: "address" }, { name: "expiry", type: "uint64" }],
};
export const encodeType = (name) => name + "(" + TYPES[name].map((f) => f.type + " " + f.name).join(",") + ")";
export const typeHash = (name) => keccak_256(utf8(encodeType(name)));
export const domain = (chainId, verifyingContract) => ({ name: NAME, version: VERSION, chainId, verifyingContract: typeof verifyingContract === "string" ? verifyingContract : hex(verifyingContract) });
export const domainSeparator = (d) => keccak_256(cat(typeHash("EIP712Domain"), keccak_256(utf8(d.name)), keccak_256(utf8(d.version)), wordBig(d.chainId), word(unhex(d.verifyingContract))));
export const digest = (d, structHash) => keccak_256(cat(new Uint8Array([0x19, 0x01]), domainSeparator(d), structHash));
// ---- hand-coded struct hashes (node side) ----
export const claimStructHash = (c) => keccak_256(cat(typeHash("Claim"), c.schemeDigest, c.mepId, c.modelId, c.partialsRoot, wordBig(c.coverageBytes), c.challenge, c.deviceId));
export const claimDigest = (d, c) => digest(d, claimStructHash(c));
export const resultDigest = (d, taskId32, execDigest32, execRoot32) => digest(d, keccak_256(cat(typeHash("Result"), taskId32, execDigest32, execRoot32)));
export const delegationDigest = (d, instance20, session20, expiry) => digest(d, keccak_256(cat(typeHash("Delegation"), word(instance20), word(session20), wordBig(expiry))));
// ---- eth_signTypedData_v4 JSON (wallet side) ----
export const typedData = (d, primaryType, message) => ({ types: { EIP712Domain: TYPES.EIP712Domain, [primaryType]: TYPES[primaryType] }, primaryType, domain: d, message });
export const claimMessage = (c) => ({ schemeDigest: hex(c.schemeDigest), mepId: hex(c.mepId), modelId: hex(c.modelId), partialsRoot: hex(c.partialsRoot), coverageBytes: String(c.coverageBytes), challenge: hex(c.challenge), deviceId: hex(c.deviceId) });
/** generic EIP-712 encoder over the JSON (primitive fields only: bytes32, uintN, address, string) — the wallet's view */
export function hashTypedData(td) {
  const enc = (type, v) => {
    if (type === "bytes32") return unhex(v);
    if (type === "address") return word(unhex(v));
    if (type.startsWith("uint")) return wordBig(v);
    if (type === "string") return keccak_256(utf8(v));
    if (td.types[type]) return hashStruct(type, v);
    throw new Error("unsupported type " + type);
  };
  const encType = (t) => t + "(" + td.types[t].map((f) => f.type + " " + f.name).join(",") + ")";
  const hashStruct = (t, v) => keccak_256(cat(keccak_256(utf8(encType(t))), ...td.types[t].map((f) => enc(f.type, v[f.name]))));
  return keccak_256(cat(new Uint8Array([0x19, 0x01]), hashStruct("EIP712Domain", { ...td.domain, chainId: td.domain.chainId }), hashStruct(td.primaryType, td.message)));
}
// ---- wallets ----
/** a local key behaving like a wallet: signs the typed-data JSON through the generic path */
export function localWallet(privHex) { const k = keypair(privHex); return { address: hex(k.address), signTypedData: async (td) => hex(signHash(hashTypedData(td), k.priv)), key: k }; }
/** an injected EIP-1193 provider (MetaMask etc.) */
export function injectedWallet(ethereum) {
  return { address: null, async connect() { const a = await ethereum.request({ method: "eth_requestAccounts" }); this.address = a[0].toLowerCase(); this.chainId = Number(await ethereum.request({ method: "eth_chainId" })); return this.address; },
    async signTypedData(td) { return ethereum.request({ method: "eth_signTypedData_v4", params: [this.address, JSON.stringify(td)] }); } };
}
// ---- session-key delegation ----
export async function makeDelegation(wallet, d, sessionAddrHex, expiry) {
  const message = { instance: wallet.address, session: sessionAddrHex, expiry: String(expiry) };
  const sig = await wallet.signTypedData(typedData(d, "Delegation", message));
  return { instance: wallet.address.toLowerCase(), session: sessionAddrHex.toLowerCase(), expiry, sig, domain: d };
}
/** returns the instance (hex) the delegation binds `sessionAddrHex` to, or null */
export function verifyDelegation(d, del, sessionAddrHex, blockNumber) {
  try {
    if (!del || del.session.toLowerCase() !== sessionAddrHex.toLowerCase() || !(blockNumber <= Number(del.expiry))) return null;
    const rec = recoverAddress(delegationDigest(d, unhex(del.instance), unhex(del.session), del.expiry), unhex(del.sig));
    return eq(rec, unhex(del.instance)) ? del.instance.toLowerCase() : null;
  } catch { return null; }
}
