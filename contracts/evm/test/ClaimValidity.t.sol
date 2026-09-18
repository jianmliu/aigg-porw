// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PorwVerifierKeccak.sol";
import "../src/interfaces/PorwMesh.sol";
import "../src/mesh/MEPRegistry.sol";
import "../src/mesh/InstanceRegistry.sol";
import "../src/mesh/PoRWClaimManager.sol";
import { MeshFixtures as FX } from "./fixtures/MeshFixtures.sol";

/// The claim validity window: with `claimValidityEpochs = k` a valid claim for epoch e keeps its instance eligible in
/// epochs e+1 .. e+k, so staying eligible costs one materialization every k epochs instead of every epoch. Same fixtures
/// as the aggregated path (claims for epoch 1).
contract ClaimValidityTest is Test {
    using stdStorage for StdStorage;
    PorwVerifierKeccak verifier; MEPRegistry meps; InstanceRegistry inst; PoRWClaimManager cm;
    bytes32 mepId; address A = FX.A; address L = FX.L; address AGG = address(0xA66);
    uint64 constant WINDOW = 10; uint256 constant DEPOSIT = 0.1 ether; uint256 constant SLASH = 0.5 ether;
    receive() external payable {}

    function deploy(uint64 k) internal {
        vm.chainId(FX.CHAIN_ID); verifier = new PorwVerifierKeccak(); meps = new MEPRegistry();
        deployCodeTo("InstanceRegistry.sol:InstanceRegistry", abi.encode(uint256(1 ether), uint64(20)), FX.REGISTRY); inst = InstanceRegistry(FX.REGISTRY);
        deployCodeTo("PoRWClaimManager.sol:PoRWClaimManager", abi.encode(meps, inst, verifier, FX.EPOCH_BLOCKS, WINDOW, DEPOSIT, SLASH, address(0)), FX.CLAIM_MANAGER); cm = PoRWClaimManager(FX.CLAIM_MANAGER);
        if (k == 0) inst.setClaimManager(address(cm)); else inst.setClaimManager(address(cm), k);
        mepId = meps.registerMEP(IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: FX.EXEC_KIND, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("gnfd://aigg-brains/demo") }));
        bytes32[] memory ids = new bytes32[](1); ids[0] = mepId;
        for (uint256 i = 0; i < 2; i++) { address who = i == 0 ? A : L; vm.deal(who, 10 ether); vm.prank(who); inst.bond{value: 2 ether}(ids); }
        { (address ia, address sa, uint64 ea, bytes memory ga) = FX.delegationA(); inst.delegateBySig(ia, sa, ea, ga); }
        { (address il, address sl, uint64 el, bytes memory gl) = FX.delegationL(); inst.delegateBySig(il, sl, el, gl); }
        vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch(); vm.prank(AGG); cm.postEpochRoot(1, FX.AGG_ROOT, FX.AGG_COUNT);
    }
    function materializeA() internal { (uint64 i, IPoRWClaimManager.ClaimLeaf memory l, bytes32[] memory p) = FX.aggLeafA(); cm.materializeClaim(1, AGG, i, l, p); }

    function test_default_is_one_epoch() public {
        deploy(0); assertEq(inst.claimValidityEpochs(), 1); assertFalse(inst.isEligible(A, mepId, 2), "no claim yet");
        materializeA(); assertEq(cm.lastValidEpochPlus1(A, mepId), 2);
        assertTrue(inst.isEligible(A, mepId, 2), "the epoch after the claim"); assertFalse(inst.isEligible(A, mepId, 3), "and no longer");
        assertTrue(inst.isEligible(A, mepId, 1), "a claim for the epoch itself is fresher than one for the epoch before");
    }
    function test_a_window_of_three_epochs() public {
        deploy(3); materializeA();
        for (uint64 e = 1; e <= 4; e++) assertTrue(inst.isEligible(A, mepId, e), "eligible through epoch 1 + 3");
        assertFalse(inst.isEligible(A, mepId, 5), "then the claim has aged out"); assertFalse(inst.isEligible(L, mepId, 2), "an instance that never claimed is never eligible");
        address[] memory v = inst.eligibleVotes(mepId, 4); assertEq(v.length, 2, "A's two votes, nobody else"); assertEq(inst.eligibleVotes(mepId, 5).length, 0);
    }
    function test_a_fraud_verdict_ends_the_standing_at_once() public {
        deploy(3); (uint64 i, IPoRWClaimManager.ClaimLeaf memory l, bytes32[] memory p) = FX.aggLeafL(); cm.materializeClaim(1, AGG, i, l, p);
        assertTrue(inst.isEligible(L, mepId, 3), "the residency liar looks fine until someone looks");
        cm.challengeOpening{value: DEPOSIT}(L, l.mepId, 1, l.partialsRoot, l.coverageBytes, l.deviceId, 7); cm.respondOpening(cm.claimIdOf(L, mepId, 1), FX.openingFraud());
        assertEq(cm.lastValidEpochPlus1(L, mepId), 0); for (uint64 e = 2; e <= 4; e++) assertFalse(inst.isEligible(L, mepId, e), "out for the whole window, not just for one epoch");
    }
    function test_the_window_is_set_once_and_bounded() public {
        deploy(3); vm.expectRevert(bytes("set")); inst.setClaimManager(address(cm), 5);
        InstanceRegistry fresh = new InstanceRegistry(1 ether, 20); vm.expectRevert(bytes("validity")); fresh.setClaimManager(address(cm), 0);
        vm.expectRevert(bytes("validity")); fresh.setClaimManager(address(cm), 65);
    }
    function test_gas_of_a_materialization_in_steady_state() public {
        deploy(3); // an instance that has claimed before: its word is already non-zero, so the write is an update, not a fresh slot
        stdstore.target(address(cm)).sig("lastValidEpochPlus1(address,bytes32)").with_key(A).with_key(mepId).checked_write(uint256(1));
        (uint64 i, IPoRWClaimManager.ClaimLeaf memory l, bytes32[] memory p) = FX.aggLeafA(); uint256 g0 = gasleft(); cm.materializeClaim(1, AGG, i, l, p);
        emit log_named_uint("gas materializeClaim with the instance's word already set (slots warm inside a forge test: a lower bound)", g0 - gasleft());
        assertEq(cm.lastValidEpochPlus1(A, mepId), 2);
    }
}
