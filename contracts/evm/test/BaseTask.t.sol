// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./ClaimValidity.t.sol";
import "../src/mesh/TaskMarket.sol";

/// Real aggregate base claims feed a later child's draw. Its exact execution identity remains intact.
contract BaseTaskTest is Test {
    MEPRegistry meps;
    InstanceRegistry inst;
    PoRWClaimManager cm;
    TaskMarket market;
    bytes32 base;
    address constant AGG = address(0xA66);

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        meps = new MEPRegistry();
        deployCodeTo("InstanceRegistry.sol:InstanceRegistry", abi.encode(uint256(1 ether), uint64(20)), FX.REGISTRY);
        inst = InstanceRegistry(FX.REGISTRY);
        inst.setMEPRegistry(address(meps));
        deployCodeTo(
            "PoRWClaimManager.sol:PoRWClaimManager",
            abi.encode(
                meps, inst, new PorwVerifierKeccak(), FX.EPOCH_BLOCKS, uint64(10), 0.1 ether, 0.5 ether, address(0)
            ),
            FX.CLAIM_MANAGER
        );
        cm = PoRWClaimManager(FX.CLAIM_MANAGER);
        inst.setClaimManager(address(cm));
        market = new TaskMarket(meps, inst, cm, 50);
        base = meps.registerMEP(
            IMEPRegistry.MEP(FX.MODEL_ID, FX.SCHEME_DIGEST, FX.EXEC_KIND, FX.NEURONS, FX.SYNAPSES, FX.SYNAPSE_ROOT, "")
        );
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = base;
        vm.deal(FX.A, 10 ether);
        vm.prank(FX.A);
        inst.bond{value: 2 ether}(ids);
        vm.deal(FX.L, 10 ether);
        vm.prank(FX.L);
        inst.bond{value: 2 ether}(ids);
        (address a, address s, uint64 e, bytes memory sig) = FX.delegationA();
        inst.delegateBySig(a, s, e, sig);
        (a, s, e, sig) = FX.delegationL();
        inst.delegateBySig(a, s, e, sig);
        vm.roll(FX.EPOCH_START);
        vm.difficulty(FX.PREVRANDAO);
        cm.rollEpoch();
        vm.prank(AGG);
        cm.postEpochRoot(1, FX.AGG_ROOT, FX.AGG_COUNT);
        (uint64 i, IPoRWClaimManager.ClaimLeaf memory leaf, bytes32[] memory proof) = FX.aggLeafA();
        cm.materializeClaim(1, AGG, i, leaf, proof);
        (i, leaf, proof) = FX.aggLeafL();
        cm.materializeClaim(1, AGG, i, leaf, proof);
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS);
        vm.difficulty(FX.TASK_PREVRANDAO);
        cm.rollEpoch();
        vm.deal(address(this), 10 ether);
    }

    function test_materialized_base_claim_draws_future_child_and_preserves_task_roster() public {
        IMEPRegistry.MEP memory m = meps.getMEP(base);
        m.modelId = bytes32(uint256(55));
        m.synapseRoot = bytes32(uint256(66));
        bytes32 child = meps.registerDerivedMEP(m, base);
        assertEq(cm.lastValidEpochPlus1(FX.A, child), 0);
        assertTrue(inst.isEligible(FX.A, child, FX.TASK_EPOCH));
        ITaskMarket.Task memory t = ITaskMarket.Task(
            child, FX.STIMULUS_SEED, FX.STEPS, FX.STRIDE, FX.TASK_INPUT_COMMIT, 1 ether, FX.TASK_DEADLINE, 2
        );
        bytes32 task = market.postTask{value: 1 ether}(t, bytes32(uint256(1)));
        (bytes32 stored,,,,) = market.taskInfo(task);
        assertEq(stored, child);
        assertTrue(stored != base);
        address[] memory roster = market.executors(task);
        assertEq(roster.length, 2);
        assertTrue((roster[0] == FX.A && roster[1] == FX.L) || (roster[1] == FX.A && roster[0] == FX.L));
        // Fraud in the base residency claim removes its standing for every derived profile.
        (uint64 unused, IPoRWClaimManager.ClaimLeaf memory leaf, bytes32[] memory unusedProof) = FX.aggLeafL();
        unused;
        unusedProof;
        cm.challengeOpening{value: 0.1 ether}(FX.L, base, 1, leaf.partialsRoot, leaf.coverageBytes, 7);
        cm.respondOpening(cm.claimIdOf(FX.L, base, 1), FX.openingFraud());
        assertFalse(inst.isEligible(FX.L, child, FX.TASK_EPOCH));
        assertEq(inst.bonded(FX.L), 1.5 ether);
        vm.prank(FX.A);
        inst.requestExit();
        assertFalse(inst.isEligible(FX.A, child, FX.TASK_EPOCH));
        address[] memory afterRoster = market.executors(task);
        assertEq(afterRoster[0], roster[0]);
        assertEq(afterRoster[1], roster[1]);
    }
    receive() external payable {}
}
