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

/// Two defects found while measuring what a task costs (TaskGas.t.sol), and what replaced them.
///
///  1. The executors of a task were recomputed, on every call, from the vote list of every instance enrolled for the
///     brain. Now a draw is constant time and the roster is drawn once, at post, and stored.
///  2. Two results "agreed" only if digest AND root agreed, but nothing on chain binds the digest to the root. A party
///     could submit the honest root beside another digest and open a dispute with no step to bisect to, which whoever
///     revealed first won by timeout. Now agreement is on the root, and a digest is endorsed by majority or not at all.
///
/// Executors are instances whose keys this test holds; they sign whatever result the case needs.
contract SortitionAndDigestTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    bytes32 mepId; bytes32[] ids; mapping(address => uint256) pkOf; address[] who;
    uint256 constant SLASH = 0.5 ether; address constant SINK = address(0x51AC); address constant CHAL = address(0xC0FFEE);
    receive() external payable {}

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak(); meps = new MEPRegistry(); inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, FX.EPOCH_BLOCKS, 10, 0.1 ether, SLASH, IBeacon(address(0)));
        market = new TaskMarket(meps, inst, cm, uint64(50)); disp = new ExecutionDisputes(meps, inst, market, 10, SLASH);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp)); market.setChallengeParams(0.05 ether, 15, SINK);
        mepId = meps.registerMEP(IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo") }));
        ids.push(mepId); vm.deal(address(this), 1000 ether);
    }
    function signed(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
    /// bond `weights[k]` UNITs each, in order; everybody claims in epoch 1 unless `claims[k]` is false; tasks go in epoch 2
    function enrol(uint256[] memory weights, bool[] memory claims) internal {
        for (uint256 k = 0; k < weights.length; k++) { uint256 pk = 0xA100 + k; address a = vm.addr(pk); pkOf[a] = pk; who.push(a); vm.deal(a, 100 ether); vm.prank(a); inst.bond{value: weights[k] * 1 ether}(ids); }
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch();
        for (uint256 k = 0; k < weights.length; k++) if (claims[k]) {
            IPoRWClaimManager.Claim memory c = IPoRWClaimManager.Claim({ mepId: mepId, partialsRoot: keccak256(abi.encode("p", k)), coverageBytes: 4096, challenge: cm.epochChallenge(cm.currentEpoch(), mepId) });
            cm.submitClaim(c, signed(0xA100 + k, cm.claimDigest(c)));
        }
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
    }
    function all(uint256 n, bool v) internal pure returns (bool[] memory b) { b = new bool[](n); for (uint256 i = 0; i < n; i++) b[i] = v; }
    function task(uint8 r) internal view returns (ITaskMarket.Task memory) {
        return ITaskMarket.Task({ mepId: mepId, stimulusSeed: FX.STIMULUS_SEED, steps: FX.STEPS, commitStride: FX.STRIDE, initStateRoot: FX.TASK_INPUT_COMMIT, fee: 0.01 ether, deadline: FX.TASK_DEADLINE, redundancy: r });
    }
    function post(uint8 r, bytes32 nonce) internal returns (bytes32) { return market.postTask{value: 0.01 ether}(task(r), nonce); }
    function submit(bytes32 taskId, address a, bytes32 digest, bytes32 root) internal { ITaskMarket.Result memory res = ITaskMarket.Result(digest, root); market.submitResult(taskId, res, signed(pkOf[a], market.resultDigest(taskId, digest, root))); }

    // ---- 1. the sortition ----

    function test_draws_are_in_proportion_to_stake_among_the_eligible() public {
        uint256[] memory w = new uint256[](5); w[0] = 1; w[1] = 1; w[2] = 2; w[3] = 4; w[4] = 4; bool[] memory c = all(5, true); c[4] = false; // the last one never claimed
        enrol(w, c); assertEq(inst.weightCap(mepId), 4, "the largest weight anybody bonded with");
        uint256[5] memory hits; uint256 T = 800;
        for (uint256 t = 0; t < T; t++) { address e = market.executors(post(1, bytes32(t)))[0]; for (uint256 k = 0; k < 5; k++) if (who[k] == e) hits[k]++; }
        assertEq(hits[4], 0, "an instance with no valid claim is never drawn, whatever its stake");
        // expected 1 : 1 : 2 : 4 of 800 = 100, 100, 200, 400; three standard deviations of a binomial is under 45
        assertApproxEqAbs(hits[0], 100, 40); assertApproxEqAbs(hits[1], 100, 40); assertApproxEqAbs(hits[2], 200, 45); assertApproxEqAbs(hits[3], 400, 45);
    }

    function test_the_roster_is_a_fact_about_the_task() public {
        uint256[] memory w = new uint256[](3); w[0] = 1; w[1] = 1; w[2] = 1; enrol(w, all(3, true));
        bytes32 taskId = post(2, "r"); address[] memory before = market.executors(taskId); assertEq(before.length, 2);
        // an executor asks to exit; a stranger enrols; somebody tops up: none of it moves anybody on or off an open task
        vm.prank(before[0]); inst.requestExit();
        address late = vm.addr(0xBEEF); vm.deal(late, 100 ether); vm.prank(late); inst.bond{value: 16 ether}(ids);
        address[] memory afterwards = market.executors(taskId);
        assertTrue(afterwards.length == 2 && afterwards[0] == before[0] && afterwards[1] == before[1], "drawn at post, stored, fixed");
        // and an instance that is not on it cannot submit, exactly as before
        address outsider = who[0] != before[0] && who[0] != before[1] ? who[0] : who[1] != before[0] && who[1] != before[1] ? who[1] : who[2];
        ITaskMarket.Result memory res = ITaskMarket.Result(bytes32("d"), bytes32("r")); bytes memory sig = signed(pkOf[outsider], market.resultDigest(taskId, res.execDigest, res.execRoot));
        vm.expectRevert(bytes("not an executor")); market.submitResult(taskId, res, sig);
    }

    function test_a_task_nobody_can_execute_is_refused_not_stranded() public {
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1; enrol(w, all(2, false)); // enrolled, never claimed
        ITaskMarket.Task memory t = task(1); vm.expectRevert(bytes("no eligible instances")); market.postTask{value: t.fee}(t, "n");
    }

    function test_a_top_up_that_does_not_name_the_mep_is_drawn_at_the_caps_weight() public {
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1; enrol(w, all(2, true));
        bytes32[] memory none = new bytes32[](0); vm.prank(who[0]); inst.bond{value: 15 ether}(none);
        assertEq(inst.weightOf(who[0]), 16); assertEq(inst.weightCap(mepId), 1, "the cap only moves when the MEP is named: never more than the stake, and correctable");
        vm.prank(who[0]); inst.bond{value: 1 wei}(ids); assertEq(inst.weightCap(mepId), 16, "naming it once corrects it");
    }

    // ---- 2. a digest that the root does not determine ----

    function test_a_digest_only_difference_is_not_a_dispute() public {
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1; enrol(w, all(2, true));
        bytes32 taskId = post(2, "d"); address[] memory ex = market.executors(taskId); uint256 b0 = ex[0].balance; uint256 b1 = ex[1].balance;
        submit(taskId, ex[0], bytes32("honest digest"), bytes32("the root")); submit(taskId, ex[1], bytes32("another digest"), bytes32("the root"));
        market.settle(taskId);
        (,,,,,, bool settled, bool disputed,) = market.tasks(taskId); assertTrue(settled && !disputed, "same root: they agree on everything a dispute could adjudicate");
        assertEq(ex[0].balance - b0, 0.005 ether); assertEq(ex[1].balance - b1, 0.005 ether);
        assertEq(market.settledDigest(taskId), bytes32(0), "two executors, two digests: the task endorses neither");
        assertEq(inst.disputeHolds(ex[0]), 0, "and nobody is dragged into a dispute whose first revealer wins");
    }

    function test_the_settled_digest_is_the_majoritys() public {
        uint256[] memory w = new uint256[](3); w[0] = 1; w[1] = 1; w[2] = 1; enrol(w, all(3, true));
        bytes32 taskId = post(3, "m"); address[] memory ex = market.executors(taskId); assertEq(ex.length, 3);
        submit(taskId, ex[0], bytes32("odd one out"), bytes32("the root")); submit(taskId, ex[1], bytes32("the digest"), bytes32("the root")); submit(taskId, ex[2], bytes32("the digest"), bytes32("the root"));
        market.settle(taskId); assertEq(market.settledDigest(taskId), bytes32("the digest"), "two of three");
        assertEq(market.paidExecutors(taskId), 3, "all three are paid: they are all on the hook for the same root");
    }

    function test_a_unanimous_task_settles_on_its_digest_as_ever() public {
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1; enrol(w, all(2, true));
        bytes32 taskId = post(2, "u"); address[] memory ex = market.executors(taskId);
        submit(taskId, ex[0], bytes32("the digest"), bytes32("the root")); submit(taskId, ex[1], bytes32("the digest"), bytes32("the root")); market.settle(taskId);
        assertEq(market.settledDigest(taskId), bytes32("the digest"));
    }

    function test_a_challenger_cannot_buy_a_dispute_with_a_digest() public {
        uint256[] memory w = new uint256[](1); w[0] = 1; enrol(w, all(1, true));
        bytes32 taskId = post(1, "c"); address e = market.executors(taskId)[0]; submit(taskId, e, bytes32("the digest"), bytes32("the root")); market.settle(taskId);
        // the attack this closes: same root, another digest, reveal first, win by timeout, collect the honest executor's slash
        vm.deal(CHAL, 1 ether); vm.prank(CHAL); vm.expectRevert(bytes("agrees")); market.challengeResult{value: 0.05 ether}(taskId, ITaskMarket.Result(bytes32("another digest"), bytes32("the root")));
        vm.prank(CHAL); market.challengeResult{value: 0.05 ether}(taskId, ITaskMarket.Result(bytes32("another digest"), bytes32("another root"))); // a root it would have to defend
    }

    function test_an_agreeing_executor_does_not_escape_behind_another_digest() public {
        uint256[] memory w = new uint256[](2); w[0] = 1; w[1] = 1; enrol(w, all(2, true));
        bytes32 taskId = post(2, "s"); address[] memory ex = market.executors(taskId);
        // both assert the fixtures' WRONG root (node B's), each beside a digest of its own
        (ITaskMarket.Result memory rb,,) = FX.resultB0(); (ITaskMarket.Result memory ra,,) = FX.resultA0();
        submit(taskId, ex[0], bytes32("digest one"), rb.execRoot); submit(taskId, ex[1], bytes32("digest two"), rb.execRoot); market.settle(taskId);
        address ref = market.settledRef(taskId); address other = ref == ex[0] ? ex[1] : ex[0];
        // a replicator brings the honest root, reveals, and the settled executor has nothing to say
        vm.deal(CHAL, 1 ether); vm.prank(CHAL); market.challengeResult{value: 0.05 ether}(taskId, ra);
        vm.prank(CHAL); disp.revealRoots(taskId, FX.actRootsA()); vm.roll(block.number + 11); disp.timeout(taskId);
        assertEq(market.repudiatedExecutor(taskId), ref, "the root is repudiated"); assertEq(inst.bonded(ref), 1 ether - SLASH);
        // the other executor signed the same wrong root. A different digest beside it used to read as "another result"
        disp.slashAgreeing(taskId, other); assertEq(inst.bonded(other), 1 ether - SLASH, "slashed for the root it signed, whatever digest it put beside it");
    }
}
