// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./BaseTask.t.sol";
import "../src/mesh/HostCapacity.sol";
contract HostCapacityRealMarketTest is BaseTaskTest {
 function test_idleCapacityIsNotLotteryWeightAndFullHostIsSkipped() public {
  HostCapacity c=new HostCapacity();c.setMarket(address(market),true);market.setHostCapacity(address(c));
  vm.prank(FX.A);c.setCapacity(1);vm.prank(FX.L);c.setCapacity(10);
  TaskMarket legacy=new TaskMarket(meps,inst,cm,50);
  ITaskMarket.Task memory t=ITaskMarket.Task(base,FX.STIMULUS_SEED,FX.STEPS,FX.STRIDE,FX.TASK_INPUT_COMMIT,0,FX.TASK_DEADLINE,1);
  uint256 aDraws;uint256 lDraws;
  // Restore idle occupancy between paired draws; same task hash and beacon produce exactly the same winner.
  for(uint256 i=1;i<=24;i++){
   uint256 snap=vm.snapshotState();bytes32 id=market.postTask(t,bytes32(i));bytes32 other=legacy.postTask(t,bytes32(i));
   address picked=market.executors(id)[0];assertEq(picked,legacy.executors(other)[0]);if(picked==FX.A)aDraws++;else lDraws++;
   vm.revertToState(snap);
  }
  assertGt(aDraws,0);assertGt(lDraws,0);
  t.redundancy=2;market.postTask(t,bytes32(uint256(100)));assertEq(c.activeSlots(FX.A),1);assertEq(c.activeSlots(FX.L),1);
  t.redundancy=1;for(uint256 i=101;i<110;i++){bytes32 id=market.postTask(t,bytes32(i));assertEq(market.executors(id)[0],FX.L);}
  assertEq(c.activeSlots(FX.L),10);vm.expectRevert(bytes("insufficient capacity"));market.postTask(t,bytes32(uint256(110)));
 }
 function test_capacitySharedByFutureChildAndBaseAndRosterSurvivesPause() public {
  HostCapacity c=new HostCapacity();c.setMarket(address(market),true);market.setHostCapacity(address(c));vm.prank(FX.A);c.setCapacity(1);vm.prank(FX.L);c.setCapacity(1);
  IMEPRegistry.MEP memory m=meps.getMEP(base);m.modelId=bytes32(uint256(55));m.synapseRoot=bytes32(uint256(66));bytes32 child=meps.registerDerivedMEP(m,base);
  ITaskMarket.Task memory t=ITaskMarket.Task(child,FX.STIMULUS_SEED,FX.STEPS,FX.STRIDE,FX.TASK_INPUT_COMMIT,0,FX.TASK_DEADLINE,2);
  bytes32 id=market.postTask(t,bytes32(uint256(1)));assertEq(market.executors(id).length,2);t.mepId=base;
  vm.expectRevert(bytes("insufficient capacity"));market.postTask(t,bytes32(uint256(2)));
  vm.prank(FX.A);c.setCapacity(0);assertEq(c.activeSlots(FX.A),1);assertEq(market.executors(id).length,2);
  vm.roll(block.number+51);assertEq(c.activeSlots(FX.A),0);assertEq(market.executors(id).length,2);market.settle(id);
 }
}
