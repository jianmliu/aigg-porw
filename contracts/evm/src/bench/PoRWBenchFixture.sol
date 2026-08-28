// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Blake3} from "../Blake3.sol";
import {PorwVerifier} from "../PorwVerifier.sol";

/// @notice Deterministic proof-math fixture shared by Solidity tests and the
/// Anvil transaction benchmark. This is benchmark support code, not a protocol
/// entry point.
abstract contract PoRWBenchFixture {
    uint64 internal constant TILE_IDX = 3;
    uint64 internal constant MODEL_N_LEAVES = 17_000_000;
    uint64 internal constant COVERAGE_N_LEAVES = 2_000_000;
    uint32 internal constant SLOT_SEED = 1_970_174_283;
    bytes32 internal constant CHALLENGE = 0x0909090909090909090909090909090909090909090909090909090909090909;
    bytes32 internal constant DEVICE = 0x0303030303030303030303030303030303030303030303030303030303030303;

    struct FraudFixture {
        bytes tile;
        uint32 trueS;
        bytes32[] weightsProof;
        bytes32[] partialsProof;
        bytes32 modelRoot;
        bytes32 partialsRoot;
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

    function foldRoot(bytes32 leaf, bytes32[] memory proof, uint256 index) internal pure returns (bytes32 acc) {
        acc = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            acc = index % 2 == 0 ? Blake3.hash(bytes.concat(acc, proof[i])) : Blake3.hash(bytes.concat(proof[i], acc));
            index /= 2;
        }
    }

    function buildCanonicalFraudFixture(PorwVerifier verifier) internal view returns (FraudFixture memory fixture) {
        fixture.tile = tileBytes(TILE_IDX);
        fixture.trueS = verifier.sketchTile(SLOT_SEED, TILE_IDX, fixture.tile);

        fixture.weightsProof = new bytes32[](25);
        for (uint256 i = 0; i < fixture.weightsProof.length; i++) {
            fixture.weightsProof[i] = keccak256(abi.encode("w", i));
        }
        fixture.partialsProof = new bytes32[](21);
        for (uint256 i = 0; i < fixture.partialsProof.length; i++) {
            fixture.partialsProof[i] = keccak256(abi.encode("p", i));
        }

        // The committed partial is deliberately wrong, so the full valid
        // proof path deterministically returns Fraud (0).
        fixture.partialsRoot = foldRoot(verifier.partialsLeaf(TILE_IDX, fixture.trueS + 1), fixture.partialsProof, 1);
        fixture.modelRoot = foldRoot(verifier.weightsLeaf(TILE_IDX, fixture.tile), fixture.weightsProof, TILE_IDX);
    }

    function fraudProofCalldata(PorwVerifier verifier, FraudFixture memory fixture)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            PorwVerifier.verifyTileFraudProof,
            (
                fixture.partialsRoot,
                COVERAGE_N_LEAVES,
                fixture.modelRoot,
                fixture.modelRoot,
                MODEL_N_LEAVES,
                CHALLENGE,
                DEVICE,
                TILE_IDX,
                fixture.trueS + 1,
                uint64(1),
                fixture.partialsProof,
                fixture.tile,
                fixture.weightsProof
            )
        );
    }
}
