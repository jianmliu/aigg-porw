// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./fixtures/BrowserClaimFixture.sol";
import "../src/mesh/PorwEIP712.sol";

/// The browser node's claim, verified the way a settlement contract would: recompute the packed mep_id,
/// the raw claim hash (the off-chain identifier) and the EIP-712 digest the session key signed, ecrecover
/// the session key, and check the wallet's Delegation that binds it to the bonded instance.
/// Fixture: web/porw-browser/export_fixtures.mjs writes test/fixtures/BrowserClaimFixture.sol.
contract BrowserClaimTest is Test {
    function test_browser_claim_hash_and_ecrecover() public {
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
        // EIP-712: domain (chain id, claim manager address) + Claim struct — what the wallet / session key signs
        vm.chainId(BrowserClaimFixture.CHAIN_ID);
        bytes32 ds = PorwEIP712.domainSeparator(BrowserClaimFixture.CLAIM_MANAGER);
        bytes32 d = PorwEIP712.digest(ds, PorwEIP712.claimStructHash(BrowserClaimFixture.SCHEME_DIGEST, mep, BrowserClaimFixture.MODEL_ID, BrowserClaimFixture.PARTIALS_ROOT, BrowserClaimFixture.COVERAGE_BYTES, BrowserClaimFixture.CHALLENGE, BrowserClaimFixture.DEVICE_ID, BrowserClaimFixture.EXEC_DIGEST, BrowserClaimFixture.STIMULUS_SEED));
        assertEq(d, BrowserClaimFixture.CLAIM_DIGEST, "EIP-712 digest == the node's (hand-coded) == the wallet's (generic typed data)");
        bytes memory sig = BrowserClaimFixture.signature();
        assertEq(sig.length, 65, "sig len");
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        assertEq(ecrecover(d, v, r, s), BrowserClaimFixture.SIGNER, "ecrecover session key");
        assertTrue(ecrecover(h, v, r, s) != BrowserClaimFixture.SIGNER, "the raw hash is not what was signed");
        assertTrue(ecrecover(d ^ bytes32(uint256(1)), v, r, s) != BrowserClaimFixture.SIGNER, "tamper");
        // the wallet's Delegation binds the session key to the bonded instance
        (address instance, address session, uint64 expiry, bytes memory dsig) = BrowserClaimFixture.delegation();
        bytes32 dd = PorwEIP712.digest(PorwEIP712.domainSeparator(BrowserClaimFixture.REGISTRY), PorwEIP712.delegationStructHash(instance, session, expiry));
        (bytes32 r2, bytes32 s2, uint8 v2) = _split(dsig);
        assertEq(ecrecover(dd, v2, r2, s2), instance, "delegation signed by the wallet"); assertEq(session, BrowserClaimFixture.SIGNER); assertEq(instance, BrowserClaimFixture.INSTANCE);
    }
    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
    }
}
