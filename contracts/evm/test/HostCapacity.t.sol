// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/mesh/HostCapacity.sol";
contract HostCapacityTest is Test {
 HostCapacity c; address h=address(1); address m=address(2); address n=address(3);
 function setUp() public {c=new HostCapacity();c.setMarket(m,true);c.setMarket(n,true);}
 function cap(uint16 k) internal {vm.prank(h);c.setCapacity(k);}
 function reserve(address market,bytes32 id,uint64 expiry) internal returns(bool){vm.prank(market);return c.reserve(id,h,expiry);}
 function test_defaultBoundsAndAuthorization() public {
  assertEq(c.capacityOf(h),0);assertEq(c.availableSlots(h),0);
  vm.prank(h);vm.expectRevert(bytes("capacity"));c.setCapacity(65);
  vm.expectRevert(bytes("market"));c.reserve(bytes32(0),h,10);
  vm.prank(h);vm.expectRevert(bytes("owner"));c.setMarket(h,true);
  cap(64);assertEq(c.MAX_SLOTS(),64);assertEq(c.availableSlots(h),64);
 }
 function test_sharedNamespacePauseReductionAndRevocation() public {
  cap(2);assertTrue(reserve(m,bytes32(uint256(1)),10));assertTrue(reserve(n,bytes32(uint256(1)),10));
  assertFalse(reserve(m,bytes32(uint256(2)),10));cap(1);assertEq(c.activeSlots(h),2);assertEq(c.availableSlots(h),0);
  cap(0);c.setMarket(m,false);vm.prank(m);c.release(bytes32(uint256(1)),h);assertEq(c.activeSlots(h),1);
  vm.prank(m);vm.expectRevert(bytes("market"));c.reserve(bytes32(uint256(2)),h,10);
  vm.prank(n);c.release(bytes32(uint256(1)),h);assertEq(c.activeSlots(h),0);assertEq(c.availableSlots(h),0);
 }
 function test_expiryInclusiveAndStaleReleaseCannotFreeReusedLease() public {
  cap(1);assertTrue(reserve(m,bytes32(uint256(1)),10));vm.roll(10);assertEq(c.activeSlots(h),1);assertFalse(reserve(n,bytes32(uint256(1)),15));
  vm.roll(11);assertEq(c.activeSlots(h),0);assertTrue(reserve(n,bytes32(uint256(1)),15));
  vm.prank(m);c.release(bytes32(uint256(1)),h);assertEq(c.activeSlots(h),1);
  vm.prank(n);c.release(bytes32(uint256(1)),h);assertEq(c.activeSlots(h),0);
  assertTrue(reserve(n,bytes32(uint256(2)),15));vm.prank(n);c.release(bytes32(uint256(1)),h);assertEq(c.activeSlots(h),1);
  (uint16 limit,uint16 active,uint16 free)=c.snapshot(h);assertEq(limit,1);assertEq(active,1);assertEq(free,0);
 }
}
