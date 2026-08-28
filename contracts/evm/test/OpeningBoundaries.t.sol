// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PorwVerifier} from "../src/PorwVerifier.sol";

contract OpeningBoundariesTest is Test {
    PorwVerifier internal verifier;

    bytes32 internal constant P0 = 0x910b4292da43be6453db0dd8fdfccef5f670093a1ef4f1eef7982fe164f51f99;
    bytes32 internal constant P1 = 0x7ca8121ed65f31e08a58ff3a28b24d2da5da2e9e6fa854636310090cc9c22510;
    bytes32 internal constant PARTIALS_ROOT = 0x6d322e7e30bea4f71be48d2027d9f7eea180580d01806ae9f09caf75061afb11;
    uint32 internal constant S1 = 853679690;
    uint32 internal constant S3 = 3046284449;

    function setUp() public {
        verifier = new PorwVerifier();
    }

    function proof(bytes32 sibling) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = sibling;
    }

    function callBeforeFirst(uint64 challengedTile, uint64 rightTile, uint32 rightS, uint64 rightIndex)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory result) = address(verifier)
            .staticcall(
                abi.encodeCall(
                    PorwVerifier.verifyOpeningNonInclusionBeforeFirst,
                    (PARTIALS_ROOT, uint64(2), challengedTile, rightTile, rightS, rightIndex, proof(P1))
                )
            );
        return ok && abi.decode(result, (bool));
    }

    function callAfterLast(uint64 challengedTile, uint64 leftTile, uint32 leftS, uint64 leftIndex)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory result) = address(verifier)
            .staticcall(
                abi.encodeCall(
                    PorwVerifier.verifyOpeningNonInclusionAfterLast,
                    (PARTIALS_ROOT, uint64(2), challengedTile, leftTile, leftS, leftIndex, proof(P0))
                )
            );
        return ok && abi.decode(result, (bool));
    }

    function test_authenticatedCommittedOpening() public view {
        assertTrue(verifier.verifyOpeningCommitted(PARTIALS_ROOT, 2, 3, S3, 1, proof(P0)));
    }

    function test_interiorBracketedNonInclusion() public view {
        assertTrue(verifier.verifyOpeningNonInclusion(PARTIALS_ROOT, 2, 2, 1, S1, 0, proof(P1), 3, S3, 1, proof(P0)));
    }

    function test_firstBoundaryNonInclusionHasNoLeftWitness() public view {
        assertTrue(callBeforeFirst(0, 1, S1, 0));
    }

    function test_lastBoundaryNonInclusionHasNoRightWitness() public view {
        assertTrue(callAfterLast(5, 3, S3, 1));
    }

    function test_rejectsUnsortedClaimedNeighbors() public view {
        assertFalse(verifier.verifyOpeningNonInclusion(PARTIALS_ROOT, 2, 2, 3, S3, 0, proof(P1), 1, S1, 1, proof(P0)));
    }

    function test_rejectsDuplicateClaimedNeighbors() public view {
        assertFalse(verifier.verifyOpeningNonInclusion(PARTIALS_ROOT, 2, 2, 1, S1, 0, proof(P1), 1, S1, 1, proof(P0)));
    }

    function test_rejectsNonAdjacentClaimedNeighbors() public view {
        assertFalse(verifier.verifyOpeningNonInclusion(PARTIALS_ROOT, 3, 2, 1, S1, 0, proof(P1), 3, S3, 2, proof(P0)));
    }

    function test_beforeFirstRequiresActualFirstLeaf() public view {
        assertFalse(callBeforeFirst(0, 1, S1, 1));
    }

    function test_afterLastRequiresActualLastLeaf() public view {
        assertFalse(callAfterLast(5, 3, S3, 0));
    }
}
