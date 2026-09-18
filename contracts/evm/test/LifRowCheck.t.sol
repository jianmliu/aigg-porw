// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/mesh/LifRowCheck.sol";
import "./fixtures/LifVectors.sol";

/// The on-chain LIF row rule against transition vectors taken from a real node run
/// (state_{s-1}[i], last partial sum) -> state_s[i], and the state leaf encoding.
contract LifRowCheckTest is Test {
    function test_exec_kind_digest_matches_node() public pure { assertEq(LifRowCheck.execKind(), LifVectors.EXEC_KIND, "exec kind"); }
    function test_transition_vectors_every_branch() public pure {
        bool sawStim; bool sawRefr; bool sawSpike; bool sawSub; bool sawNeg;
        for (uint32 j = 0; j < LifVectors.N; j++) {
            LifVectors.Vec memory v = LifVectors.get(j);
            LifRowCheck.State memory got = LifRowCheck.transition(v.before, v.I, v.i, v.step, v.seed);
            assertTrue(LifRowCheck.same(got, v.after_), string.concat("transition ", v.kind));
            assertEq(LifRowCheck.stateLeaf(v.i, v.after_), v.leafAfter, "state leaf");
            bytes32 k = keccak256(bytes(v.kind));
            if (k == keccak256("stim")) sawStim = true; if (k == keccak256("refr")) sawRefr = true; if (k == keccak256("spike")) sawSpike = true; if (k == keccak256("sub")) sawSub = true; if (k == keccak256("neg")) sawNeg = true;
        }
        assertTrue(sawStim && sawRefr && sawSpike && sawSub && sawNeg, "all branches covered");
    }
    function test_tamper_is_detected() public pure {
        LifVectors.Vec memory v = LifVectors.get(0);
        LifRowCheck.State memory got = LifRowCheck.transition(v.before, v.I + 1, v.i, v.step, v.seed);
        // one synapse-count unit more input changes g, hence the state (row check fails for a lied sum)
        assertTrue(!LifRowCheck.same(got, v.after_), "tampered input detected");
        v.after_.count += 1;
        assertTrue(LifRowCheck.stateLeaf(v.i, v.after_) != v.leafAfter, "tampered leaf");
    }

    /// The silence set (flags bit2). Both vectors come from the wasm kernel's run in web/porw-browser/test_lif_silence.mjs
    /// (`--vectors`), which holds the kernel, lif.js and int_lif.py to each other state by state; they are the two cases
    /// where the bit decides the outcome -- without it the first would have integrated its input, the second fired.
    function test_a_silenced_neuron_never_spikes_and_the_bit_persists() public pure {
        // a free neuron with 58 synapses' worth of input: g integrates, v stays 0, no spike, bit2 kept
        LifRowCheck.State memory got = LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 4, 0), 58, 436, 2, 5);
        assertTrue(LifRowCheck.same(got, LifRowCheck.State(0, 1045276, 0, 4, 0)), "silenced free neuron");
        assertEq(LifRowCheck.stateLeaf(436, got), 0x1c4ec522496424dbf942c0ead6f0347ecc013395bf6c433e10d0706edcd69509, "leaf");
        LifRowCheck.State memory free = LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 0, 0), 58, 436, 2, 5);
        assertTrue(free.v != 0, "the same state without the bit integrates: the vector is not vacuous");
        // stimulated AND silenced: silence wins, in a step where the stimulus would have fired
        got = LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 5, 0), 0, 0, 4, 5);
        assertTrue(LifRowCheck.same(got, LifRowCheck.State(0, 0, 0, 5, 0)), "silence wins over the stimulus");
        assertEq(LifRowCheck.stateLeaf(0, got), 0x7a230046df7eed4672528e11a44979bca3319c0f2b05909280481f69abf22525, "leaf");
        assertTrue(LifRowCheck.transition(LifRowCheck.State(0, 0, 0, 1, 0), 0, 0, 4, 5).flags & 2 != 0, "the stimulus alone fires at this step");
        // a silenced neuron cannot be driven over threshold, however large the input
        got = LifRowCheck.transition(LifRowCheck.State(400000, 2000000000, 0, 4, 9), 30000, 7, 3, 5);
        assertTrue(got.flags == 4 && got.v == 0 && got.refr == 0 && got.count == 9, "never fires");
    }
}
