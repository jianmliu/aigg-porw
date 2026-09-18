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

/// A beneficiary that follows something transferable: it collects for whoever `owner` is when it is asked to.
/// This is the shape a token collection takes (owner = ownerOf(tokenId)); the market only ever sees this contract.
contract Forwarder {
    TaskMarket immutable market; address public owner;
    constructor(TaskMarket m, address o) { market = m; owner = o; }
    function transfer(address to) external { require(msg.sender == owner, "owner"); owner = to; }
    function collect(bytes32 mepId) external returns (uint256 amt) { amt = market.withdrawRoyalty(mepId); (bool ok,) = owner.call{value: amt}(""); require(ok, "forward"); }
    receive() external payable {}
}
contract RefusesEther { function pull(TaskMarket m, bytes32 mepId) external { m.withdrawRoyalty(mepId); } }

/// A MEP's terms: a share of every fee settled for a task against it is owed to its beneficiary, as a protocol rule --
/// `TaskMarket._pay` sets it aside, so a client cannot post around it the way it could post around a router.
/// Executors are two instances whose keys this test holds and that assert the same result, as in ReplicatorStanding.
contract MepTermsTest is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    uint256 constant PK1 = uint256(0xE1); uint256 constant PK2 = uint256(0xE2); address E1; address E2;
    address constant OWNER = address(0xB0B); uint16 constant BPS = 1000; // a tenth
    bytes32 plainId; bytes32 termsId;

    receive() external payable {}

    function profile() internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND,
            neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo") });
    }

    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak(); meps = new MEPRegistry(); inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, FX.EPOCH_BLOCKS, 10, 0.1 ether, 0.5 ether, IBeacon(address(0)));
        market = new TaskMarket(meps, inst, cm, uint64(50)); disp = new ExecutionDisputes(meps, inst, market, 10, 0.5 ether);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));
        plainId = meps.registerMEP(profile());
        termsId = meps.registerMEPWithTerms(profile(), OWNER, BPS);
        E1 = vm.addr(PK1); E2 = vm.addr(PK2);
        bytes32[] memory ids = new bytes32[](2); ids[0] = plainId; ids[1] = termsId;
        vm.deal(E1, 10 ether); vm.prank(E1); inst.bond{value: 2 ether}(ids);
        vm.deal(E2, 10 ether); vm.prank(E2); inst.bond{value: 2 ether}(ids);
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch();
        claimFor(PK1, plainId); claimFor(PK2, plainId); claimFor(PK1, termsId); claimFor(PK2, termsId);
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
        vm.deal(address(this), 10 ether);
    }

    function signed(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
    function claimFor(uint256 pk, bytes32 mepId) internal {
        IPoRWClaimManager.Claim memory c = IPoRWClaimManager.Claim({ mepId: mepId, partialsRoot: keccak256(abi.encode("partials", pk)), coverageBytes: 4096, challenge: cm.epochChallenge(cm.currentEpoch(), mepId) });
        cm.submitClaim(c, signed(pk, cm.claimDigest(c)));
    }
    function settled(bytes32 mepId, uint256 fee, bytes32 salt) internal returns (bytes32 taskId) {
        ITaskMarket.Task memory t = ITaskMarket.Task({ mepId: mepId, stimulusSeed: FX.STIMULUS_SEED, steps: FX.STEPS, commitStride: FX.STRIDE,
            initStateRoot: FX.TASK_INPUT_COMMIT, fee: fee, deadline: FX.TASK_DEADLINE, redundancy: 2 });
        taskId = market.postTask{value: fee}(t, salt);
        address[] memory ex = market.executors(taskId); assertEq(ex.length, 2);
        (ITaskMarket.Result memory r,,) = FX.resultA0();
        for (uint256 i = 0; i < ex.length; i++) market.submitResult(taskId, r, signed(ex[i] == E1 ? PK1 : PK2, market.resultDigest(taskId, r.execDigest, r.execRoot)));
        market.settle(taskId);
    }

    // ---- the registry ----

    function test_terms_wrap_the_profile_id_and_leave_it_alone() public {
        assertEq(plainId, FX.MEP_ID, "a royalty-free profile keeps the id it always had");
        assertEq(termsId, keccak256(abi.encodePacked(plainId, OWNER, BPS)), "terms wrap the profile id");
        assertEq(termsId, 0xc247fefe110d36571757c174d94093885a0faababcbaef79c96c83595021e19a, "the literal web/porw-browser/test_mep_terms.mjs pins from the JS side");
        (address b, uint16 bps) = meps.termsOf(termsId); assertEq(b, OWNER); assertEq(bps, BPS);
        (b, bps) = meps.termsOf(plainId); assertEq(b, address(0)); assertEq(bps, 0);
        (bytes32 s1, bytes32 m1) = meps.claimBinding(termsId); (bytes32 s0, bytes32 m0) = meps.claimBinding(plainId);
        assertTrue(s1 == s0 && m1 == m0, "the same brain: a residency claim is signed over the same scheme and model");
    }

    function test_registration_is_still_not_a_race() public {
        // a squatter naming itself gets ANOTHER mep, not this one; naming the owner only repeats the owner's own call
        bytes32 squat = meps.registerMEPWithTerms(profile(), address(0x5A77), BPS); assertTrue(squat != termsId);
        (address b,) = meps.termsOf(termsId); assertEq(b, OWNER, "untouched");
        vm.expectRevert(bytes("registered")); meps.registerMEPWithTerms(profile(), OWNER, BPS);
        assertTrue(meps.registerMEPWithTerms(profile(), OWNER, BPS + 1) != termsId, "other terms, another mep");
    }

    function test_no_terms_has_one_spelling() public {
        vm.expectRevert(bytes("terms")); meps.registerMEPWithTerms(profile(), address(0), BPS);
        vm.expectRevert(bytes("terms")); meps.registerMEPWithTerms(profile(), OWNER, 0);
        vm.expectRevert(bytes("terms")); meps.registerMEPWithTerms(profile(), OWNER, 10001);
    }

    // ---- the market ----

    function test_the_royalty_is_set_aside_before_the_executors_split_the_rest() public {
        uint256 fee = 1 ether; uint256 b1 = E1.balance; uint256 b2 = E2.balance;
        bytes32 taskId = settled(termsId, fee, "t");
        assertEq(market.royalties(termsId), fee / 10, "a tenth, held by the market");
        assertEq(E1.balance - b1, (fee - fee / 10) / 2); assertEq(E2.balance - b2, (fee - fee / 10) / 2);
        assertEq(market.paidExecutors(taskId), 2, "the head count is recorded at settle");
        assertEq(OWNER.balance, 0, "set aside, not pushed");
    }

    function test_a_royalty_free_mep_pays_as_it_always_did() public {
        uint256 fee = 1 ether; uint256 b1 = E1.balance;
        bytes32 taskId = settled(plainId, fee, "t");
        assertEq(E1.balance - b1, fee / 2); assertEq(market.royalties(plainId), 0); assertEq(market.paidExecutors(taskId), 2);
    }

    function test_only_the_beneficiary_collects_and_only_once() public {
        settled(termsId, 1 ether, "t1"); settled(termsId, 0.5 ether, "t2");
        vm.expectRevert(bytes("beneficiary")); market.withdrawRoyalty(termsId);
        vm.prank(OWNER); uint256 got = market.withdrawRoyalty(termsId);
        assertEq(got, 0.15 ether, "both tasks"); assertEq(OWNER.balance, 0.15 ether); assertEq(market.royalties(termsId), 0);
        vm.prank(OWNER); vm.expectRevert(bytes("nothing")); market.withdrawRoyalty(termsId);
        vm.expectRevert(bytes("beneficiary")); market.withdrawRoyalty(plainId); // nobody is the beneficiary of a royalty-free mep
    }

    /// enrol both executors for a MEP registered after setUp: bond, claim in the task epoch, eligible in the next
    function enrol(bytes32 id) internal {
        bytes32[] memory ids = new bytes32[](1); ids[0] = id;
        vm.prank(E1); inst.bond{value: 1 ether}(ids); vm.prank(E2); inst.bond{value: 1 ether}(ids);
        claimFor(PK1, id); claimFor(PK2, id);
        vm.roll((FX.TASK_EPOCH + 1) * FX.EPOCH_BLOCKS); cm.rollEpoch();
    }

    function test_a_beneficiary_that_refuses_ether_cannot_stop_a_task_from_settling() public {
        RefusesEther r = new RefusesEther(); bytes32 id = meps.registerMEPWithTerms(profile(), address(r), BPS); enrol(id);
        uint256 b1 = E1.balance;
        settled(id, 1 ether, "t"); // `_pay` never calls the beneficiary
        assertEq(E1.balance - b1, 0.45 ether, "the executors are paid"); assertEq(market.royalties(id), 0.1 ether);
        vm.expectRevert(bytes("withdraw")); r.pull(market, id); // its refusal is its own problem, and the balance is still there
        assertEq(market.royalties(id), 0.1 ether);
    }

    function test_a_forwarding_beneficiary_pays_whoever_owns_it_now() public {
        Forwarder f = new Forwarder(market, address(0xA11CE)); bytes32 id = meps.registerMEPWithTerms(profile(), address(f), BPS); enrol(id);
        settled(id, 1 ether, "t1");
        vm.prank(address(0xA11CE)); f.transfer(address(0xB0B2));
        settled(id, 1 ether, "t2");
        assertEq(f.collect(id), 0.2 ether); assertEq(address(0xB0B2).balance, 0.2 ether, "the owner at collection time, as with any token-bound income");
        assertEq(address(0xA11CE).balance, 0);
    }
}
