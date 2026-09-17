// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./fixtures/BrowserClaimFixture.sol";

/// The browser node's signed claim, verified the way a settlement contract would:
/// recompute the packed mep_id and claim hash from the fields and ecrecover the signer.
/// Fixture: web/porw-browser/export_fixtures.mjs writes test/fixtures/BrowserClaimFixture.sol.
contract BrowserClaimTest is Test {
    function test_browser_claim_hash_and_ecrecover() public pure {
        // scheme pin and execution kind
        assertEq(BrowserClaimFixture.SCHEME_DIGEST, keccak256("aigg:porw:sketch-tile-keccak:v1"), "scheme digest");
        assertEq(BrowserClaimFixture.EXEC_KIND, keccak256("aigg:exec:int-spmv-q16:v1"), "exec kind");
        // the MEP id pins the execution profile
        bytes32 mep = keccak256(abi.encodePacked(BrowserClaimFixture.SCHEME_DIGEST, BrowserClaimFixture.MODEL_ID, BrowserClaimFixture.EXEC_KIND, BrowserClaimFixture.STEPS, BrowserClaimFixture.CLAMP_Q16));
        assertEq(mep, BrowserClaimFixture.MEP_ID, "mep id encoding");
        // the contract recomputes the claim hash from the fields — the encoding is pinned here
        bytes32 h = keccak256(abi.encodePacked(
            BrowserClaimFixture.SCHEME_DIGEST, mep, BrowserClaimFixture.MODEL_ID, BrowserClaimFixture.PARTIALS_ROOT, BrowserClaimFixture.COVERAGE_BYTES,
            BrowserClaimFixture.CHALLENGE, BrowserClaimFixture.DEVICE_ID, BrowserClaimFixture.EXEC_DIGEST, BrowserClaimFixture.STIMULUS_SEED
        ));
        assertEq(h, BrowserClaimFixture.CLAIM_HASH, "claim hash encoding");
        bytes memory sig = BrowserClaimFixture.signature();
        assertEq(sig.length, 65, "sig len");
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        assertEq(ecrecover(h, v, r, s), BrowserClaimFixture.SIGNER, "ecrecover signer");
        assertTrue(ecrecover(h ^ bytes32(uint256(1)), v, r, s) != BrowserClaimFixture.SIGNER, "tamper");
    }
    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
    }
}
