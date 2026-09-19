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
import "../src/mesh/LifRowCheck.sol";
import { LifMeshFixtures as FX } from "./fixtures/LifMeshFixtures.sol";

/// The execution dispute dispatched on the int-lif execution kind, driven by fixtures from real node runs
/// (web/porw-browser/export_lif_fixtures.mjs): segment roots -> Refine (per-step roots of the first differing
/// segment) -> state-tree bisection -> LIF row check -> one signed synapse term. Two liars: one lies in the
/// state (row check), one in the input sum (single term); plus a Refine-phase timeout.
contract MeshLifTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId; address A = FX.A; address B = FX.B;
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
        assertEq(FX.EXEC_KIND, LifRowCheck.execKind(), "the node's exec kind digest == the contract's");
        mepId = meps.registerMEP(IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND,
            neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://flywire") }));
        assertEq(mepId, FX.MEP_ID, "mep id (no run parameters in it)");
        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        vm.deal(A, 10 ether); vm.prank(A); inst.bond{value: 2 ether}(ids);
        vm.deal(B, 10 ether); vm.prank(B); inst.bond{value: 2 ether}(ids);
        { (address i1, address s1, uint64 e1, bytes memory g1) = FX.delegationA(); inst.delegateBySig(i1, s1, e1, g1); }
        { (address i2, address s2, uint64 e2, bytes memory g2) = FX.delegationB(); inst.delegateBySig(i2, s2, e2, g2); }
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO);
        assertEq(cm.rollEpoch(), FX.BEACON, "beacon");
        (IPoRWClaimManager.Claim memory ca, bytes memory sa) = FX.claimA(); cm.submitClaim(ca, sa);
        (IPoRWClaimManager.Claim memory cb, bytes memory sb) = FX.claimB(); cm.submitClaim(cb, sb);
        assertTrue(cm.hasValidClaim(A, mepId, 1) && cm.hasValidClaim(B, mepId, 1), "LIF residency claims accepted");
    }

    function result(uint256 k, bool ofA) internal pure returns (ITaskMarket.Result memory r, bytes memory sig) {
        if (ofA) { if (k == 0) (r, sig) = FX.resultA0(); else if (k == 1) (r, sig) = FX.resultA1(); else (r, sig) = FX.resultA2(); }
        else     { if (k == 0) (r, sig) = FX.resultB0(); else if (k == 1) (r, sig) = FX.resultB1(); else (r, sig) = FX.resultB2(); }
    }
    /// task k: the stimulus set's initStateRoot; A and B disagree -> dispute (LIF mode)
    function postAndSubmit(uint256 k) internal returns (bytes32 taskId) {
        vm.roll(2 * FX.EPOCH_BLOCKS); vm.difficulty(7); cm.rollEpoch();
        ITaskMarket.Task memory t = FX.task(); // steps and stride ride on the task now, and the id binds them
        taskId = market.postTask{value: FX.TASK_FEE}(t, FX.nonces()[k]);
        assertEq(taskId, FX.taskIds()[k], "task id");
        (ITaskMarket.Result memory ra, bytes memory sa) = result(k, true); market.submitResult(taskId, ra, sa);
        (ITaskMarket.Result memory rb, bytes memory sb) = result(k, false); market.submitResult(taskId, rb, sb);
        market.settle(taskId);
        (bool lif, uint32 stride, uint32 segments,, bytes32 init,) = disp.lifs(taskId);
        assertTrue(lif && stride == FX.STRIDE && segments == (FX.STEPS + FX.STRIDE - 1) / FX.STRIDE && init == FX.INIT_STATE_ROOT, "dispatched on the LIF exec kind");
    }
    function phaseOf(bytes32 taskId) internal view returns (IExecutionDisputes.Phase p, uint32 step, bytes32 prevRoot, uint32 neuron, address loser) {
        (, , , , , , p, step, prevRoot, , , neuron, , , loser) = disp.disputes(taskId);
    }
    /// Step (segment roots) -> Refine (per-step roots) -> Neuron bisection -> Synapse (row) phase
    function runToRow(bytes32 taskId, bool inputLiar) internal returns (uint256 gasRefine, uint256 gasChildren) {
        vm.prank(A); disp.revealRoots(taskId, FX.segRootsA());
        vm.prank(B); disp.revealRoots(taskId, inputLiar ? FX.segRootsB2() : FX.segRootsB1());
        (IExecutionDisputes.Phase p,, bytes32 prev,,) = phaseOf(taskId);
        (, , , uint32 seg,,) = disp.lifs(taskId);
        assertTrue(p == IExecutionDisputes.Phase.Refine && seg == FX.SEG_STAR && prev == FX.segRootsA()[FX.SEG_STAR - 1], "first differing segment; previous segment root agreed");
        uint256 g0 = gasleft(); vm.prank(A); disp.postStepRoots(taskId, FX.stepRootsA()); gasRefine = g0 - gasleft();
        vm.prank(B); disp.postStepRoots(taskId, inputLiar ? FX.stepRootsB2() : FX.stepRootsB1());
        uint32 step; (p, step, prev,,) = phaseOf(taskId);
        assertTrue(p == IExecutionDisputes.Phase.Neuron && step == FX.S_STAR && prev == FX.PREV_ROOT, "refined to the first differing step; agreed previous-step root");
        bytes32[] memory pa = inputLiar ? FX.pairsA2Flat() : FX.pairsA1Flat(); bytes32[] memory pb = inputLiar ? FX.pairsB2Flat() : FX.pairsB1Flat();
        for (uint256 i = 0; i < FX.ROUNDS; i++) { uint256 g1 = gasleft(); vm.prank(A); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]); if (i == 0) gasChildren = g1 - gasleft(); vm.prank(B); disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]); }
        uint32 neuron; (p,,, neuron,) = phaseOf(taskId);
        assertTrue(p == IExecutionDisputes.Phase.Synapse && neuron == FX.NEURON, "state-tree bisection reaches the lied neuron");
    }
    function proof() internal pure returns (IExecutionDisputes.LifTermProof memory pf) {
        pf = IExecutionDisputes.LifTermProof({ kStar: FX.K_STAR, csrRoot: FX.CSR_ROOT, rowRoot: FX.ROW_ROOT,
            bounds: IExecutionDisputes.RowBounds({ start: FX.ROW_START, startProof: FX.rowStartProof(), end: FX.ROW_END, endProof: FX.rowEndProof() }),
            chunk: IExecutionDisputes.ChunkOpening({ c: FX.CHUNK_C, records: FX.chunkRecords(), proof: FX.chunkProof() }), self: FX.selfOpening(), pre: FX.preOpening() });
    }
    function postRow(address who, LifRowCheck.State memory s, int64[] memory sums) internal returns (uint256 gas) {
        uint256 g0 = gasleft(); vm.prank(who); disp.postRowLif(who == A ? taskIdCur : taskIdCur, s.v, s.g, s.refr, s.flags, s.count, sums); gas = g0 - gasleft();
    }
    bytes32 taskIdCur;

    function test_lif_dispute_resolved_at_the_single_signed_term() public {
        taskIdCur = postAndSubmit(0); (uint256 gRef, uint256 gCh) = runToRow(taskIdCur, true);
        uint256 gRow = postRow(A, FX.stateA(), FX.sumsA());
        postRow(B, FX.stateB2(), FX.sumsB2Lied()); // consistent liar: its committed state follows from its lied sums (row check passes)
        uint256 bondedB = inst.bonded(B); uint256 balA = A.balance;
        uint256 g0 = gasleft(); disp.proveSynapseTermLif(taskIdCur, proof()); uint256 gTerm = g0 - gasleft();
        (IExecutionDisputes.Phase p,,,, address loser) = phaseOf(taskIdCur);
        assertTrue(p == IExecutionDisputes.Phase.Resolved && loser == B, "B loses at the divergent signed term (w = -59 x spiked pre)");
        assertEq(inst.bonded(B), bondedB - SLASH, "B slashed"); assertEq(A.balance, balA + SLASH + 1 ether, "A paid slash + fee");
        emit log_named_uint("gas postStepRoots", gRef); emit log_named_uint("gas postChildren", gCh); emit log_named_uint("gas postRowLif", gRow); emit log_named_uint("gas proveSynapseTermLif", gTerm);
    }
    function test_lif_dispute_resolved_by_the_row_check() public {
        taskIdCur = postAndSubmit(1); runToRow(taskIdCur, false);
        postRow(A, FX.stateA(), FX.sumsA());
        postRow(B, FX.stateB1(), FX.sumsB1Honest()); // lied (leaf-bound) state, honest sums: transition(prev, I) != claimed
        disp.proveSynapseTermLif(taskIdCur, proof());
        (IExecutionDisputes.Phase p,,,, address loser) = phaseOf(taskIdCur);
        assertTrue(p == IExecutionDisputes.Phase.Resolved && loser == B, "B loses the LIF row check");
    }
    function test_lif_refine_chain_must_end_at_the_committed_segment_root() public {
        taskIdCur = postAndSubmit(1);
        vm.prank(A); disp.revealRoots(taskIdCur, FX.segRootsA()); vm.prank(B); disp.revealRoots(taskIdCur, FX.segRootsB1());
        vm.prank(B); vm.expectRevert(bytes("unbound chain")); disp.postStepRoots(taskIdCur, FX.stepRootsA()); // B cannot borrow A's chain
        bytes32[] memory short = new bytes32[](FX.STRIDE - 1); vm.prank(B); vm.expectRevert(bytes("unbound chain")); disp.postStepRoots(taskIdCur, short);
    }
    function test_lif_timeout_in_refine_blames_the_silent_party() public {
        taskIdCur = postAndSubmit(2);
        vm.prank(A); disp.revealRoots(taskIdCur, FX.segRootsA()); vm.prank(B); disp.revealRoots(taskIdCur, FX.segRootsB1());
        vm.prank(A); disp.postStepRoots(taskIdCur, FX.stepRootsA());
        vm.expectRevert(bytes("not expired")); disp.timeout(taskIdCur);
        vm.roll(block.number + ROUND + 1); uint256 bondedB = inst.bonded(B);
        disp.timeout(taskIdCur);
        (IExecutionDisputes.Phase p,,,, address loser) = phaseOf(taskIdCur);
        assertTrue(p == IExecutionDisputes.Phase.Resolved && loser == B && inst.bonded(B) == bondedB - SLASH, "silent B loses in Refine");
    }
    function test_lif_spmv_row_functions_rejected_in_lif_mode() public {
        taskIdCur = postAndSubmit(0); runToRow(taskIdCur, true);
        uint64[] memory u = new uint64[](0); vm.prank(A); vm.expectRevert(bytes("phase")); disp.postRow(taskIdCur, 0, u);
        vm.prank(A); vm.expectRevert(bytes("leaf")); disp.postRowLif(taskIdCur, 1, 2, 3, 4, 5, new int64[](0)); // a state not bound to A's leaf
    }
}
