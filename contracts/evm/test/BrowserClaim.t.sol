// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

/// The browser node's signed claim, verified the way a settlement contract would:
/// recompute the packed claim hash from its fields and ecrecover the signer.
/// Fixture: web/porw-browser/test_node.mjs writes test/fixtures/browser-claim.json.
contract BrowserClaimTest is Test {
    function test_browser_claim_hash_and_ecrecover() public view {
        string memory j = vm.readFile("test/fixtures/browser-claim.json");
        bytes32 schemeDigest = vm.parseJsonBytes32(j, ".schemeDigest");
        bytes32 mepId        = vm.parseJsonBytes32(j, ".mepId");
        bytes32 modelId      = vm.parseJsonBytes32(j, ".modelId");
        bytes32 partialsRoot = vm.parseJsonBytes32(j, ".partialsRoot");
        uint64  coverage     = uint64(vm.parseJsonUint(j, ".coverageBytes"));
        bytes32 challenge    = vm.parseJsonBytes32(j, ".challenge");
        bytes32 deviceId     = vm.parseJsonBytes32(j, ".deviceId");
        bytes32 execDigest   = vm.parseJsonBytes32(j, ".execDigest");
        uint32  stimulusSeed = uint32(vm.parseJsonUint(j, ".stimulusSeed"));
        bytes32 execKind     = vm.parseJsonBytes32(j, ".mep.execKind");
        uint32  steps        = uint32(vm.parseJsonUint(j, ".mep.steps"));
        uint32  clampQ16     = uint32(vm.parseJsonUint(j, ".mep.clampQ16"));
        bytes32 claimHash    = vm.parseJsonBytes32(j, ".claimHash");
        bytes memory sig     = vm.parseJsonBytes(j, ".signature");
        address signer       = vm.parseJsonAddress(j, ".signer");

        // scheme pin: keccak256("aigg:porw:sketch-tile-keccak:v1")
        assertEq(schemeDigest, keccak256("aigg:porw:sketch-tile-keccak:v1"), "scheme digest");
        // the contract recomputes the claim hash from the fields — the encoding is pinned here
        // the MEP id pins the execution profile (scheme, model, exec kind, steps, clamp)
        assertEq(execKind, keccak256("aigg:exec:int-spmv-q16:v1"), "exec kind");
        assertEq(keccak256(abi.encodePacked(schemeDigest, modelId, execKind, steps, clampQ16)), mepId, "mep id encoding");
        bytes32 h = keccak256(abi.encodePacked(schemeDigest, mepId, modelId, partialsRoot, coverage, challenge, deviceId, execDigest, stimulusSeed));
        assertEq(h, claimHash, "claim hash encoding");
        assertEq(sig.length, 65, "sig len");
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        assertEq(ecrecover(h, v, r, s), signer, "ecrecover signer");
        // a flipped bit in the hash must not recover the signer
        assertTrue(ecrecover(h ^ bytes32(uint256(1)), v, r, s) != signer, "tamper");
    }
    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
    }
}
