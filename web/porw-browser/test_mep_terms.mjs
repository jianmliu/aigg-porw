// MEP terms: the JS id must be the one MEPRegistry.registerMEPWithTerms derives. The vector is the mesh fixtures'
// profile (MeshFixtures.MEP_ID) under beneficiary 0x…0B0B at 1000 bps; contracts/evm/test/MepTerms.t.sol pins the
// same literal from the Solidity side, so a drift on either side fails one of the two.
import { withTerms } from "./mep.js";
const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); const unhex = (h) => Uint8Array.from(h.slice(2).match(/../g), (x) => parseInt(x, 16));
let fails = 0; const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) fails++; };
const profile = { name: "fixture", mepId: unhex("0x580ae348fa8d127fa04811abfdebc0109fa0b8596cad5d1aaa3ffb04b5c474ec") };
const OWNER = "0x" + "0".repeat(36) + "0b0b"; const EXPECT = "0xc247fefe110d36571757c174d94093885a0faababcbaef79c96c83595021e19a";
const t = withTerms(profile, OWNER, 1000);
console.log("  terms id", hex(t.mepId));
check("terms id matches the Solidity vector", hex(t.mepId) === EXPECT);
check("the profile id is kept, and terms do not nest", hex(t.profileId) === hex(profile.mepId) && hex(withTerms(t, OWNER, 1000).mepId) === hex(t.mepId));
check("other terms, another mep", hex(withTerms(profile, OWNER, 1001).mepId) !== hex(t.mepId) && hex(withTerms(profile, "0x" + "0".repeat(36) + "0b0c", 1000).mepId) !== hex(t.mepId));
for (const [b, bps] of [["0x" + "0".repeat(40), 1000], [OWNER, 0], [OWNER, 10001], [OWNER, 1.5]]) { let threw = false; try { withTerms(profile, b, bps); } catch { threw = true; } check(`refused: ${b.slice(-4)} @ ${bps}`, threw); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
