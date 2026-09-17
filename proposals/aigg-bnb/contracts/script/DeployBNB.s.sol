// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "aigg-porw/PorwVerifierKeccak.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/PoRWClaimManager.sol";
import "aigg-porw/mesh/TaskMarket.sol";
import "aigg-porw/mesh/ExecutionDisputes.sol";
import "aigg-porw/mesh/RelayRegistry.sol";
import "../src/CommitRevealBeacon.sol";

/// Deploys the mesh with BNB-chain parameters (env-overridable; defaults = docs/DESIGN.md §4 at ~1 s blocks).
///   forge script script/DeployBNB.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployBNB is Script {
    struct Deployed { address verifier; address meps; address instances; address beacon; address claims; address market; address disputes; address relays; }
    function run() external returns (Deployed memory d) {
        uint64 epochBlocks = uint64(vm.envOr("EPOCH_BLOCKS", uint256(600)));
        uint64 commitBlocks = uint64(vm.envOr("COMMIT_BLOCKS", uint256(120)));
        uint64 revealBlocks = uint64(vm.envOr("REVEAL_BLOCKS", uint256(120)));
        uint256 beaconDeposit = vm.envOr("BEACON_DEPOSIT", uint256(0.1 ether));
        uint256 unit = vm.envOr("UNIT", uint256(0.05 ether));
        uint64 exitDelay = uint64(vm.envOr("EXIT_DELAY", uint256(3 * 600)));
        uint64 openingWindow = uint64(vm.envOr("OPENING_WINDOW", uint256(120)));
        uint256 openingDeposit = vm.envOr("OPENING_DEPOSIT", uint256(0.01 ether));
        uint256 slashAmount = vm.envOr("SLASH_AMOUNT", uint256(0.5 ether));
        uint64 taskTimeout = uint64(vm.envOr("TASK_TIMEOUT", uint256(600)));
        uint64 roundBlocks = uint64(vm.envOr("ROUND_BLOCKS", uint256(300)));
        uint256 relayBond = vm.envOr("RELAY_BOND", uint256(1 ether));
        vm.startBroadcast();
        PorwVerifierKeccak verifier = new PorwVerifierKeccak();
        MEPRegistry meps = new MEPRegistry();
        InstanceRegistry inst = new InstanceRegistry(unit, exitDelay);
        CommitRevealBeacon beacon = new CommitRevealBeacon(epochBlocks, commitBlocks, revealBlocks, beaconDeposit);
        PoRWClaimManager claims = new PoRWClaimManager(meps, inst, verifier, epochBlocks, openingWindow, openingDeposit, slashAmount, IBeacon(address(beacon)));
        TaskMarket market = new TaskMarket(meps, inst, claims, taskTimeout);
        ExecutionDisputes disputes = new ExecutionDisputes(meps, inst, market, roundBlocks, slashAmount);
        RelayRegistry relays = new RelayRegistry(relayBond, exitDelay);
        inst.setClaimManager(address(claims)); inst.setSlasher(address(disputes), true); market.setDisputes(address(disputes));
        vm.stopBroadcast();
        d = Deployed(address(verifier), address(meps), address(inst), address(beacon), address(claims), address(market), address(disputes), address(relays));
        console.log("verifier", d.verifier); console.log("meps", d.meps); console.log("instances", d.instances); console.log("beacon", d.beacon);
        console.log("claims", d.claims); console.log("market", d.market); console.log("disputes", d.disputes); console.log("relays", d.relays);
    }
}
