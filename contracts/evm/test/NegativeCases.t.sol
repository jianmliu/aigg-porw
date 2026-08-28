// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Blake3} from "../src/Blake3.sol";
import {PorwVerifier} from "../src/PorwVerifier.sol";

contract NegativeCasesTest is Test {
    PorwVerifier internal verifier;

    bytes32 internal constant CHALLENGE = 0x0909090909090909090909090909090909090909090909090909090909090909;
    bytes32 internal constant DEVICE = 0x0303030303030303030303030303030303030303030303030303030303030303;
    bytes32 internal constant W0 = 0xc0d19bf1ac67d8498a97d1f250ff925403143a354aed252f79c059936b80c13e;
    bytes32 internal constant W1 = 0x492afa3610c1e6ffe8433d6184a923e0637304f7d6c640f618c0bf9fc5f8a2a0;
    bytes32 internal constant W2 = 0xbd88bc1657d2e7013c2b5ff697c1e026270c229385b59ec23e4273762287729d;
    bytes32 internal constant W3 = 0xe3545a99859a90ef71c2d6caeb46fa84cab7b86697f281f9d6224f7e085f12d6;
    bytes32 internal constant WEIGHTS_ROOT = 0xba938c5ec31b039172f85e94ba4a755c24a1a48c41e972306cc2f8e6d0651b46;
    bytes32 internal constant P0 = 0x910b4292da43be6453db0dd8fdfccef5f670093a1ef4f1eef7982fe164f51f99;
    bytes32 internal constant P1 = 0x7ca8121ed65f31e08a58ff3a28b24d2da5da2e9e6fa854636310090cc9c22510;
    bytes32 internal constant PARTIALS_ROOT = 0x6d322e7e30bea4f71be48d2027d9f7eea180580d01806ae9f09caf75061afb11;
    uint32 internal constant HONEST_S1 = 853679690;
    uint32 internal constant COMMITTED_S3 = 3046284449;

    function setUp() public {
        verifier = new PorwVerifier();
    }

    function tileBytes(uint256 tileIdx) internal pure returns (bytes memory out) {
        out = new bytes(4096);
        unchecked {
            for (uint256 j = 0; j < 4096; j++) {
                uint64 x = uint64((tileIdx * 4096 + j) * 2654435761);
                out[j] = bytes1(uint8((x >> 7) & 0xFF));
            }
        }
    }

    function singletonProof(bytes32 sibling) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = sibling;
    }

    function canonicalWeightsProofForTile1() internal pure returns (bytes32[] memory out) {
        out = new bytes32[](2);
        out[0] = W0;
        out[1] = Blake3.hash(bytes.concat(W2, W3));
    }

    function callFraudVerifier(
        bytes32 modelRoot,
        bytes32 solutionModelId,
        uint64 modelNLeaves,
        uint64 coverageNLeaves,
        uint64 tileIdx,
        uint32 claimedSTile,
        uint64 partialsIndex,
        bytes32[] memory partialsProof,
        bytes memory tile,
        bytes32[] memory weightsProof
    ) internal view returns (bool ok, uint8 verdict) {
        bytes memory result;
        (ok, result) = address(verifier)
            .staticcall(
                abi.encodeCall(
                    PorwVerifier.verifyTileFraudProof,
                    (
                        PARTIALS_ROOT,
                        coverageNLeaves,
                        modelRoot,
                        solutionModelId,
                        modelNLeaves,
                        CHALLENGE,
                        DEVICE,
                        tileIdx,
                        claimedSTile,
                        partialsIndex,
                        partialsProof,
                        tile,
                        weightsProof
                    )
                )
            );
        if (ok) verdict = abi.decode(result, (uint8));
    }

    function test_correctTileReturnsNoFraud() public view {
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT,
            WEIGHTS_ROOT,
            4,
            2,
            1,
            HONEST_S1,
            0,
            singletonProof(P1),
            tileBytes(1),
            canonicalWeightsProofForTile1()
        );
        assertTrue(ok);
        assertEq(verdict, 1);
    }

    function test_mismatchedCommittedSketchReturnsFraud() public view {
        bytes32[] memory weightsProof = new bytes32[](2);
        weightsProof[0] = W2;
        weightsProof[1] = Blake3.hash(bytes.concat(W0, W1));
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT, WEIGHTS_ROOT, 4, 2, 3, COMMITTED_S3, 1, singletonProof(P0), tileBytes(3), weightsProof
        );
        assertTrue(ok);
        assertEq(verdict, 0);
    }

    function test_malformedTileLengthReturnsOnlyInvalid() public view {
        bytes memory malformed = new bytes(4095);
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT,
            WEIGHTS_ROOT,
            4,
            2,
            1,
            HONEST_S1,
            0,
            singletonProof(P1),
            malformed,
            canonicalWeightsProofForTile1()
        );
        assertTrue(ok);
        assertEq(verdict, 2);
    }

    function test_malformedPartialsProofReturnsOnlyInvalid() public view {
        bytes32[] memory malformed = singletonProof(P1);
        malformed[0] = bytes32(uint256(malformed[0]) ^ 1);
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT, WEIGHTS_ROOT, 4, 2, 1, HONEST_S1, 0, malformed, tileBytes(1), canonicalWeightsProofForTile1()
        );
        assertTrue(ok);
        assertEq(verdict, 2);
    }

    function test_malformedWeightsProofReturnsOnlyInvalid() public view {
        bytes32[] memory malformed = canonicalWeightsProofForTile1();
        malformed[0] = bytes32(uint256(malformed[0]) ^ 1);
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT, WEIGHTS_ROOT, 4, 2, 1, HONEST_S1, 0, singletonProof(P1), tileBytes(1), malformed
        );
        assertTrue(ok);
        assertEq(verdict, 2);
    }

    function test_rejectsUnboundModelRoot() public view {
        (bool ok, uint8 verdict) = callFraudVerifier(
            WEIGHTS_ROOT,
            bytes32(uint256(WEIGHTS_ROOT) ^ 1),
            4,
            2,
            1,
            HONEST_S1,
            0,
            singletonProof(P1),
            tileBytes(1),
            canonicalWeightsProofForTile1()
        );
        assertTrue(ok);
        assertEq(verdict, 2);
    }

    function test_rejectsZeroOrWrongTreeCounts() public view {
        (bool zeroCoverageOk, uint8 zeroCoverageVerdict) = callFraudVerifier(
            WEIGHTS_ROOT,
            WEIGHTS_ROOT,
            4,
            0,
            1,
            HONEST_S1,
            0,
            singletonProof(P1),
            tileBytes(1),
            canonicalWeightsProofForTile1()
        );
        assertTrue(zeroCoverageOk);
        assertEq(zeroCoverageVerdict, 2);

        (bool wrongModelOk, uint8 wrongModelVerdict) = callFraudVerifier(
            WEIGHTS_ROOT,
            WEIGHTS_ROOT,
            1,
            2,
            1,
            HONEST_S1,
            0,
            singletonProof(P1),
            tileBytes(1),
            canonicalWeightsProofForTile1()
        );
        assertTrue(wrongModelOk);
        assertEq(wrongModelVerdict, 2);
    }

    function test_committedOpeningRejectsAmbiguousTreeShape() public view {
        bytes32 leaf = verifier.partialsLeaf(3, COMMITTED_S3);
        bytes32[] memory noProof = new bytes32[](0);
        assertFalse(verifier.verifyOpeningCommitted(leaf, 2, 3, COMMITTED_S3, 0, noProof));
    }
}
