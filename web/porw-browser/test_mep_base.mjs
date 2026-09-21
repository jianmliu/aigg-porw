import assert from 'node:assert/strict';
import * as M from './mep.js';
import { hex } from './verify.js';
const bytes = h => Uint8Array.from(h.slice(2).match(/../g), x => parseInt(x, 16));
const rawId = '0x580ae348fa8d127fa04811abfdebc0109fa0b8596cad5d1aaa3ffb04b5c474ec';
const raw = { name: 'fixture', mepId: bytes(rawId) };
const base = '0x' + '11'.repeat(32), owner = '0x0000000000000000000000000000000000000b0b';
assert.equal(typeof M.withBase, 'function', 'base wrapper must be exported');
// Independently computed using viem encodePacked; shared with Solidity regression test.
const derived = M.withBase(raw, base);
assert.equal(hex(derived.mepId), '0xddb08cb666f3b1db1dee519b5839f726e0c713bc5f121b524477e7398cc8a019');
assert.equal(hex(derived.rawProfileId), rawId);
assert.equal(hex(derived.profileId), hex(derived.mepId));
assert.equal(hex(derived.baseMepId), base);
assert.equal(hex(raw.mepId), rawId);
assert.equal(raw.baseMepId, undefined);
assert.equal(hex(M.withBase(raw, bytes(base)).mepId), hex(derived.mepId));
assert.notEqual(hex(M.withBase(raw, '0x' + '22'.repeat(32)).mepId), hex(derived.mepId));
const terms = M.withTerms(derived, owner, 1000);
assert.equal(hex(terms.mepId), '0x222415c44a2994cbcac0058bd238d52d21460d4a7e7dce084f7d56fc2da84cb4');
assert.equal(hex(terms.rawProfileId), rawId);
assert.equal(hex(terms.profileId), hex(derived.mepId));
assert.equal(hex(M.withTerms(terms, owner, 1000).mepId), hex(terms.mepId));
assert.equal(hex(M.withTerms(raw, owner, 1000).mepId), '0xc247fefe110d36571757c174d94093885a0faababcbaef79c96c83595021e19a');
for (const invalid of [null, undefined, '0x' + '00'.repeat(32), '0x1234', '0x' + 'gg'.repeat(32), new Uint8Array(31)]) {
  assert.throws(() => M.withBase(raw, invalid), /base/);
}
assert.throws(() => M.withBase(derived, base), /base/);
assert.throws(() => M.withBase(derived, '0x' + '22'.repeat(32)), /base/);
assert.throws(() => M.withBase(M.withTerms(raw, owner, 1000), base), /terms/);
assert.throws(() => M.withBase(terms, base), /base|terms/);
console.log('ALL PASS: base MEP identities, terms order and legacy vectors');
