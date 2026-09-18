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
}
