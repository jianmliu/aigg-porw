// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/mesh/RelayRegistry.sol";

contract RelayRegistryTest is Test {
    RelayRegistry reg; address op1 = address(0x1001); address op2 = address(0x1002);
    function setUp() public { reg = new RelayRegistry(0.5 ether, 20); vm.deal(op1, 1 ether); vm.deal(op2, 1 ether); }
    function test_register_list_update_exit() public {
        vm.prank(op1); reg.register{value: 0.5 ether}("wss://r1.example/porw");
        vm.prank(op2); reg.register{value: 0.5 ether}("wss://r2.example/porw");
        (address[] memory ops, string[] memory urls) = reg.relays();
        assertEq(ops.length, 2); assertEq(urls[0], "wss://r1.example/porw"); assertEq(urls[1], "wss://r2.example/porw");
        vm.prank(op1); reg.register("wss://r1.example/v2"); // url update, no extra bond
        (, urls) = reg.relays(); assertEq(urls[0], "wss://r1.example/v2");
        vm.prank(op1); vm.expectRevert(bytes("state")); reg.register{value: 0.5 ether}("x");
        vm.prank(op1); reg.requestExit();
        (ops,) = reg.relays(); assertEq(ops.length, 1, "exiting relay hidden from clients"); assertEq(ops[0], op2);
        vm.prank(op1); vm.expectRevert(bytes("not yet")); reg.finalizeExit();
        vm.roll(block.number + 20); uint256 bal = op1.balance; vm.prank(op1); reg.finalizeExit();
        assertEq(op1.balance, bal + 0.5 ether, "bond returned");
        vm.prank(op1); reg.register{value: 0.5 ether}("wss://r1.example/back"); (ops,) = reg.relays(); assertEq(ops.length, 2, "can come back");
    }
    function test_bond_required() public { vm.prank(op1); vm.expectRevert(bytes("bond")); reg.register{value: 0.1 ether}("wss://x"); }
}
