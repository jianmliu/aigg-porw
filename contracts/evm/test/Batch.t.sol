// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../src/PorwVerifierKeccak.sol";
import "../src/interfaces/PorwMesh.sol";
import "../src/mesh/MEPRegistry.sol";
import "../src/mesh/InstanceRegistry.sol";
import "../src/mesh/PoRWClaimManager.sol";
import "../src/mesh/TaskMarket.sol";
import "../src/mesh/ExecutionDisputes.sol";
import "../src/mesh/LifRowCheck.sol";
import { LifMeshFixtures as FX } from "./fixtures/LifMeshFixtures.sol";

/// A batch: one task, many runs of the same brain. The honest path costs what one task costs, whatever the number of
/// runs; a disagreement is bisected to the first run the parties differ on and is that run's dispute from there.
///
/// The executors are two instances whose keys this test holds, as in ReplicatorStanding. Run results are built here:
/// every run has a made-up execRoot except run STAR, which IS the int-lif fixtures' task -- its seed, its state_0 root,
/// the honest node's execRoot and the lying node's. So once the batch dispute has found and opened run STAR, the rest
/// of the fixtures (segment roots, step roots, twelve rounds of neuron bisection, the rows, the one signed synaptic
/// term) apply unchanged, and the liar is convicted of one term of one step of one run out of a thousand. Gas: `forge test --match-contract BatchTest --isolate -vv`.
contract BatchTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    uint256 constant PK1 = uint256(0xE1); uint256 constant PK2 = uint256(0xE2); address E1; address E2; bytes32 mepId;
    uint32 constant RUNS = 1000; uint32 constant STAR = 613;
    receive() external payable {}

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak(); meps = new MEPRegistry(); inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, FX.EPOCH_BLOCKS, 10, 0.1 ether, 0.5 ether, IBeacon(address(0)));
        market = new TaskMarket(meps, inst, cm, uint64(50)); disp = new ExecutionDisputes(meps, inst, market, 10, 0.5 ether);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));
        mepId = meps.registerMEP(IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo") }));
        E1 = vm.addr(PK1); E2 = vm.addr(PK2); bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        vm.deal(E1, 10 ether); vm.prank(E1); inst.bond{value: 2 ether}(ids); vm.deal(E2, 10 ether); vm.prank(E2); inst.bond{value: 2 ether}(ids);
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch(); claimFor(PK1); claimFor(PK2);
        vm.roll(2 * FX.EPOCH_BLOCKS); vm.difficulty(7); cm.rollEpoch();
        vm.deal(address(this), 100 ether);
    }
    function signed(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
    function claimFor(uint256 pk) internal {
        IPoRWClaimManager.Claim memory c = IPoRWClaimManager.Claim({ mepId: mepId, partialsRoot: keccak256(abi.encode("partials", pk)), coverageBytes: 4096, challenge: cm.epochChallenge(cm.currentEpoch(), mepId) });
        cm.submitClaim(c, signed(pk, cm.claimDigest(c)));
    }

    // ---- the two trees of a batch, built the way an executor builds them (counted keccak Merkle, duplicate-last) ----
    function le32(uint32 x) internal pure returns (bytes4) { return bytes4(uint32((x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24))); }
    function seedOf(uint32 k) internal pure returns (uint32) { return k == STAR ? FX.STIMULUS_SEED : 1000 + k; }
    function initOf(uint32 k) internal pure returns (bytes32) { return k == STAR ? FX.INIT_STATE_ROOT : keccak256(abi.encode("state0", k)); }
    function inputLeaves() internal pure returns (bytes32[] memory l) { l = new bytes32[](RUNS); for (uint32 k = 0; k < RUNS; k++) l[k] = keccak256(abi.encodePacked(le32(k), le32(seedOf(k)), initOf(k))); }
    function resultLeaves(bool honest) internal pure returns (bytes32[] memory l) {
        (ITaskMarket.Result memory ra,) = FX.resultA0(); (ITaskMarket.Result memory rb,) = FX.resultB0();
        l = new bytes32[](RUNS); for (uint32 k = 0; k < RUNS; k++) l[k] = keccak256(abi.encodePacked(le32(k), k == STAR ? (honest ? ra.execRoot : rb.execRoot) : keccak256(abi.encode("run", k))));
    }
    function levelUp(bytes32[] memory l) internal pure returns (bytes32[] memory n) { n = new bytes32[]((l.length + 1) / 2); for (uint256 i = 0; i < n.length; i++) n[i] = keccak256(bytes.concat(l[2 * i], 2 * i + 1 < l.length ? l[2 * i + 1] : l[2 * i])); }
    function rootOf(bytes32[] memory l) internal pure returns (bytes32) { while (l.length > 1) l = levelUp(l); return l[0]; }
    /// node `idx` of `level` (0 = leaves)
    function nodeAt(bytes32[] memory l, uint32 level, uint32 idx) internal pure returns (bytes32) { for (uint32 v = 0; v < level; v++) l = levelUp(l); return l[idx]; }
    function proofOf(bytes32[] memory l, uint32 idx) internal pure returns (bytes32[] memory p) {
        uint256 depth = 0; for (uint256 w = l.length; w > 1; w = (w + 1) / 2) depth++;
        p = new bytes32[](depth); for (uint256 d = 0; d < depth; d++) { uint32 sib = idx ^ 1; p[d] = sib < l.length ? l[sib] : l[idx]; l = levelUp(l); idx /= 2; }
    }
    function result(bool honest) internal pure returns (ITaskMarket.Result memory r) { r.execRoot = rootOf(resultLeaves(honest)); r.execDigest = keccak256(abi.encodePacked("aigg:batch:v1", r.execRoot)); }
    function batchTask(uint8 redundancy) internal pure returns (ITaskMarket.Task memory) {
        return ITaskMarket.Task({ mepId: bytes32(0), stimulusSeed: 0, steps: FX.STEPS, commitStride: FX.STRIDE, initStateRoot: bytes32(0), fee: 1 ether, deadline: FX.TASK_DEADLINE, redundancy: redundancy });
    }
    function post(uint8 redundancy, bytes32 nonce) internal returns (bytes32 taskId, ITaskMarket.Task memory t) {
        t = batchTask(redundancy); t.mepId = mepId; t.initStateRoot = rootOf(inputLeaves()); taskId = market.postBatch{value: t.fee}(t, RUNS, nonce);
    }
    function submit(bytes32 taskId, address who, ITaskMarket.Result memory r) internal { market.submitResult(taskId, r, signed(who == E1 ? PK1 : PK2, market.resultDigest(taskId, r.execDigest, r.execRoot))); }
    function calldataGas(bytes memory d) internal pure returns (uint256 g) { for (uint256 i = 0; i < d.length; i++) g += d[i] == 0 ? 4 : 16; }
    function receipt(bytes memory data) internal returns (uint256) { return 21000 + calldataGas(data) + vm.lastCallGas().gasTotalUsed; }

    // ---- the honest path ----

    function test_a_batch_of_a_thousand_runs_costs_what_one_task_costs() public {
        ITaskMarket.Task memory t = batchTask(2); t.mepId = mepId; t.initStateRoot = rootOf(inputLeaves());
        bytes32 taskId = market.postBatch{value: t.fee}(t, RUNS, "b"); uint256 g = receipt(abi.encodeCall(market.postBatch, (t, RUNS, bytes32("b"))));
        assertEq(market.batchRuns(taskId), RUNS); assertEq(taskId, keccak256(abi.encode(keccak256(abi.encode(t, bytes32("b"))), RUNS)), "the id covers the run count");
        address[] memory ex = market.executors(taskId); ITaskMarket.Result memory r = result(true); uint256 b1 = E1.balance;
        for (uint256 i = 0; i < ex.length; i++) { bytes memory sig = signed(ex[i] == E1 ? PK1 : PK2, market.resultDigest(taskId, r.execDigest, r.execRoot)); market.submitResult(taskId, r, sig); g += receipt(abi.encodeCall(market.submitResult, (taskId, r, sig))); }
        market.settle(taskId); g += receipt(abi.encodeCall(market.settle, (taskId)));
        assertEq(E1.balance - b1, 0.5 ether, "the fee is for the batch, split as ever");
        console2.log("batch of 1000 runs, redundancy 2, honest path, total gas:", g); console2.log("  per run:", g / RUNS);
        assertLt(g, 950000, "a batch costs what one task costs (TaskGas: 859,924 at redundancy 2)");
    }

    function test_the_guards() public {
        ITaskMarket.Task memory t = batchTask(1); t.mepId = mepId; t.initStateRoot = rootOf(inputLeaves());
        vm.expectRevert(bytes("runs")); market.postBatch{value: t.fee}(t, 1, "n");
        vm.expectRevert(bytes("runs")); market.postBatch{value: t.fee}(t, (1 << 16) + 1, "n");
        t.stimulusSeed = 7; vm.expectRevert(bytes("a batch's seeds are in its runs")); market.postBatch{value: t.fee}(t, RUNS, "n"); t.stimulusSeed = 0;
        bytes32 single = market.postTask{value: t.fee}(t, "n"); bytes32 batch = market.postBatch{value: t.fee}(t, RUNS, "n");
        assertTrue(single != batch, "the same fields and nonce as a single task are another task"); assertEq(market.batchRuns(single), 0);
        // a batch result has one degree of freedom: a free digest is refused at the door, not discovered in a dispute
        ITaskMarket.Result memory r = result(true); r.execDigest = keccak256("free"); address ex = market.executors(batch)[0];
        bytes memory sig = signed(ex == E1 ? PK1 : PK2, market.resultDigest(batch, r.execDigest, r.execRoot));
        vm.expectRevert(bytes("batch digest")); market.submitResult(batch, r, sig);
    }

    // ---- a disagreement: found by bisection, then it is the run's dispute ----

    function bisect(bytes32 taskId, address honest, address liar) internal returns (uint256 gasHonest) {
        bytes32[] memory H = resultLeaves(true); bytes32[] memory W = resultLeaves(false);
        (, uint32 level, uint32 idx) = disp.batches(taskId);
        while (level > 0) {
            uint32 l = 2 * idx; uint32 width = uint32(nodeWidth(level - 1)); uint32 rr = l + 1 < width ? l + 1 : l;
            vm.prank(honest); disp.postChildren(taskId, nodeAt(H, level - 1, l), nodeAt(H, level - 1, rr)); gasHonest += receipt(abi.encodeCall(disp.postChildren, (taskId, bytes32(0), bytes32(0))));
            vm.prank(liar); disp.postChildren(taskId, nodeAt(W, level - 1, l), nodeAt(W, level - 1, rr));
            (, level, idx) = disp.batches(taskId);
        }
    }
    function nodeWidth(uint32 level) internal pure returns (uint256 w) { w = RUNS; for (uint32 l = 0; l < level; l++) w = (w + 1) / 2; }

    function test_a_disagreement_is_bisected_to_the_run_and_becomes_that_runs_dispute() public {
        (bytes32 taskId,) = post(2, "d"); address[] memory ex = market.executors(taskId); address honest = ex[0]; address liar = ex[1];
        submit(taskId, honest, result(true)); submit(taskId, liar, result(false)); market.settle(taskId);
        (,,,,,, IExecutionDisputes.Phase phase,,,,,,, bool exists,) = disp.disputes(taskId); assertTrue(exists && phase == IExecutionDisputes.Phase.Run, "a batch dispute starts by finding the run");
        uint256 g = bisect(taskId, honest, liar);
        (uint32 runs,, uint32 idx) = disp.batches(taskId); assertEq(runs, RUNS); assertEq(idx, STAR, "ten rounds find the one run that differs");

        (ITaskMarket.Result memory ra,) = FX.resultA0(); (ITaskMarket.Result memory rb,) = FX.resultB0(); bytes32[] memory proof = proofOf(inputLeaves(), STAR);
        vm.prank(liar); vm.expectRevert(bytes("run result")); disp.openRun(taskId, ra.execRoot, seedOf(STAR), initOf(STAR), proof); // not the root it was bisected to
        vm.prank(honest); vm.expectRevert(bytes("run input")); disp.openRun(taskId, ra.execRoot, seedOf(STAR) + 1, initOf(STAR), proof); // nor another run's input
        vm.prank(honest); disp.openRun(taskId, ra.execRoot, seedOf(STAR), initOf(STAR), proof); g += receipt(abi.encodeCall(disp.openRun, (taskId, ra.execRoot, seedOf(STAR), initOf(STAR), proof)));
        (,,,,,, phase,,,,,,,,) = disp.disputes(taskId); assertTrue(phase == IExecutionDisputes.Phase.Run, "one opening is not two");
        vm.prank(liar); disp.openRun(taskId, rb.execRoot, seedOf(STAR), initOf(STAR), proof);

        uint32 seed; (,,,, seed,, phase,,,,,,,,) = disp.disputes(taskId); (,,,, bytes32 init) = disp.lifs(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Step && seed == FX.STIMULUS_SEED && init == FX.INIT_STATE_ROOT, "from here it is run 613's dispute: its seed, its state_0, Phase.Step");
        console2.log("finding the run among 1000 (10 rounds + the opening), one party's gas:", g);

        // and it is: every later round is the int-lif fixtures' dispute, unchanged (MeshLif.t.sol), down to one signed term
        vm.prank(honest); disp.revealRoots(taskId, FX.segRootsA()); vm.prank(liar); disp.revealRoots(taskId, FX.segRootsB2());
        vm.prank(honest); disp.postStepRoots(taskId, FX.stepRootsA()); vm.prank(liar); disp.postStepRoots(taskId, FX.stepRootsB2());
        bytes32[] memory pa = FX.pairsA2Flat(); bytes32[] memory pb = FX.pairsB2Flat();
        for (uint256 i = 0; i < FX.ROUNDS; i++) { vm.prank(honest); disp.postChildren(taskId, pa[2 * i], pa[2 * i + 1]); vm.prank(liar); disp.postChildren(taskId, pb[2 * i], pb[2 * i + 1]); }
        LifRowCheck.State memory sa = FX.stateA(); LifRowCheck.State memory sb = FX.stateB2();
        vm.prank(honest); disp.postRowLif(taskId, sa.v, sa.g, sa.refr, sa.flags, sa.count, FX.sumsA());
        vm.prank(liar); disp.postRowLif(taskId, sb.v, sb.g, sb.refr, sb.flags, sb.count, FX.sumsB2Lied());
        disp.proveSynapseTermLif(taskId, IExecutionDisputes.LifTermProof({ kStar: FX.K_STAR, csrRoot: FX.CSR_ROOT, rowRoot: FX.ROW_ROOT,
            bounds: IExecutionDisputes.RowBounds({ start: FX.ROW_START, startProof: FX.rowStartProof(), end: FX.ROW_END, endProof: FX.rowEndProof() }),
            chunk: IExecutionDisputes.ChunkOpening({ c: FX.CHUNK_C, records: FX.chunkRecords(), proof: FX.chunkProof() }), self: FX.selfOpening(), pre: FX.preOpening() }));
        address loser; (,,,,,, phase,,,,,,,, loser) = disp.disputes(taskId);
        assertTrue(phase == IExecutionDisputes.Phase.Resolved && loser == liar, "convicted of one term of one step of one run out of a thousand");
        assertEq(inst.bonded(liar), 2 ether - 0.5 ether, "slashed"); assertEq(honest.balance, 10 ether - 2 ether + 0.5 ether + 1 ether, "the honest executor gets the slash and the whole fee");
    }

    /// The batch hashes, against the browser node's: web/porw-browser/batch_vectors.json holds the same four literals and
    /// test_batch.mjs asserts them from the JS side (batch.js), so a drift on either side fails one of the two.
    function idOf(ITaskMarket.Task calldata t, uint32 runs, bytes32 nonce) external pure returns (bytes32) { return PorwMeshHash.batchId(t, runs, nonce); }
    function test_the_batch_hashes_are_the_browser_nodes() public view {
        bytes32 init = bytes32(uint256(0xabababababababababababababababababababababababababababababababab)); bytes32 root = bytes32(uint256(0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd));
        assertEq(PorwMeshHash.runLeaf(613, 7, init), 0x41c6a7f58eee976f41f4ed59485df80994de5e0294a17123ba24659f759a50c6, "runLeaf");
        assertEq(PorwMeshHash.runResultLeaf(613, root), 0xf399d98da31382207e92a1e4b8e808dc0e7aad7390d55ec17798c85c57ba406e, "runResultLeaf");
        assertEq(PorwMeshHash.batchDigest(root), 0xa1d52fb9d531952e95bc2165c934a183c0a95cb2797e1712f875a09a795b9147, "batchDigest");
        ITaskMarket.Task memory t = ITaskMarket.Task({ mepId: bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)), stimulusSeed: 0, steps: 40, commitStride: 10,
            initStateRoot: bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333)), fee: 1 ether, deadline: 10000000, redundancy: 2 });
        assertEq(this.idOf(t, 1000, bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111))), 0x7b3827c74a2ad294218f9186b447dda64a44c45bd862212a5a934a886840afaa, "batchId");
        // and the test's own leaves above are the library's
        assertEq(inputLeaves()[STAR], PorwMeshHash.runLeaf(STAR, seedOf(STAR), initOf(STAR))); (ITaskMarket.Result memory ra,) = FX.resultA0(); assertEq(resultLeaves(true)[STAR], PorwMeshHash.runResultLeaf(STAR, ra.execRoot));
    }

    /// forge does not enforce EIP-170 in tests, and the chain does. The Run phase took this contract over the limit once
    /// before it shared `postChildren` with the neuron bisection; this is here so that the next addition finds out in CI.
    function test_the_contracts_still_fit_in_a_contract() public view {
        assertLe(address(disp).code.length, 24576, "ExecutionDisputes exceeds EIP-170"); assertLe(address(market).code.length, 24576, "TaskMarket exceeds EIP-170");
    }

    function test_a_party_that_stops_bisecting_or_will_not_open_loses_by_timeout() public {
        (bytes32 taskId,) = post(2, "t"); address[] memory ex = market.executors(taskId); address honest = ex[0]; address liar = ex[1];
        submit(taskId, honest, result(true)); submit(taskId, liar, result(false)); market.settle(taskId);
        bytes32[] memory H = resultLeaves(true); (, uint32 level,) = disp.batches(taskId);
        vm.prank(honest); disp.postChildren(taskId, nodeAt(H, level - 1, 0), nodeAt(H, level - 1, 1));
        vm.expectRevert(bytes("not expired")); disp.timeout(taskId);
        vm.roll(block.number + 11); disp.timeout(taskId);
        assertEq(inst.bonded(liar), 1.5 ether, "silence in the run bisection is a loss, as in every other phase");
    }
}
