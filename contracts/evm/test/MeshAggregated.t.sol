// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PorwVerifierKeccak.sol";
import "../src/interfaces/PorwMesh.sol";
import "../src/mesh/MEPRegistry.sol";
import "../src/mesh/InstanceRegistry.sol";
import "../src/mesh/PoRWClaimManager.sol";
import "../src/mesh/TaskMarket.sol";
import "../src/mesh/ExecutionDisputes.sol";
import { MeshFixtures as FX } from "./fixtures/MeshFixtures.sol";

/// The aggregated claim path on fixtures from real node runs: one root per (MEP, epoch) posted by an untrusted
/// aggregator; instances materialize their claim with an inclusion proof (signature verified on-chain); a junk
/// leaf cannot be materialized; materialized claims give eligibility (tasks settle) and can be audited
/// (opening challenge -> fraud) exactly like directly submitted ones.
contract MeshAggregatedTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId; address A = FX.A; address B = FX.B; address L = FX.L; address AGG = address(0xA66);
    uint64 constant WINDOW = 10; uint256 constant DEPOSIT = 0.1 ether; uint256 constant SLASH = 0.5 ether; uint64 constant ROUND = 10;
    receive() external payable {}

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak(); meps = new MEPRegistry();
        deployCodeTo("InstanceRegistry.sol:InstanceRegistry", abi.encode(uint256(1 ether), uint64(20)), FX.REGISTRY); inst = InstanceRegistry(FX.REGISTRY);
        deployCodeTo("PoRWClaimManager.sol:PoRWClaimManager", abi.encode(meps, inst, verifier, FX.EPOCH_BLOCKS, WINDOW, DEPOSIT, SLASH, address(0)), FX.CLAIM_MANAGER); cm = PoRWClaimManager(FX.CLAIM_MANAGER);
        deployCodeTo("TaskMarket.sol:TaskMarket", abi.encode(meps, inst, cm, uint64(50)), FX.MARKET); market = TaskMarket(payable(FX.MARKET));
        disp = new ExecutionDisputes(meps, inst, market, ROUND, SLASH);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));
        mepId = meps.registerMEP(IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("gnfd://aigg-brains/demo") }));
        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        for (uint256 i = 0; i < 3; i++) { address who = i == 0 ? A : i == 1 ? B : L; vm.deal(who, 10 ether); vm.prank(who); inst.bond{value: 2 ether}(ids); }
        { (address ia, address sa, uint64 ea, bytes memory ga) = FX.delegationA(); inst.delegateBySig(ia, sa, ea, ga); }
        { (address ib, address sb, uint64 eb, bytes memory gb) = FX.delegationB(); inst.delegateBySig(ib, sb, eb, gb); }
        { (address il, address sl, uint64 el, bytes memory gl) = FX.delegationL(); inst.delegateBySig(il, sl, el, gl); }
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch();
    }
    function postRoot() internal { vm.prank(AGG); cm.postEpochRoot(mepId, 1, FX.AGG_ROOT, FX.AGG_COUNT); }

    function test_root_then_materialize_gives_eligibility_and_tasks_settle() public {
        vm.expectRevert(bytes("no root")); (uint64 ia, IPoRWClaimManager.ClaimLeaf memory la, bytes32[] memory pa) = FX.aggLeafA(); cm.materializeClaim(mepId, 1, AGG, ia, la, pa);
        uint256 g0 = gasleft(); postRoot(); uint256 gRoot = g0 - gasleft();
        vm.prank(AGG); vm.expectRevert(bytes("posted")); cm.postEpochRoot(mepId, 1, FX.AGG_ROOT, FX.AGG_COUNT);
        assertFalse(cm.hasValidClaim(A, mepId, 1), "a posted root alone is not on-chain eligibility");
        g0 = gasleft(); bytes32 idA = cm.materializeClaim(mepId, 1, AGG, ia, la, pa); uint256 gMat = g0 - gasleft(); // anyone may submit the instance's proof
        assertEq(idA, cm.claimIdOf(A, mepId, 1)); assertTrue(cm.hasValidClaim(A, mepId, 1));
        vm.expectRevert(bytes("claimed")); cm.materializeClaim(mepId, 1, AGG, ia, la, pa);
        (uint64 ib, IPoRWClaimManager.ClaimLeaf memory lb, bytes32[] memory pb) = FX.aggLeafB(); cm.materializeClaim(mepId, 1, AGG, ib, lb, pb);
        emit log_named_uint("gas postEpochRoot", gRoot); emit log_named_uint("gas materializeClaim", gMat);
        // epoch 2: A and B are eligible through their materialized claims; a task runs as in Mesh.t.sol
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
        assertTrue(inst.isEligible(A, mepId, 2) && inst.isEligible(B, mepId, 2) && !inst.isEligible(L, mepId, 2), "L never materialized");
        ITaskMarket.Task memory t = FX.task();
        bytes32 taskId = market.postTask{value: 1 ether}(t, FX.nonces()[0]);
        address[] memory ex = market.executors(taskId); assertEq(ex.length, 2);
        (ITaskMarket.Result memory ra, bytes memory sa,) = FX.resultA0(); market.submitResult(taskId, ra, sa);
        (ITaskMarket.Result memory rb, bytes memory sb,) = FX.resultB0(); market.submitResult(taskId, rb, sb);
        market.settle(taskId);
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , bool exists,) = disp.disputes(taskId); assertTrue(exists && phase == IExecutionDisputes.Phase.Step, "dispute opened from materialized eligibility");
    }
    function test_junk_leaf_wrong_proof_and_wrong_index_rejected() public {
        postRoot();
        (uint64 ij, IPoRWClaimManager.ClaimLeaf memory lj, bytes32[] memory pj) = FX.aggLeafJunk();
        vm.expectRevert(bytes("not bonded")); cm.materializeClaim(mepId, 1, AGG, ij, lj, pj); // included, but its signature resolves to nobody bonded as 0x..ff
        (uint64 ia, IPoRWClaimManager.ClaimLeaf memory la, bytes32[] memory pa) = FX.aggLeafA();
        vm.expectRevert(bytes("not included")); cm.materializeClaim(mepId, 1, AGG, ia + 1, la, pa);
        la.coverageBytes += 4096; vm.expectRevert(bytes("not included")); cm.materializeClaim(mepId, 1, AGG, ia, la, pa);
    }
    function test_materialized_claim_is_auditable_like_a_direct_one() public {
        postRoot();
        (uint64 il, IPoRWClaimManager.ClaimLeaf memory ll, bytes32[] memory pl) = FX.aggLeafL(); bytes32 idL = cm.materializeClaim(mepId, 1, AGG, il, ll, pl);
        uint256 bondedL = inst.bonded(L);
        cm.challengeOpening{value: DEPOSIT}(idL, 7);
        cm.respondOpening(idL, FX.openingFraud());
        assertFalse(cm.hasValidClaim(L, mepId, 1), "the residency liar is caught through the aggregated path too"); assertEq(inst.bonded(L), bondedL - SLASH);
    }
    function test_direct_submit_still_works_alongside() public {
        postRoot(); (IPoRWClaimManager.Claim memory c, bytes memory sig,) = FX.claimA(); cm.submitClaim(c, sig); assertTrue(cm.hasValidClaim(A, mepId, 1));
        (uint64 ia, IPoRWClaimManager.ClaimLeaf memory la, bytes32[] memory pa) = FX.aggLeafA(); vm.expectRevert(bytes("claimed")); cm.materializeClaim(mepId, 1, AGG, ia, la, pa);
    }
}
