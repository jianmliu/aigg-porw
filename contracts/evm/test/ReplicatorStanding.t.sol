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

/// Standing for a replicator: `TaskMarket.challengeResult` lets somebody who was never sortitioned put up a
/// deposit and a disagreeing result against a SETTLED task, and play the same bisection the two executors would
/// have run. One honest outsider is then enough, which is the property a fraud proof is meant to have.
///
/// Two things about how this test is built, because the fixtures constrain it:
///
///  - In `MeshFixtures` **B is the liar** and every result is pre-signed by A's or B's session key, so two
///    fixture executors can never be made to *agree* -- `settle` always opens a dispute instead of settling,
///    and there would be no settled task to challenge. So the executors here are two instances whose keys this
///    test holds (`vm.sign`), and they assert B's wrong `execRoot` as their own. They agree, the task settles,
///    and the challenger brings A's honest root. Contracts are deployed normally rather than at the fixtures'
///    addresses: the bisection data does not depend on an address, and every signature here is made at runtime.
///  - Most of the accounting needs no bisection at all. A challenge opens the dispute in `Phase.Step`, and
///    `timeout` already resolves against whichever party failed to post -- so revealing for one side and
///    letting the other go quiet exercises slash, deposit and `repudiated` in both directions.
/// Not covered here, deliberately: the `challengeWindow == 0` disabled-feature guard (it needs a second market
/// left unwired), and the `withdrawable` fallback in `_send` (it needs a recipient that rejects ether). Both are
/// there so that a refusing recipient cannot leave a dispute permanently unresolvable.
///
/// One environment assumption: `vm.sign` must return low-s signatures, because `PorwEIP712.recover` rejects
/// high-s. If a claim or result here recovers to address(0), that is the first thing to check.
contract ReplicatorStandingTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId;
    uint64 constant WINDOW = 10; uint256 constant DEPOSIT = 0.1 ether; uint256 constant SLASH = 0.5 ether; uint64 constant ROUND = 10;
    uint256 constant CHAL_DEPOSIT = 0.05 ether; uint64 constant CHAL_WINDOW = 15;

    uint256 constant PK1 = uint256(0xE1); uint256 constant PK2 = uint256(0xE2);
    address E1; address E2;
    address constant SINK = address(0x51AC); // where half of a lost challenge's deposit goes
    address constant CHAL = address(0xC0FFEE); // the replicator: no bond, no session key, never sortitioned

    receive() external payable {}

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak();
        meps = new MEPRegistry();
        inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, FX.EPOCH_BLOCKS, WINDOW, DEPOSIT, SLASH, IBeacon(address(0)));
        market = new TaskMarket(meps, inst, cm, uint64(50));
        disp = new ExecutionDisputes(meps, inst, market, ROUND, SLASH);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));
        market.setChallengeParams(CHAL_DEPOSIT, CHAL_WINDOW, SINK);

        mepId = meps.registerMEP(IMEPRegistry.MEP({
            modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND,
            neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo")
        }));
        assertEq(mepId, FX.MEP_ID, "the mep id hashes the registry fields, not the registry");

        E1 = vm.addr(PK1); E2 = vm.addr(PK2);
        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        vm.deal(E1, 10 ether); vm.prank(E1); inst.bond{value: 2 ether}(ids);
        vm.deal(E2, 10 ether); vm.prank(E2); inst.bond{value: 2 ether}(ids);

        // epoch 1: the pilot beacon is keccak(prevrandao, blockNumber), so the fixtures' values still apply
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO);
        assertEq(cm.rollEpoch(), FX.BEACON, "beacon");
        claimFor(PK1); claimFor(PK2); // only these two are eligible in epoch 2: the fixture claims are never filed

        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
        vm.deal(address(this), 10 ether);
    }

    // ---- helpers ----
    function signed(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }

    /// a residency claim for epoch 1. Its partials are never opened here, so any well-formed coverage will do
    function claimFor(uint256 pk) internal {
        IPoRWClaimManager.Claim memory c = IPoRWClaimManager.Claim({
            mepId: mepId, partialsRoot: keccak256(abi.encode("partials", pk)), coverageBytes: 4096,
            challenge: cm.epochChallenge(cm.currentEpoch(), mepId)
        });
        cm.submitClaim(c, signed(pk, cm.claimDigest(c)));
    }

    /// a task whose executors all assert B's (wrong) root, so they agree and it settles
    function postSettled(uint8 redundancy, bytes32 salt) internal returns (bytes32 taskId, address[] memory ex) {
        ITaskMarket.Task memory t = ITaskMarket.Task({
            mepId: mepId, stimulusSeed: FX.STIMULUS_SEED, steps: FX.STEPS, commitStride: FX.STRIDE,
            initStateRoot: FX.TASK_INPUT_COMMIT, fee: FX.TASK_FEE, deadline: FX.TASK_DEADLINE, redundancy: redundancy
        });
        taskId = market.postTask{value: t.fee}(t, salt);
        ex = market.executors(taskId);
        assertEq(ex.length, redundancy, "sortition fills the redundancy from the two eligible instances");
        (ITaskMarket.Result memory rb,,) = FX.resultB0();
        for (uint256 i = 0; i < ex.length; i++) {
            uint256 pk = ex[i] == E1 ? PK1 : PK2;
            market.submitResult(taskId, rb, signed(pk, market.resultDigest(taskId, rb.execDigest, rb.execRoot)));
        }
        market.settle(taskId);
        (,,,,,, bool settled, bool disputed,) = market.tasks(taskId);
        assertTrue(settled && !disputed, "unanimous: settled without a dispute");
    }

    function openChallenge(bytes32 taskId) internal returns (ITaskMarket.Result memory ra) {
        (ra,,) = FX.resultA0();
        vm.deal(CHAL, 1 ether);
        vm.prank(CHAL); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
    }
    function bounds() internal pure returns (IExecutionDisputes.RowBounds memory b) {
        b = IExecutionDisputes.RowBounds({ start: FX.ROW_START, startProof: FX.rowStartProof(), end: FX.ROW_END, endProof: FX.rowEndProof() });
    }
    function chunk() internal pure returns (IExecutionDisputes.ChunkOpening memory c) {
        c = IExecutionDisputes.ChunkOpening({ c: FX.CHUNK_C, records: FX.chunkRecords(), proof: FX.chunkProof() });
    }

    // ---- the whole point: an outsider's disagreement becomes a verdict ----

    function test_challenge_opens_a_dispute_against_the_settled_executor() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "t1");
        openChallenge(taskId);
        assertEq(market.challenger(taskId), CHAL, "the challenger is on record");
        assertEq(market.challengeDeposit(taskId), CHAL_DEPOSIT, "deposit held by the market");
        assertFalse(market.submitted(taskId, CHAL), "a challenger is not an executor: executors()/_pay are untouched");
        assertEq(disp.partyA(taskId), ex[0], "the settled executor defends");
        assertEq(disp.partyB(taskId), CHAL, "the replicator prosecutes");
        (,,,,,, IExecutionDisputes.Phase phase,,,,,,, bool exists,) = disp.disputes(taskId);
        assertTrue(exists && phase == IExecutionDisputes.Phase.Step, "same bisection, from the top");
    }

    function test_challenger_wins_at_the_single_term() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "t2");
        address ref = ex[0];
        openChallenge(taskId);
        vm.prank(ref);  disp.revealRoots(taskId, FX.actRootsB()); // the roots behind the settled (wrong) digest
        vm.prank(CHAL); disp.revealRoots(taskId, FX.actRootsA());
        bytes32[] memory pa = FX.pairsAFlat(); bytes32[] memory pb = FX.pairsBFlat();
        for (uint256 i = 0; i < FX.ROUNDS; i++) {
            vm.prank(ref);  disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]);
            vm.prank(CHAL); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]);
        }
        vm.prank(ref);  disp.postRow(taskId, FX.ACT_B, FX.sumsBLied());
        vm.prank(CHAL); disp.postRow(taskId, FX.ACT_A, FX.sumsA());
        uint256 bonded = inst.bonded(ref); uint256 bal = CHAL.balance;
        disp.proveSynapseTerm(taskId, FX.K_STAR, FX.CSR_ROOT, FX.ROW_ROOT, bounds(), chunk(), FX.ACT_PRE, FX.actPreProof());
        assertEq(inst.bonded(ref), bonded - SLASH, "the executor that asserted it is slashed");
        assertEq(CHAL.balance, bal + SLASH + CHAL_DEPOSIT, "the slash and the deposit go to the replicator");
        (,,,,,,,, bool repudiated) = market.tasks(taskId);
        assertTrue(repudiated, "the settled digest stops being citable");
    }

    /// the fee is NOT clawed back: `_pay` ran at settle. The deterrent is the slash, and SLASH_AMOUNT is set
    /// above any single task fee for exactly this reason.
    function test_the_fee_already_paid_is_not_reversed() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "t3");
        address ref = ex[0];
        uint256 paid = ref.balance; // includes the whole fee from settle
        openChallenge(taskId);
        vm.prank(CHAL); disp.revealRoots(taskId, FX.actRootsA());
        vm.roll(block.number + ROUND + 1); disp.timeout(taskId);
        assertEq(ref.balance, paid, "the fee stays where settlement sent it");
        assertEq(inst.bonded(ref), 2 ether - SLASH, "only the bond moves");
    }

    function test_every_executor_that_asserted_the_same_digest_is_slashed() public {
        (bytes32 taskId, address[] memory ex) = postSettled(2, "t4");
        assertTrue(ex.length == 2 && ex[0] != ex[1], "two distinct executors agreed on it");
        openChallenge(taskId);
        vm.prank(CHAL); disp.revealRoots(taskId, FX.actRootsA());
        vm.roll(block.number + ROUND + 1);
        uint256 b0 = inst.bonded(ex[0]); uint256 b1 = inst.bonded(ex[1]); uint256 bal = CHAL.balance;
        disp.timeout(taskId);
        address beaten = market.repudiatedExecutor(taskId); address other = beaten == ex[0] ? ex[1] : ex[0];
        assertEq(beaten, market.settledRef(taskId), "the executor the task settled on is the one that was disputed");
        assertEq(inst.bonded(beaten), (beaten == ex[0] ? b0 : b1) - SLASH, "the party that went silent");
        vm.expectRevert(bytes("not an agreeing executor")); disp.slashAgreeing(taskId, beaten);   // it has paid already
        vm.expectRevert(bytes("not an agreeing executor")); disp.slashAgreeing(taskId, address(0xD00D)); // never submitted anything
        disp.slashAgreeing(taskId, other); // anyone may name an executor whose recorded result is the repudiated one
        assertEq(inst.bonded(other), (other == ex[0] ? b0 : b1) - SLASH, "and the one that asserted the identical digest");
        vm.expectRevert(bytes("slashed")); disp.slashAgreeing(taskId, other);
        assertEq(CHAL.balance, bal + 2 * SLASH + CHAL_DEPOSIT, "both slashes pay the replicator");
    }

    function test_a_griefer_pays_the_executor_that_defended() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "t5");
        address ref = ex[0];
        openChallenge(taskId);
        vm.prank(ref); disp.revealRoots(taskId, FX.actRootsB()); // this time the challenger goes quiet
        vm.roll(block.number + ROUND + 1);
        uint256 bal = ref.balance; uint256 bonded = inst.bonded(ref);
        disp.timeout(taskId);
        assertEq(ref.balance, bal + CHAL_DEPOSIT / 2, "half the deposit pays for the defence"); assertEq(SINK.balance, CHAL_DEPOSIT - CHAL_DEPOSIT / 2, "the other half leaves both parties for good");
        assertEq(inst.bonded(ref), bonded, "nothing is slashed: a challenger has no bond to take");
        (,,,,,,,, bool repudiated) = market.tasks(taskId);
        assertFalse(repudiated, "a failed challenge leaves the result standing");
    }

    // ---- the two escapes the review found, closed ----

    /// play a challenge of `taskId` by `who` to its verdict: the executor's row is the lied one, the challenger's is right
    function winChallenge(bytes32 taskId, address ref, address who) internal {
        vm.prank(ref); disp.revealRoots(taskId, FX.actRootsB()); vm.prank(who); disp.revealRoots(taskId, FX.actRootsA());
        bytes32[] memory pa = FX.pairsAFlat(); bytes32[] memory pb = FX.pairsBFlat();
        for (uint256 i = 0; i < FX.ROUNDS; i++) { vm.prank(ref); disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]); vm.prank(who); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]); }
        vm.prank(ref); disp.postRow(taskId, FX.ACT_B, FX.sumsBLied()); vm.prank(who); disp.postRow(taskId, FX.ACT_A, FX.sumsA());
        disp.proveSynapseTerm(taskId, FX.K_STAR, FX.CSR_ROOT, FX.ROW_ROOT, bounds(), chunk(), FX.ACT_PRE, FX.actPreProof());
    }

    /// A liar's accomplice challenges first (or front-runs the honest replicator) and throws the game. That used to close
    /// the task for good. Now it costs the pair half a deposit, hands the elapsed time back, and the next challenge -- for
    /// twice the deposit, refunded on a win -- goes through and repudiates the digest.
    function test_a_thrown_challenge_no_longer_shields_a_wrong_result() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "shield"); address liar = ex[0]; address accomplice = address(0xACC0);
        (ITaskMarket.Result memory ra,,) = FX.resultA0(); vm.deal(accomplice, 1 ether); uint256 pairBefore = liar.balance + accomplice.balance;
        (,,,, uint64 settledAt0,,,,) = market.tasks(taskId);
        vm.prank(accomplice); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
        vm.deal(CHAL, 1 ether); vm.prank(CHAL); vm.expectRevert(bytes("task")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra); // one challenge at a time
        vm.prank(liar); disp.revealRoots(taskId, FX.actRootsB()); vm.roll(block.number + ROUND + 1); disp.timeout(taskId); // the accomplice never plays
        assertEq(liar.balance + accomplice.balance, pairBefore - (CHAL_DEPOSIT - CHAL_DEPOSIT / 2), "throwing a challenge costs the pair half the deposit");
        (,,,, uint64 settledAt1,,, bool disputed,) = market.tasks(taskId);
        assertFalse(disputed, "the task is challengeable again"); assertEq(settledAt1, settledAt0 + ROUND + 1, "and the time the thrown challenge took is handed back");
        assertEq(market.requiredChallengeDeposit(taskId), 2 * CHAL_DEPOSIT, "the next challenge costs twice as much");
        vm.prank(CHAL); vm.expectRevert(bytes("deposit")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
        uint256 bal = CHAL.balance; uint256 bonded = inst.bonded(liar);
        vm.prank(CHAL); market.challengeResult{value: 2 * CHAL_DEPOSIT}(taskId, ra); // the honest replicator, after the shield
        winChallenge(taskId, liar, CHAL);
        (,,,,,,,, bool repudiated) = market.tasks(taskId); assertTrue(repudiated, "the wrong digest is repudiated after all");
        assertEq(inst.bonded(liar), bonded - SLASH); assertEq(CHAL.balance, bal + SLASH, "its larger deposit came back, plus the slash");
    }

    /// Liars that settle and immediately ask to exit used to vanish from the roster `challengeResult` looked them up in.
    /// The executor to dispute is now the one recorded at settle, and an open dispute holds both parties' exits.
    function test_liars_that_request_exit_are_still_challenged_and_slashed() public {
        (bytes32 taskId, address[] memory ex) = postSettled(2, "exit"); address ref = market.settledRef(taskId); address other = ref == ex[0] ? ex[1] : ex[0];
        for (uint256 i = 0; i < ex.length; i++) { vm.prank(ex[i]); inst.requestExit(); }
        assertEq(market.executors(taskId).length, 2, "the roster was drawn when the task was posted: asking to exit does not take anybody off it");
        (ITaskMarket.Result memory ra,,) = FX.resultA0(); vm.deal(CHAL, 1 ether); vm.prank(CHAL); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
        vm.prank(CHAL); disp.revealRoots(taskId, FX.actRootsA()); // the replicator plays; the liar, on its way out, does not
        vm.roll(block.number + 21); // past EXIT_DELAY: without the hold the disputed liar would walk out now, bond and all
        vm.prank(ref); vm.expectRevert(bytes("in dispute")); inst.finalizeExit();
        uint256 bRef = inst.bonded(ref); uint256 bOther = inst.bonded(other);
        disp.timeout(taskId); // the liar did not defend: it is the silent party
        assertEq(inst.bonded(ref), bRef - SLASH, "slashed although it had asked to exit"); assertEq(inst.disputeHolds(ref), 0, "the verdict releases the hold");
        disp.slashAgreeing(taskId, other); assertEq(inst.bonded(other), bOther - SLASH, "so is the one that asserted the same digest, off the roster or not");
        vm.prank(ref); inst.finalizeExit(); // what is left may leave
    }

    // ---- guards ----

    function test_an_executor_cannot_challenge_its_own_task() public {
        (bytes32 taskId, address[] memory ex) = postSettled(1, "g1");
        (ITaskMarket.Result memory ra,,) = FX.resultA0();
        vm.deal(ex[0], 1 ether);
        vm.prank(ex[0]); vm.expectRevert(bytes("executor")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
    }

    function test_a_challenge_must_actually_disagree() public {
        (bytes32 taskId,) = postSettled(1, "g2");
        (ITaskMarket.Result memory rb,,) = FX.resultB0();
        vm.deal(CHAL, 1 ether);
        vm.prank(CHAL); vm.expectRevert(bytes("agrees")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, rb);
    }

    function test_the_deposit_is_a_floor() public {
        (bytes32 taskId,) = postSettled(1, "g3");
        (ITaskMarket.Result memory ra,,) = FX.resultA0();
        vm.deal(CHAL, 1 ether);
        vm.prank(CHAL); vm.expectRevert(bytes("deposit")); market.challengeResult{value: CHAL_DEPOSIT - 1}(taskId, ra);
    }

    function test_the_window_closes() public {
        (bytes32 taskId,) = postSettled(1, "g4");
        (ITaskMarket.Result memory ra,,) = FX.resultA0();
        vm.roll(block.number + CHAL_WINDOW + 1);
        vm.deal(CHAL, 1 ether);
        vm.prank(CHAL); vm.expectRevert(bytes("window")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
    }

    function test_one_challenge_per_task() public {
        (bytes32 taskId,) = postSettled(1, "g5");
        openChallenge(taskId);
        (ITaskMarket.Result memory ra,,) = FX.resultA0();
        address second = address(0xBEEF); vm.deal(second, 1 ether);
        vm.prank(second); vm.expectRevert(bytes("task")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
    }

    function test_an_unsettled_task_is_settle_s_business_not_a_challenger_s() public {
        ITaskMarket.Task memory t = ITaskMarket.Task({
            mepId: mepId, stimulusSeed: FX.STIMULUS_SEED, steps: FX.STEPS, commitStride: FX.STRIDE,
            initStateRoot: FX.TASK_INPUT_COMMIT, fee: FX.TASK_FEE, deadline: FX.TASK_DEADLINE, redundancy: 1
        });
        bytes32 taskId = market.postTask{value: t.fee}(t, "g6");
        (ITaskMarket.Result memory ra,,) = FX.resultA0();
        vm.deal(CHAL, 1 ether);
        vm.prank(CHAL); vm.expectRevert(bytes("task")); market.challengeResult{value: CHAL_DEPOSIT}(taskId, ra);
    }

    /// `_who`'s direct branch must not widen who can play: a stranger is still not a party
    function test_a_bystander_cannot_post_rounds() public {
        (bytes32 taskId,) = postSettled(1, "g7");
        openChallenge(taskId);
        vm.prank(address(0xDECAF)); vm.expectRevert(bytes("party")); disp.revealRoots(taskId, FX.actRootsA());
    }
}
