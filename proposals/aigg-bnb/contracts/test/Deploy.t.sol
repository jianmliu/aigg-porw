// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployBNB.s.sol";

/// The deployment script wires the mesh with the BNB parameters and the commit-reveal beacon.
contract DeployTest is Test {
    function test_deploy_wiring() public {
        DeployBNB s = new DeployBNB(); DeployBNB.Deployed memory d = s.run();
        InstanceRegistry inst = InstanceRegistry(d.instances); PoRWClaimManager cm = PoRWClaimManager(d.claims); TaskMarket m = TaskMarket(payable(d.market));
        assertEq(inst.claimManager(), d.claims); assertTrue(inst.slasher(d.disputes)); assertEq(m.disputes(), d.disputes);
        assertEq(address(cm.beaconProvider()), d.beacon, "claims roll from the commit-reveal beacon");
        assertEq(cm.EPOCH_BLOCKS(), 600); assertEq(inst.UNIT(), 0.05 ether); assertEq(cm.SLASH_AMOUNT(), 0.5 ether); assertEq(RelayRegistry(d.relays).BOND(), 1 ether);
        assertEq(CommitRevealBeacon(d.beacon).EPOCH_BLOCKS(), 600);
    }
}
