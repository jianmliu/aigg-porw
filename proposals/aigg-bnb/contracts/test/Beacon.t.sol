// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CommitRevealBeacon.sol";
import "../src/GreenfieldDA.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/PoRWClaimManager.sol";
import "aigg-porw/PorwVerifierKeccak.sol";

contract BeaconTest is Test {
    CommitRevealBeacon b; address p1 = address(0xA1); address p2 = address(0xA2); address p3 = address(0xA3);
    uint64 constant EPOCH = 100; uint64 constant CW = 20; uint64 constant RW = 20; uint256 constant DEP = 0.1 ether;
    function setUp() public { b = new CommitRevealBeacon(EPOCH, CW, RW, DEP); vm.deal(p1, 1 ether); vm.deal(p2, 1 ether); vm.deal(p3, 1 ether); }
    function h(bytes32 s, address who) internal pure returns (bytes32) { return keccak256(abi.encodePacked(s, who)); }

    function test_commit_reveal_beacon_and_claim_manager_integration() public {
        // epoch 1 starts at block 100; commit window = blocks 80..99
        vm.roll(50); vm.prank(p1); vm.expectRevert(bytes("commit window")); b.commit{value: DEP}(h("s1", p1));
        vm.roll(85); vm.prank(p1); b.commit{value: DEP}(h("s1", p1)); vm.prank(p2); b.commit{value: DEP}(h("s2", p2)); vm.prank(p3); b.commit{value: DEP}(h("s3", p3));
        vm.prank(p1); vm.expectRevert(bytes("committed")); b.commit{value: DEP}(h("x", p1));
        assertEq(b.beaconFor(1), bytes32(0), "not ready before the reveal window closes");
        vm.roll(99); vm.prank(p1); vm.expectRevert(bytes("reveal window")); b.reveal(1, "s1");
        vm.roll(105); vm.prank(p1); b.reveal(1, "s1"); vm.prank(p2); vm.expectRevert(bytes("bad reveal")); b.reveal(1, "wrong"); vm.prank(p2); b.reveal(1, "s2");
        assertEq(p1.balance, 1 ether, "deposit refunded on reveal");
        vm.roll(119); assertEq(b.beaconFor(1), bytes32(0), "still not ready");
        vm.roll(120);
        bytes32 expect = keccak256(abi.encodePacked(keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), bytes32("s1"))), bytes32("s2"))), uint64(1)));
        assertEq(b.beaconFor(1), expect, "beacon = keccak(revealed secrets in order || epoch)");
        // p3 withheld: its deposit is forfeited, its secret excluded
        vm.expectRevert(bytes("reveal open")); vm.roll(119); b.forfeit(1, p3);
        vm.roll(120); b.forfeit(1, p3); assertEq(b.pool(), DEP);
        // the claim manager rolls epoch 1 from the provider (and refuses an epoch without a beacon)
        MEPRegistry meps = new MEPRegistry(); InstanceRegistry inst = new InstanceRegistry(0.05 ether, 10); PorwVerifierKeccak v = new PorwVerifierKeccak();
        PoRWClaimManager cm = new PoRWClaimManager(meps, inst, v, EPOCH, 10, 0.01 ether, 0.5 ether, IBeacon(address(b)));
        assertEq(cm.rollEpoch(), expect, "claim manager records the provider's beacon");
        vm.roll(250); vm.expectRevert(bytes("beacon not ready")); cm.rollEpoch(); // epoch 2 had no commits
    }
    function test_beacon_needs_one_reveal() public { vm.roll(120); assertEq(b.beaconFor(1), bytes32(0)); }
    function test_greenfield_pointer_format() public pure {
        assertTrue(GreenfieldDA.isGreenfieldPointer(bytes("gnfd://aigg-brains/flywire-fafb-v783-min5.bin")));
        (string memory bkt, string memory obj) = GreenfieldDA.split(bytes("gnfd://aigg-brains/flywire-fafb-v783-min5.bin"));
        assertEq(bkt, "aigg-brains"); assertEq(obj, "flywire-fafb-v783-min5.bin");
        assertFalse(GreenfieldDA.isGreenfieldPointer(bytes("ipfs://Qm...")));
        assertFalse(GreenfieldDA.isGreenfieldPointer(bytes("gnfd:///obj")));
        assertFalse(GreenfieldDA.isGreenfieldPointer(bytes("gnfd://bucket/")));
        assertFalse(GreenfieldDA.isGreenfieldPointer(bytes("gnfd://Bucket/obj"))); // bucket names are lowercase
    }
}
