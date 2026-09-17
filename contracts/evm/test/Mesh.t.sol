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

/// End-to-end settlement driven by fixtures the browser node produced (web/porw-browser/export_fixtures.mjs):
/// MEP registration, bonding, epoch beacon, signed residency claims, opening challenges (NoFraud / Fraud /
/// timeout), beacon-sortitioned tasks with signed results, and the execution dispute resolved three ways
/// (single-term check, row check, timeout).
contract MeshTest is Test {
    string J;
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId; address A; address B; address L;
    uint64 constant EPOCH_BLOCKS = 100; uint64 constant WINDOW = 10; uint256 constant DEPOSIT = 0.1 ether; uint256 constant SLASH = 0.5 ether; uint64 constant ROUND = 10;

    receive() external payable {}

    function setUp() public {
        J = vm.readFile("test/fixtures/mesh.json");
        verifier = new PorwVerifierKeccak();
        meps = new MEPRegistry();
        inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, EPOCH_BLOCKS, WINDOW, DEPOSIT, SLASH);
        market = new TaskMarket(meps, inst, cm, 50);
        disp = new ExecutionDisputes(meps, inst, market, ROUND, SLASH);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));

        IMEPRegistry.MEP memory m = IMEPRegistry.MEP({
            modelId: vm.parseJsonBytes32(J, ".mep.modelId"), schemeDigest: vm.parseJsonBytes32(J, ".mep.schemeDigest"),
            execKind: vm.parseJsonBytes32(J, ".mep.execKind"), steps: uint32(vm.parseJsonUint(J, ".mep.steps")),
            clampQ16: uint32(vm.parseJsonUint(J, ".mep.clampQ16")), neurons: uint32(vm.parseJsonUint(J, ".mep.neurons")),
            synapses: uint32(vm.parseJsonUint(J, ".mep.synapses")), synapseRoot: vm.parseJsonBytes32(J, ".mep.synapseRoot"), weightsDA: bytes("greenfield://demo")
        });
        mepId = meps.registerMEP(m);
        assertEq(mepId, vm.parseJsonBytes32(J, ".mep.mepId"), "mep id");

        A = vm.parseJsonAddress(J, ".instances.A"); B = vm.parseJsonAddress(J, ".instances.B"); L = vm.parseJsonAddress(J, ".instances.L");
        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        for (uint256 i = 0; i < 3; i++) { address who = i == 0 ? A : i == 1 ? B : L; vm.deal(who, 10 ether); vm.prank(who); inst.bond{value: 2 ether}(ids); }

        // epoch 1 beacon exactly as the fixture derived it
        vm.roll(uint256(vm.parseJsonUint(J, ".params.epochStart"))); vm.difficulty(vm.parseJsonUint(J, ".params.prevrandao"));
        bytes32 beacon = cm.rollEpoch();
        assertEq(beacon, vm.parseJsonBytes32(J, ".params.beacon"), "beacon");
        assertEq(cm.epochChallenge(1, mepId), vm.parseJsonBytes32(J, ".params.challenge"), "challenge");
    }

    // ---- helpers to load fixture pieces ----
    function claimOf(string memory key) internal view returns (IPoRWClaimManager.Claim memory c, bytes memory sig, address signer) {
        c = IPoRWClaimManager.Claim({ mepId: vm.parseJsonBytes32(J, string.concat(key, ".mepId")), partialsRoot: vm.parseJsonBytes32(J, string.concat(key, ".partialsRoot")),
            coverageBytes: uint64(vm.parseJsonUint(J, string.concat(key, ".coverageBytes"))), challenge: vm.parseJsonBytes32(J, string.concat(key, ".challenge")),
            deviceId: vm.parseJsonBytes32(J, string.concat(key, ".deviceId")), execDigest: vm.parseJsonBytes32(J, string.concat(key, ".execDigest")),
            stimulusSeed: uint32(vm.parseJsonUint(J, string.concat(key, ".stimulusSeed"))) });
        sig = vm.parseJsonBytes(J, string.concat(key, ".signature")); signer = vm.parseJsonAddress(J, string.concat(key, ".signer"));
    }
    function openingOf(string memory key) internal view returns (IPoRWClaimManager.Opening memory o) {
        o = IPoRWClaimManager.Opening({ tileIdx: uint64(vm.parseJsonUint(J, string.concat(key, ".tileIdx"))), tile: vm.parseJsonBytes(J, string.concat(key, ".tile")),
            sTile: uint32(vm.parseJsonUint(J, string.concat(key, ".sTile"))), partialsIndex: uint64(vm.parseJsonUint(J, string.concat(key, ".partialsIndex"))),
            partialsProof: vm.parseJsonBytes32Array(J, string.concat(key, ".partialsProof")), weightsProof: vm.parseJsonBytes32Array(J, string.concat(key, ".weightsProof")) });
    }
    function resultOf(string memory key) internal view returns (ITaskMarket.Result memory r, bytes memory sig) {
        r = ITaskMarket.Result({ execDigest: vm.parseJsonBytes32(J, string.concat(key, ".execDigest")), execRoot: vm.parseJsonBytes32(J, string.concat(key, ".execRoot")) });
        sig = vm.parseJsonBytes(J, string.concat(key, ".signature"));
    }
    function submitAll() internal returns (bytes32 idA, bytes32 idB, bytes32 idL) {
        (IPoRWClaimManager.Claim memory ca, bytes memory sa,) = claimOf(".claimA"); idA = cm.submitClaim(ca, sa);
        (IPoRWClaimManager.Claim memory cb, bytes memory sb,) = claimOf(".claimB"); idB = cm.submitClaim(cb, sb);
        (IPoRWClaimManager.Claim memory cl, bytes memory sl,) = claimOf(".claimL"); idL = cm.submitClaim(cl, sl);
    }

    // ---- residency claims and opening challenges ----
    function test_claims_and_openings() public {
        (bytes32 idA,, bytes32 idL) = submitAll();
        assertTrue(cm.hasValidClaim(A, mepId, 1) && cm.hasValidClaim(L, mepId, 1));

        // honest opening -> NoFraud, deposit goes to the instance
        uint256 balA = A.balance;
        cm.challengeOpening{value: DEPOSIT}(idA, 3);
        cm.respondOpening(idA, openingOf(".openingNoFraud"));
        assertEq(A.balance, balA + DEPOSIT, "NoFraud pays the instance");
        assertTrue(cm.hasValidClaim(A, mepId, 1));

        // the residency liar: its honest tile passes, its lied tile is Fraud -> slashed, claim invalid
        cm.challengeOpening{value: DEPOSIT}(idL, 3);
        cm.respondOpening(idL, openingOf(".openingHonestOfLiar"));
        assertTrue(cm.hasValidClaim(L, mepId, 1));
        uint256 bondedL = inst.bonded(L); uint256 me = address(this).balance;
        cm.challengeOpening{value: DEPOSIT}(idL, 7);
        cm.respondOpening(idL, openingOf(".openingFraud"));
        assertFalse(cm.hasValidClaim(L, mepId, 1), "fraud invalidates the claim");
        assertEq(inst.bonded(L), bondedL - SLASH, "slashed");
        assertEq(address(this).balance, me + SLASH, "challenger paid slash + refund");

        // a wrong-proof opening is Invalid and reverts (the instance may retry before the deadline)
        cm.challengeOpening{value: DEPOSIT}(idA, 5);
        IPoRWClaimManager.Opening memory bad = openingOf(".openingNoFraud"); bad.tileIdx = 5;
        vm.expectRevert(bytes("invalid opening"));
        cm.respondOpening(idA, bad);
        // ... and expires into a fraud verdict
        vm.roll(block.number + WINDOW + 1);
        uint256 bondedA = inst.bonded(A);
        cm.claimExpiredChallenge(idA, 5);
        assertEq(inst.bonded(A), bondedA - SLASH, "timeout slashes");
        assertFalse(cm.hasValidClaim(A, mepId, 1));
    }

    function test_claim_rejects_wrong_challenge_or_unbonded() public {
        (IPoRWClaimManager.Claim memory c, bytes memory sig,) = claimOf(".claimA");
        c.challenge = keccak256("other"); vm.expectRevert(bytes("challenge")); cm.submitClaim(c, sig);
        (c, sig,) = claimOf(".claimA"); sig[10] ^= 0x01; vm.expectRevert(bytes("not bonded")); cm.submitClaim(c, sig);
    }

    // ---- tasks: sortition, results, settlement into a dispute ----
    function postAndSubmit(uint256 k) internal returns (bytes32 taskId) {
        submitAll();
        // epoch 2: eligibility uses the epoch-1 claims (A and B valid; L has no valid claim after fraud below? here L is valid but we don't use it)
        vm.roll(2 * EPOCH_BLOCKS); vm.difficulty(7); cm.rollEpoch();
        ITaskMarket.Task memory t = ITaskMarket.Task({ mepId: mepId, stimulusSeed: uint32(vm.parseJsonUint(J, ".params.stimulusSeed")), inputCommit: bytes32(0), fee: 1 ether, deadline: uint64(block.number + 50), redundancy: 2 });
        bytes32[] memory nonces = vm.parseJsonBytes32Array(J, ".params.nonces");
        taskId = market.postTask{value: 1 ether}(t, nonces[k]);
        bytes32[] memory ids = vm.parseJsonBytes32Array(J, ".params.taskIds");
        assertEq(taskId, ids[k], "task id");
        address[] memory ex = market.executors(taskId);
        assertEq(ex.length, 2, "two executors"); assertTrue((ex[0] == A && ex[1] == B) || (ex[0] == B && ex[1] == A), "sortition picks the eligible pair");
        (ITaskMarket.Result memory ra, bytes memory sa) = resultOf(string.concat(".resultsA[", vm.toString(k), "]")); market.submitResult(taskId, ra, sa);
        (ITaskMarket.Result memory rb, bytes memory sb) = resultOf(string.concat(".resultsB[", vm.toString(k), "]")); market.submitResult(taskId, rb, sb);
        market.settle(taskId); // A and B disagree -> dispute
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , bool exists,) = disp.disputes(taskId);
        assertTrue(exists && phase == IExecutionDisputes.Phase.Step, "dispute opened");
    }

    function runToRow(bytes32 taskId) internal {
        vm.prank(A); disp.revealRoots(taskId, vm.parseJsonBytes32Array(J, ".dispute.actRootsA"));
        vm.prank(B); disp.revealRoots(taskId, vm.parseJsonBytes32Array(J, ".dispute.actRootsB"));
        (, , , , , , , uint32 step, , , , , , ,) = disp.disputes(taskId);
        assertEq(step, uint32(vm.parseJsonUint(J, ".dispute.sStar")), "first differing step");
        bytes32[] memory pa = vm.parseJsonBytes32Array(J, ".dispute.pairsAFlat"); bytes32[] memory pb = vm.parseJsonBytes32Array(J, ".dispute.pairsBFlat");
        uint256 rounds = vm.parseJsonUint(J, ".dispute.rounds");
        for (uint256 i = 0; i < rounds; i++) { vm.prank(A); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]); vm.prank(B); disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]); }
        (, , , , , , IExecutionDisputes.Phase phase, , , , , uint32 neuron, , ,) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Synapse, "row phase"); assertEq(neuron, uint32(vm.parseJsonUint(J, ".dispute.neuron")), "bisection reaches the lied neuron");
    }

    function u64s(uint256[] memory a) internal pure returns (uint64[] memory o) { o = new uint64[](a.length); for (uint256 i = 0; i < a.length; i++) o[i] = uint64(a[i]); }
    function bounds() internal view returns (IExecutionDisputes.RowBounds memory b) {
        b = IExecutionDisputes.RowBounds({ start: uint32(vm.parseJsonUint(J, ".dispute.rowStart.value")), startProof: vm.parseJsonBytes32Array(J, ".dispute.rowStart.proof"),
            end: uint32(vm.parseJsonUint(J, ".dispute.rowEnd.value")), endProof: vm.parseJsonBytes32Array(J, ".dispute.rowEnd.proof") });
    }
    function chunk() internal view returns (IExecutionDisputes.ChunkOpening memory c) {
        c = IExecutionDisputes.ChunkOpening({ c: uint32(vm.parseJsonUint(J, ".dispute.chunk.c")), records: vm.parseJsonBytes(J, ".dispute.chunk.records"), proof: vm.parseJsonBytes32Array(J, ".dispute.chunk.proof") });
    }

    function test_dispute_resolved_at_the_single_term() public {
        bytes32 taskId = postAndSubmit(0); runToRow(taskId);
        vm.prank(A); disp.postRow(taskId, uint32(vm.parseJsonUint(J, ".dispute.actA")), u64s(vm.parseJsonUintArray(J, ".dispute.sumsA")));
        vm.prank(B); disp.postRow(taskId, uint32(vm.parseJsonUint(J, ".dispute.actB")), u64s(vm.parseJsonUintArray(J, ".dispute.sumsBLied")));
        uint256 bondedB = inst.bonded(B); uint256 balA = A.balance;
        disp.proveSynapseTerm(taskId, uint32(vm.parseJsonUint(J, ".dispute.kStar")), vm.parseJsonBytes32(J, ".mep.csrRoot"), vm.parseJsonBytes32(J, ".mep.rowRoot"), bounds(), chunk(),
            uint32(vm.parseJsonUint(J, ".dispute.actPre")), vm.parseJsonBytes32Array(J, ".dispute.actPreProof"));
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B, "B loses at the divergent term");
        assertEq(inst.bonded(B), bondedB - SLASH, "B slashed");
        assertEq(A.balance, balA + SLASH + 1 ether, "A gets the slash and the whole fee");
    }

    function test_dispute_resolved_by_row_check() public {
        bytes32 taskId = postAndSubmit(1); runToRow(taskId);
        vm.prank(A); disp.postRow(taskId, uint32(vm.parseJsonUint(J, ".dispute.actA")), u64s(vm.parseJsonUintArray(J, ".dispute.sumsA")));
        // B posts its HONEST sums, which contradict its lied (leaf-bound) activation
        vm.prank(B); disp.postRow(taskId, uint32(vm.parseJsonUint(J, ".dispute.actB")), u64s(vm.parseJsonUintArray(J, ".dispute.sumsBHonest")));
        disp.proveSynapseTerm(taskId, uint32(vm.parseJsonUint(J, ".dispute.kStar")), vm.parseJsonBytes32(J, ".mep.csrRoot"), vm.parseJsonBytes32(J, ".mep.rowRoot"), bounds(), chunk(),
            uint32(vm.parseJsonUint(J, ".dispute.actPre")), vm.parseJsonBytes32Array(J, ".dispute.actPreProof"));
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B, "B loses the row check");
    }

    function test_dispute_timeout_blames_the_silent_party() public {
        bytes32 taskId = postAndSubmit(2);
        vm.prank(A); disp.revealRoots(taskId, vm.parseJsonBytes32Array(J, ".dispute.actRootsA"));
        vm.expectRevert(bytes("not expired")); disp.timeout(taskId);
        vm.roll(block.number + ROUND + 1);
        uint256 bondedB = inst.bonded(B);
        disp.timeout(taskId);
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B && inst.bonded(B) == bondedB - SLASH, "silent B loses");
    }

    function test_children_must_hash_to_the_current_node() public {
        bytes32 taskId = postAndSubmit(0);
        vm.prank(A); disp.revealRoots(taskId, vm.parseJsonBytes32Array(J, ".dispute.actRootsA"));
        vm.prank(B); disp.revealRoots(taskId, vm.parseJsonBytes32Array(J, ".dispute.actRootsB"));
        vm.prank(A); vm.expectRevert(bytes("not children")); disp.postChildren(taskId, bytes32(uint256(1)), bytes32(uint256(2)));
    }
}
