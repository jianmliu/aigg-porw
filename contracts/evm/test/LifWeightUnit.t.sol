// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PorwVerifierKeccak.sol";
import "../src/interfaces/PorwMesh.sol";
import "../src/mesh/MEPRegistry.sol";
import "../src/mesh/InstanceRegistry.sol";
import "../src/mesh/PoRWClaimManager.sol";
import "../src/mesh/TaskMarket.sol";
import "../src/mesh/LifRowCheck.sol";
import { LifMeshFixtures as FX } from "./fixtures/LifMeshFixtures.sol";

/// The weight unit is a parameter of the int-lif KIND, per connectome. 0.275 mV per synapse (18022) was set on FlyWire's
/// synapse counts; MaleCNS reports about 1.6 times as many for the same connection and, under FlyWire's unit, every
/// stimulus ignites it. Its MEP pins another unit: same rule, same KIND_ID, another digest. The literals here are the
/// ones web/porw-browser/test_lif_wunit.mjs gets from the kernel, lif.js and int_lif.py (`--vectors`).
contract LifWeightUnitTest is Test {
    MEPRegistry meps; uint32 constant WU = 9011;
    bytes32 constant KIND_DEFAULT = 0x0c387b3972c70c927c1f37f69ba2b8183ab1d666641f4aa33f46e6cbeda888d9; bytes32 constant KIND_9011 = 0x4515a6f80f177e7165dd77c6f4a63d187466342e99b3c6977c1c81332ad3cf74;
    function setUp() public { meps = new MEPRegistry(); }

    function test_the_kind_digest_pins_the_unit() public pure {
        assertEq(LifRowCheck.execKind(), KIND_DEFAULT, "the default kind is the digest it always was"); assertEq(LifRowCheck.execKind(18022), KIND_DEFAULT);
        assertEq(LifRowCheck.execKind(WU), KIND_9011, "another unit, another kind: the browser node's digest"); assertEq(KIND_DEFAULT, FX.EXEC_KIND, "and the fixtures' MEP is the default kind");
    }

    function test_the_transition_under_another_unit_is_the_kernels() public pure {
        // neuron 9 at step 2 with 15 inhibitory synapses' worth of input: the unit decides g, and through g, v
        LifRowCheck.State memory got = LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 0, 0), -15, 9, 2, 5, WU);
        assertTrue(LifRowCheck.same(got, LifRowCheck.State(-677, -135165, 0, 0, 0)), "under 9011");
        assertEq(LifRowCheck.stateLeaf(9, got), 0x755626e558f077719aae91042322013afa52a34219dc9511884b69273eec4d3f, "leaf");
        LifRowCheck.State memory dflt = LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 0, 0), -15, 9, 2, 5);
        assertTrue(dflt.v == -1353 && dflt.g == -270330, "under the default unit the same input gives another state");
        assertTrue(LifRowCheck.same(dflt, LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 0, 0), -15, 9, 2, 5, 18022)), "the five-argument form IS the default unit");
    }

    function test_anybody_declares_a_kind_and_can_only_say_something_true() public {
        assertEq(meps.lifWeightUnit(KIND_DEFAULT), 18022, "FlyWire's unit is declared at construction: every existing MEP's kind");
        assertEq(meps.lifWeightUnit(KIND_9011), 0, "an undeclared digest is not an int-lif kind as far as the chain knows");
        vm.prank(address(0xBEEF)); bytes32 k = meps.declareLifKind(WU);
        assertEq(k, KIND_9011, "the digest is computed on chain from the unit"); assertEq(meps.lifWeightUnit(KIND_9011), WU);
        assertEq(meps.declareLifKind(WU), KIND_9011, "idempotent"); vm.expectRevert(bytes("unit")); meps.declareLifKind(0);
        assertEq(meps.lifWeightUnit(keccak256("aigg:exec:int-spmv-q16:v1")), 0);
    }

    function test_the_market_treats_a_declared_kind_as_int_lif_and_an_undeclared_one_not() public {
        vm.chainId(FX.CHAIN_ID); InstanceRegistry inst = new InstanceRegistry(1 ether, 20); PorwVerifierKeccak v = new PorwVerifierKeccak();
        PoRWClaimManager cm = new PoRWClaimManager(meps, inst, v, FX.EPOCH_BLOCKS, 10, 0.1 ether, 0.5 ether, IBeacon(address(0))); TaskMarket market = new TaskMarket(meps, inst, cm, uint64(50));
        inst.setClaimManager(address(cm)); vm.roll(FX.EPOCH_START); vm.difficulty(FX.PREVRANDAO); cm.rollEpoch();
        IMEPRegistry.MEP memory m = IMEPRegistry.MEP({ modelId: FX.MODEL_ID, schemeDigest: FX.SCHEME_DIGEST, execKind: KIND_9011, neurons: FX.NEURONS, synapses: FX.SYNAPSES, synapseRoot: FX.SYNAPSE_ROOT, weightsDA: bytes("gnfd://male") });
        bytes32 id = meps.registerMEP(m); assertTrue(id != FX.MEP_ID, "the same bytes under another unit are another MEP");
        ITaskMarket.Task memory t = ITaskMarket.Task({ mepId: id, stimulusSeed: 0, steps: FX.STEPS, commitStride: FX.STRIDE, initStateRoot: bytes32("runs"), fee: 0, deadline: FX.TASK_DEADLINE, redundancy: 1 });
        vm.expectRevert(bytes("int-lif only")); market.postBatch(t, 4, "n");          // nobody has declared 9011 yet
        meps.declareLifKind(WU);
        vm.expectRevert(bytes("no eligible instances")); market.postBatch(t, 4, "n"); // now it IS int-lif: it gets as far as the draw
        t.commitStride = 1; t.steps = 5000; vm.expectRevert(bytes("dispute rounds")); market.postTask(t, "n"); // and int-lif's bounds on steps / stride apply to it
    }
}
