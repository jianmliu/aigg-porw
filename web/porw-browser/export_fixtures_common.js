// Shared by the fixture exporters: fixed deployment addresses (forge tests deploy there with deployCodeTo),
// chain id, EIP-712 domains, and bonded-wallet + delegated-session-key pairs.
import * as E from "./eip712.js";
import { keypair } from "./claim.js";
import { hex } from "./verify.js";
export const CHAIN_ID = 31337, CM_ADDR = "0x000000000000000000000000000000000000c1a1", MK_ADDR = "0x000000000000000000000000000000000000b0b0", REG_ADDR = "0x0000000000000000000000000000000000005e61", DELEGATION_EXPIRY = 100000;
export const domains = { claimManager: E.domain(CHAIN_ID, CM_ADDR), market: E.domain(CHAIN_ID, MK_ADDR), registry: E.domain(CHAIN_ID, REG_ADDR) };
/** wallet (bonded instance, key byte `walletByte`) + delegated session key (`sessionByte`, the tab's signing key) */
export async function walletAndSession(walletByte, sessionByte) {
  const w = E.localWallet("0x" + walletByte.repeat(32)); const sessionPriv = "0x" + sessionByte.repeat(32); const sk = keypair(sessionPriv);
  const delegation = await E.makeDelegation(w, domains.registry, hex(sk.address), DELEGATION_EXPIRY);
  return { wallet: w, sessionPriv, session: sk, delegation };
}
