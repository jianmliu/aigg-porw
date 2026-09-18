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

/// End-to-end settlement driven by fixtures the browser node produced (web/porw-browser/export_fixtures.mjs
/// -> test/fixtures/MeshFixtures.sol): MEP registration, bonding, epoch beacon, EIP-712 residency claims
/// signed by delegated session keys (the tab's key; the wallet signed one Delegation), opening challenges
/// (NoFraud / Fraud / Invalid / timeout), beacon-sortitioned tasks with typed-data results, and the
/// execution dispute resolved three ways (single-term check, row check, timeout). Contracts are deployed
/// at the fixed addresses the fixtures' EIP-712 domains name (deployCodeTo), chain id 31337.
contract MeshTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId; address A = FX.A; address B = FX.B; address L = FX.L;
    uint64 constant WINDOW = 10; uint256 constant DEPOSIT = 0.1 ether; uint256 constant SLASH = 0.5 ether; uint64 constant ROUND = 10;

    receive() external payable {}

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak();
        meps = new MEPRegistry();
        deployCodeTo("InstanceRegistry.sol:InstanceRegistry", abi.encode(uint256(1 ether), uint64(20)), FX.REGISTRY); inst = InstanceRegistry(FX.REGISTRY);
        deployCodeTo("PoRWClaimManager.sol:PoRWClaimManager", abi.encode(meps, inst, verifier, FX.EPOCH_BLOCKS, WINDOW, DEPOSIT, SLASH, address(0)), FX.CLAIM_MANAGER); cm = PoRWClaimManager(FX.CLAIM_MANAGER);
        deployCodeTo("TaskMarket.sol:TaskMarket", abi.encode(meps, inst, cm, uint64(50)), FX.MARKET); market = TaskMarket(payable(FX.MARKET));
        disp = new ExecutionDisputes(meps, inst, market, ROUND, SLASH);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));

        mepId = meps.registerMEP(IMEPRegistry.MEP({
            modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND,
            neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo")
        }));
        assertEq(mepId, FX.MEP_ID, "mep id");

        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        for (uint256 i = 0; i < 3; i++) { address who = i == 0 ? A : i == 1 ? B : L; vm.deal(who, 10 ether); vm.prank(who); inst.bond{value: 2 ether}(ids); }
        // each wallet delegated its tab's session key once (EIP-712 Delegation, submitted by anyone)
        (address ia, address sa, uint64 ea, bytes memory ga) = FX.delegationA(); inst.delegateBySig(ia, sa, ea, ga);
        (address ib, address sb, uint64 eb, bytes memory gb) = FX.delegationB(); inst.delegateBySig(ib, sb, eb, gb);
        (address il, address sl, uint64 el, bytes memory gl) = FX.delegationL(); inst.delegateBySig(il, sl, el, gl);
        assertEq(inst.resolve(FX.SESSION_A), A, "session A -> wallet A"); assertEq(inst.resolve(A), A, "a wallet resolves to itself"); assertEq(inst.resolve(address(0xdead)), address(0));

        // epoch 1 beacon exactly as the fixture derived it
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO);
        assertEq(cm.rollEpoch(), FX.BEACON, "beacon");
        assertEq(cm.epochChallenge(1, mepId), FX.CHALLENGE, "challenge");
    }

    function submitAll() internal returns (bytes32 idA, bytes32 idB, bytes32 idL) {
        (IPoRWClaimManager.Claim memory ca, bytes memory sa,) = FX.claimA(); idA = cm.submitClaim(ca, sa);
        (IPoRWClaimManager.Claim memory cb, bytes memory sb,) = FX.claimB(); idB = cm.submitClaim(cb, sb);
        (IPoRWClaimManager.Claim memory cl, bytes memory sl,) = FX.claimL(); idL = cm.submitClaim(cl, sl);
    }

    // ---- residency claims and opening challenges ----
    function test_claims_and_openings() public {
        (bytes32 idA,, bytes32 idL) = submitAll();
        assertTrue(cm.hasValidClaim(A, mepId, 1) && cm.hasValidClaim(L, mepId, 1));

        uint256 balA = A.balance;
        cm.challengeOpening{value: DEPOSIT}(idA, 3);
        cm.respondOpening(idA, FX.openingNoFraud());
        assertEq(A.balance, balA + DEPOSIT, "NoFraud pays the instance");
        assertTrue(cm.hasValidClaim(A, mepId, 1));

        // the residency liar: its honest tile passes, its lied tile is Fraud -> slashed, claim invalid
        cm.challengeOpening{value: DEPOSIT}(idL, 3);
        cm.respondOpening(idL, FX.openingHonestOfLiar());
        assertTrue(cm.hasValidClaim(L, mepId, 1));
        uint256 bondedL = inst.bonded(L); uint256 me = address(this).balance;
        cm.challengeOpening{value: DEPOSIT}(idL, 7);
        cm.respondOpening(idL, FX.openingFraud());
        assertFalse(cm.hasValidClaim(L, mepId, 1), "fraud invalidates the claim");
        assertEq(inst.bonded(L), bondedL - SLASH, "slashed");
        assertEq(address(this).balance, me + SLASH, "challenger paid slash + refund");

        // a wrong-proof opening is Invalid and reverts (the instance may retry before the deadline)
        cm.challengeOpening{value: DEPOSIT}(idA, 5);
        IPoRWClaimManager.Opening memory bad = FX.openingNoFraud(); bad.tileIdx = 5;
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
        (IPoRWClaimManager.Claim memory c, bytes memory sig,) = FX.claimA();
        c.challenge = keccak256("other"); vm.expectRevert(bytes("challenge")); cm.submitClaim(c, sig);
        (c, sig,) = FX.claimA(); sig[10] ^= 0x01; vm.expectRevert(bytes("not bonded")); cm.submitClaim(c, sig);
    }
    function test_claim_is_eip712_typed_data_by_the_session_key_stored_under_the_wallet() public {
        (IPoRWClaimManager.Claim memory c, bytes memory sig, address signer) = FX.claimA();
        assertEq(cm.claimDigest(c), FX.CLAIM_DIGEST_A, "digest == the node's EIP-712 digest");
        assertEq(signer, FX.SESSION_A, "signed by the tab's session key");
        bytes32 id = cm.submitClaim(c, sig);
        assertEq(id, cm.claimIdOf(A, mepId, 1), "claim keyed by the bonded wallet, not the session key");
        // a revoked delegation no longer carries claims
        vm.roll(block.number + 1); vm.prank(A); inst.revokeSessionKey(FX.SESSION_A);
        (IPoRWClaimManager.Claim memory c2, bytes memory s2,) = FX.claimA(); vm.expectRevert(bytes("not bonded")); cm.submitClaim(c2, s2);
    }
    function test_delegation_rules() public {
        (address ia, address sa, uint64 ea, bytes memory ga) = FX.delegationA();
        vm.expectRevert(bytes("taken")); vm.prank(B); inst.setSessionKey(sa, ea);              // B cannot claim A's session key
        vm.expectRevert(bytes("delegation sig")); inst.delegateBySig(B, sa, ea, ga);           // A's signature does not bind B
        vm.expectRevert(bytes("session")); vm.prank(A); inst.setSessionKey(B, ea);             // a bonded wallet cannot be someone's session key
        vm.expectRevert(bytes("expired")); vm.prank(A); inst.setSessionKey(address(0x77), uint64(block.number));
        vm.prank(A); inst.setSessionKey(address(0x77), uint64(block.number + 5)); assertEq(inst.resolve(address(0x77)), A);
        vm.roll(block.number + 6); assertEq(inst.resolve(address(0x77)), address(0), "expired session resolves to nobody");
        ia; // silence
    }

    // ---- tasks: sortition, results, settlement into a dispute ----
    function result(uint256 k, bool ofA) internal pure returns (ITaskMarket.Result memory r, bytes memory sig) {
        if (ofA) { if (k == 0) (r, sig,) = FX.resultA0(); else if (k == 1) (r, sig,) = FX.resultA1(); else (r, sig,) = FX.resultA2(); }
        else     { if (k == 0) (r, sig,) = FX.resultB0(); else if (k == 1) (r, sig,) = FX.resultB1(); else (r, sig,) = FX.resultB2(); }
    }
    function postAndSubmit(uint256 k) internal returns (bytes32 taskId) {
        submitAll();
        // epoch 2: eligibility uses the epoch-1 claims (A and B valid)
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
        ITaskMarket.Task memory t = FX.task(); // the id binds every field, so the test posts exactly the task the fixture signed
        taskId = market.postTask{value: FX.TASK_FEE}(t, FX.nonces()[k]);
        assertEq(taskId, FX.taskIds()[k], "task id");
        address[] memory ex = market.executors(taskId);
        assertEq(ex.length, 2, "two executors"); assertTrue((ex[0] == A && ex[1] == B) || (ex[0] == B && ex[1] == A), "sortition picks the eligible pair");
        (ITaskMarket.Result memory ra, bytes memory sa) = result(k, true); market.submitResult(taskId, ra, sa);
        (ITaskMarket.Result memory rb, bytes memory sb) = result(k, false); market.submitResult(taskId, rb, sb);
        market.settle(taskId); // A and B disagree -> dispute
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , bool exists,) = disp.disputes(taskId);
        assertTrue(exists && phase == IExecutionDisputes.Phase.Step, "dispute opened");
    }

    function runToRow(bytes32 taskId) internal {
        vm.prank(A); disp.revealRoots(taskId, FX.actRootsA());
        vm.prank(B); disp.revealRoots(taskId, FX.actRootsB());
        (, , , , , , , uint32 step, , , , , , ,) = disp.disputes(taskId);
        assertEq(step, FX.S_STAR, "first differing step");
        bytes32[] memory pa = FX.pairsAFlat(); bytes32[] memory pb = FX.pairsBFlat();
        for (uint256 i = 0; i < FX.ROUNDS; i++) { vm.prank(A); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]); vm.prank(B); disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]); }
        (, , , , , , IExecutionDisputes.Phase phase, , , , , uint32 neuron, , ,) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Synapse, "row phase"); assertEq(neuron, FX.NEURON, "bisection reaches the lied neuron");
    }
    function bounds() internal pure returns (IExecutionDisputes.RowBounds memory b) {
        b = IExecutionDisputes.RowBounds({ start: FX.ROW_START, startProof: FX.rowStartProof(), end: FX.ROW_END, endProof: FX.rowEndProof() });
    }
    function chunk() internal pure returns (IExecutionDisputes.ChunkOpening memory c) {
        c = IExecutionDisputes.ChunkOpening({ c: FX.CHUNK_C, records: FX.chunkRecords(), proof: FX.chunkProof() });
    }

    function test_dispute_resolved_at_the_single_term() public {
        bytes32 taskId = postAndSubmit(0); runToRow(taskId);
        vm.prank(A); disp.postRow(taskId, FX.ACT_A, FX.sumsA());
        vm.prank(B); disp.postRow(taskId, FX.ACT_B, FX.sumsBLied());
        uint256 bondedB = inst.bonded(B); uint256 balA = A.balance;
        disp.proveSynapseTerm(taskId, FX.K_STAR, FX.CSR_ROOT, FX.ROW_ROOT, bounds(), chunk(), FX.ACT_PRE, FX.actPreProof());
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B, "B loses at the divergent term");
        assertEq(inst.bonded(B), bondedB - SLASH, "B slashed");
        assertEq(A.balance, balA + SLASH + 1 ether, "A gets the slash and the whole fee");
    }

    function test_dispute_resolved_by_row_check() public {
        bytes32 taskId = postAndSubmit(1); runToRow(taskId);
        vm.prank(A); disp.postRow(taskId, FX.ACT_A, FX.sumsA());
        // B posts its HONEST sums, which contradict its lied (leaf-bound) activation
        vm.prank(B); disp.postRow(taskId, FX.ACT_B, FX.sumsBHonest());
        disp.proveSynapseTerm(taskId, FX.K_STAR, FX.CSR_ROOT, FX.ROW_ROOT, bounds(), chunk(), FX.ACT_PRE, FX.actPreProof());
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B, "B loses the row check");
    }

    function test_dispute_timeout_blames_the_silent_party() public {
        bytes32 taskId = postAndSubmit(2);
        vm.prank(A); disp.revealRoots(taskId, FX.actRootsA());
        vm.expectRevert(bytes("not expired")); disp.timeout(taskId);
        vm.roll(block.number + ROUND + 1);
        uint256 bondedB = inst.bonded(B);
        disp.timeout(taskId);
        (, , , , , , IExecutionDisputes.Phase phase, , , , , , , , address loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == B && inst.bonded(B) == bondedB - SLASH, "silent B loses");
    }

    function test_children_must_hash_to_the_current_node() public {
        bytes32 taskId = postAndSubmit(0);
        vm.prank(A); disp.revealRoots(taskId, FX.actRootsA());
        vm.prank(B); disp.revealRoots(taskId, FX.actRootsB());
        vm.prank(A); vm.expectRevert(bytes("not children")); disp.postChildren(taskId, bytes32(uint256(1)), bytes32(uint256(2)));
    }
    function test_dispute_moves_through_the_delegated_session_key() public {
        bytes32 taskId = postAndSubmit(0);
        vm.prank(FX.SESSION_A); disp.revealRoots(taskId, FX.actRootsA()); // the tab acts for wallet A
        vm.prank(address(0xbad)); vm.expectRevert(bytes("party")); disp.revealRoots(taskId, FX.actRootsB());
        vm.prank(FX.SESSION_B); disp.revealRoots(taskId, FX.actRootsB());
        (, , , , , , , uint32 step, , , , , , ,) = disp.disputes(taskId); assertEq(step, FX.S_STAR);
    }
}
