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
import { MeshFixtures as FX } from "./fixtures/MeshFixtures.sol";

/// What one task costs on chain, honest path: postTask + one submitResult per executor + settle. This is the number a
/// dataset of millions of runs has to be set against, and the baseline a batched task is measured from.
///
/// Run with `forge test --match-contract TaskGas --isolate -vv`. `--isolate` makes every top-level call its own
/// transaction, so storage is cold where it would be cold and refunds are applied where they would be; without it the
/// numbers are those of one long transaction and are too low. Each figure is execution gas (`vm.lastCallGas`) plus the
/// intrinsic 21,000 and the calldata (16 per non-zero byte, 4 per zero byte), i.e. what a receipt would say.
contract TaskGas is Test {
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm; TaskMarket market; ExecutionDisputes disp;
    uint256 constant N0 = 3; uint256 n; mapping(address => uint256) pkOfAddr; bytes32 plainId; bytes32 termsId; bytes32[] ids;
    receive() external payable {}

    function profile() internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("greenfield://demo") });
    }
    function setUp() public {
        vm.chainId(FX.CHAIN_ID);
        verifier = new PorwVerifierKeccak(); meps = new MEPRegistry(); inst = new InstanceRegistry(1 ether, 20);
        cm = new PoRWClaimManager(meps, inst, verifier, FX.EPOCH_BLOCKS, 10, 0.1 ether, 0.5 ether, IBeacon(address(0)));
        market = new TaskMarket(meps, inst, cm, uint64(50)); disp = new ExecutionDisputes(meps, inst, market, 10, 0.5 ether);
        inst.setClaimManager(address(cm)); inst.setSlasher(address(disp), true); market.setDisputes(address(disp));
        plainId = meps.registerMEP(profile()); termsId = meps.registerMEPWithTerms(profile(), address(0xB0B), 1000);
        ids.push(plainId); ids.push(termsId); vm.deal(address(this), 100 ether);
    }
    /// `count` instances, bonded for both MEPs at one vote each, all eligible in the task epoch
    function enrol(uint256 count) internal {
        n = count;
        for (uint256 k = 0; k < n; k++) { uint256 pk = 0xE100 + k; address a = vm.addr(pk); pkOfAddr[a] = pk; vm.deal(a, 10 ether); vm.prank(a); inst.bond{value: 1 ether}(ids); }
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch();
        for (uint256 k = 0; k < n; k++) { claimFor(0xE100 + k, plainId); claimFor(0xE100 + k, termsId); }
        vm.roll(FX.TASK_EPOCH * FX.EPOCH_BLOCKS); vm.difficulty(FX.TASK_PREVRANDAO); cm.rollEpoch();
    }
    function signed(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
    function claimFor(uint256 pk, bytes32 mepId) internal {
        IPoRWClaimManager.Claim memory c = IPoRWClaimManager.Claim({ mepId: mepId, partialsRoot: keccak256(abi.encode("partials", pk)), coverageBytes: 4096, challenge: cm.epochChallenge(cm.currentEpoch(), mepId) });
        cm.submitClaim(c, signed(pk, cm.claimDigest(c)));
    }
    function pkOf(address a) internal view returns (uint256) { return pkOfAddr[a]; }
    function calldataGas(bytes memory d) internal pure returns (uint256 g) { for (uint256 i = 0; i < d.length; i++) g += d[i] == 0 ? 4 : 16; }
    function receipt(bytes memory data) internal returns (uint256) { return 21000 + calldataGas(data) + vm.lastCallGas().gasTotalUsed; }

    function one(bytes32 mepId, uint8 r, string memory label) internal returns (uint256 total) {
        ITaskMarket.Task memory t = ITaskMarket.Task({ mepId: mepId, stimulusSeed: FX.STIMULUS_SEED, steps: FX.STEPS, commitStride: FX.STRIDE, initStateRoot: FX.TASK_INPUT_COMMIT, fee: 0.01 ether, deadline: FX.TASK_DEADLINE, redundancy: r });
        bytes32 nonce = keccak256(abi.encode(label));
        bytes32 taskId = market.postTask{value: t.fee}(t, nonce); uint256 gPost = receipt(abi.encodeCall(market.postTask, (t, nonce)));
        address[] memory ex = market.executors(taskId); (ITaskMarket.Result memory res,,) = FX.resultA0(); uint256 gSub = 0;
        for (uint256 i = 0; i < ex.length; i++) {
            bytes memory sig = signed(pkOf(ex[i]), market.resultDigest(taskId, res.execDigest, res.execRoot));
            market.submitResult(taskId, res, sig); gSub += receipt(abi.encodeCall(market.submitResult, (taskId, res, sig)));
        }
        market.settle(taskId); uint256 gSettle = receipt(abi.encodeCall(market.settle, (taskId)));
        total = gPost + gSub + gSettle;
        console2.log(label); console2.log("  postTask        ", gPost); console2.log("  submitResult sum", gSub); console2.log("  settle          ", gSettle); console2.log("  TOTAL           ", total);
    }

    function test_gas_of_one_task() public {
        enrol(N0);
        uint256 r1 = one(plainId, 1, "redundancy 1"); uint256 r2 = one(plainId, 2, "redundancy 2"); uint256 r3 = one(plainId, 3, "redundancy 3");
        uint256 t2 = one(termsId, 2, "redundancy 2, MEP with terms (royalty)");
        assertGt(r2, r1); assertGt(r3, r2); assertGt(t2, r2 - 5000, "terms cost at most a few thousand gas");
    }

    /// The same task with more instances enrolled for the brain. `executors()` rebuilds the stake-weighted vote list from
    /// every enrolled instance, and both `submitResult` and `settle` call it, so the cost of a task is linear in how many
    /// nodes host the brain -- the opposite of what a network wants. Measured here so the slope is a number.
    function test_gas_of_one_task_grows_with_the_instances_enrolled() public {
        enrol(30); uint256 t30 = one(plainId, 2, "redundancy 2, 30 instances enrolled");
        console2.log("  per enrolled instance, per task (vs 3 enrolled: 866,810):", (t30 - 866810) / 27);
    }
}
