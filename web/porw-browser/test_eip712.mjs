// EIP-712 typed data: the node's hand-coded digests == the wallet's generic typed-data hashing; claims and
// results signed as typed data verify; a wallet delegates a session key and the auditor resolves it.
import fs from "node:fs";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
import { synthesizePayload } from "./synth.js";
import { keypair, recoverAddress } from "./claim.js";
import * as V from "./verify.js";
import * as Vf from "./verifier.js";
import * as E from "./eip712.js";
import { resultSigningHash } from "./node_service.js";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const CM = "0x000000000000000000000000000000000000c1a1", MK = "0x000000000000000000000000000000000000b0b0", REG = "0x0000000000000000000000000000000000005e61";
const domains = { claimManager: E.domain(31337, CM), market: E.domain(31337, MK), registry: E.domain(31337, REG) };
check("type strings match the Solidity library", E.encodeType("Claim") === "Claim(bytes32 schemeDigest,bytes32 mepId,bytes32 modelId,bytes32 partialsRoot,uint64 coverageBytes,bytes32 challenge)" && E.encodeType("Delegation") === "Delegation(address instance,address session,uint64 expiry)");
// wallet W (bonded) delegates session key S (the tab's key)
const W = E.localWallet("0x" + "aa".repeat(32)); const S = keypair("0x" + "11".repeat(32));
const del = await E.makeDelegation(W, domains.registry, V.hex(S.address), 10000);
check("delegation: generic typed-data signature recovers the wallet through the hand-coded digest", E.verifyDelegation(domains.registry, del, V.hex(S.address), 500) === W.address.toLowerCase());
check("delegation expired / wrong session / wrong domain -> null", E.verifyDelegation(domains.registry, del, V.hex(S.address), 10001) === null && E.verifyDelegation(domains.registry, del, W.address, 5) === null && E.verifyDelegation(domains.market, del, V.hex(S.address), 5) === null);
// node signs claims with the session key as EIP-712 typed data
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url)); const payload = synthesizePayload("eip712", 3000, 30000);
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32), domains, delegation: del });
const st = await node.loadModel("eip712", payload, { maxSteps: 2 }); const ch = new Uint8Array(32).fill(3); const r = await node.challenge(st.mep.mepId, ch, { steps: 2, stimulusSeed: 1 });
check("claim digest (node) == hashTypedData(eth_signTypedData_v4 JSON) (wallet view)", V.eq(r.digest, E.hashTypedData(E.typedData(domains.claimManager, "Claim", E.claimMessage(r.claim)))));
check("claim signature is over the EIP-712 digest, not the raw hash", V.eq(recoverAddress(r.digest, r.signature), S.address) && !V.eq(r.digest, r.claimHash));
const vc = Vf.verifyClaim(r, st.mep, ch, { domain: domains.claimManager, blockNumber: 100 });
check("verifier (domain) accepts and resolves the session signer to the bonded wallet", vc.ok && V.hex(vc.signer) === V.hex(S.address) && vc.instance === W.address.toLowerCase());
check("verifier without the domain rejects (raw-hash signature expected)", !Vf.verifyClaim(r, st.mep, ch).ok);
check("wrong domain (another chain / contract) rejects", !Vf.verifyClaim(r, st.mep, ch, { domain: E.domain(1, CM) }).ok && !Vf.verifyClaim(r, st.mep, ch, { domain: E.domain(31337, MK) }).ok);
check("expired delegation rejects", !Vf.verifyClaim(r, st.mep, ch, { domain: domains.claimManager, blockNumber: 20000 }).ok);
const taskId = new Uint8Array(32).fill(9); const h = resultSigningHash(domains.market, taskId, r.result.execDigest, r.result.execRoot);
check("result digest == hashTypedData(Result JSON)", V.eq(h, E.hashTypedData(E.typedData(domains.market, "Result", { taskId: V.hex(taskId), execDigest: V.hex(r.result.execDigest), execRoot: V.hex(r.result.execRoot) }))));
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
