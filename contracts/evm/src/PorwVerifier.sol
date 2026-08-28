// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Blake3} from "./Blake3.sol";

/// @title PoRW `aigg:porw:sketch-tile:v2` dispute-path verifier (benchmark)
/// @notice Faithful EVM port of the scheme's dispute-path math from
/// `subspace-proof-of-residency`: word-granular sketch recomputation, blake3
/// tile Merkle commitments, opening/fraud verification. Semantics are pinned
/// by `conformance/sketch-tile-v2.json`; the signature suite is outside the
/// scheme (ecrecover on EVM). A keccak-Merkle variant is included for gas
/// comparison only — adopting it would be a NEW scheme id.
contract PorwVerifier {
    uint32 internal constant GOLDEN32 = 0x9E3779B9;
    uint256 internal constant TILE_BYTES = 4096;
    uint256 internal constant TILE_WORDS = 1024;

    // ------------------------------------------------------------------
    // Sketch (integer domain, exact port)
    // ------------------------------------------------------------------

    function fmix32(uint32 h) public pure returns (uint32) {
        unchecked {
            h ^= h >> 16;
            h *= 0x85EBCA6B;
            h ^= h >> 13;
            h *= 0xC2B2AE35;
            h ^= h >> 16;
            return h;
        }
    }

    function tileSeed(uint32 slotSeed, uint64 tileIdx) public pure returns (uint32) {
        unchecked {
            return fmix32(fmix32(slotSeed ^ uint32(tileIdx)));
        }
    }

    function wordCoeff(uint32 rTile, uint32 j) public pure returns (uint32) {
        unchecked {
            return fmix32(rTile + j * GOLDEN32) | 1;
        }
    }

    /// Recompute the sketch of one canonical 4 KiB tile:
    /// sum over LE u32 words of coeff(j) * word(j) mod 2^32.
    function sketchTile(uint32 slotSeed, uint64 tileIdx, bytes calldata tile) public pure returns (uint32 acc) {
        require(tile.length == TILE_BYTES, "tile length");
        uint32 rTile = tileSeed(slotSeed, tileIdx);
        unchecked {
            for (uint256 j = 0; j < TILE_WORDS; j++) {
                uint256 o = j * 4;
                uint32 w = uint32(uint8(tile[o])) | (uint32(uint8(tile[o + 1])) << 8)
                    | (uint32(uint8(tile[o + 2])) << 16) | (uint32(uint8(tile[o + 3])) << 24);
                acc += wordCoeff(rTile, uint32(j)) * w;
            }
        }
    }

    // ------------------------------------------------------------------
    // Commitments (blake3, exact port)
    // ------------------------------------------------------------------

    function le64(uint64 x) internal pure returns (bytes memory out) {
        out = new bytes(8);
        unchecked {
            for (uint256 i = 0; i < 8; i++) {
                out[i] = bytes1(uint8(x >> (i * 8)));
            }
        }
    }

    function le32(uint32 x) internal pure returns (bytes memory out) {
        out = new bytes(4);
        unchecked {
            for (uint256 i = 0; i < 4; i++) {
                out[i] = bytes1(uint8(x >> (i * 8)));
            }
        }
    }

    /// blake3(LE64 tile_idx || LE32 s_tile)
    function partialsLeaf(uint64 tileIdx, uint32 sTile) public pure returns (bytes32) {
        return Blake3.hash(bytes.concat(le64(tileIdx), le32(sTile)));
    }

    /// blake3(LE64 tile_idx || tile bytes) — the `R_W` weights leaf.
    function weightsLeaf(uint64 tileIdx, bytes calldata tile) public pure returns (bytes32) {
        require(tile.length == TILE_BYTES, "tile length");
        return Blake3.hash(bytes.concat(le64(tileIdx), tile));
    }

    /// first 4 LE bytes of blake3(global_challenge || device_id)
    function deriveSlotSeed(bytes32 globalChallenge, bytes32 deviceId) public pure returns (uint32) {
        bytes32 h = Blake3.hash(bytes.concat(globalChallenge, deviceId));
        return
            uint32(uint8(h[0])) | (uint32(uint8(h[1])) << 8) | (uint32(uint8(h[2])) << 16) | (uint32(uint8(h[3])) << 24);
    }

    /// Inclusion verification (duplicate-last-padding binary blake3 tree).
    function merkleVerify(bytes32 root, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        public
        pure
        returns (bool)
    {
        bytes32 acc = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            acc = index % 2 == 0 ? Blake3.hash(bytes.concat(acc, proof[i])) : Blake3.hash(bytes.concat(proof[i], acc));
            index /= 2;
        }
        return acc == root;
    }

    /// Inclusion verification against an exact duplicate-last tree shape.
    /// Security entry points use this count-aware form so an inclusion cannot
    /// be replayed with an out-of-range index, a shorter/longer path, or a
    /// non-canonical sibling at a duplicate-last level.
    function merkleVerifyCounted(bytes32 root, bytes32 leaf, uint64 index, uint64 leafCount, bytes32[] calldata proof)
        public
        pure
        returns (bool)
    {
        if (leafCount == 0 || index >= leafCount) return false;

        bytes32 acc = leaf;
        uint64 width = leafCount;
        uint256 proofIndex;
        while (width > 1) {
            if (proofIndex >= proof.length) return false;
            bytes32 sibling = proof[proofIndex];
            if (index % 2 == 0) {
                if (index + 1 == width) {
                    if (sibling != acc) return false;
                    acc = Blake3.hash(bytes.concat(acc, acc));
                } else {
                    acc = Blake3.hash(bytes.concat(acc, sibling));
                }
            } else {
                acc = Blake3.hash(bytes.concat(sibling, acc));
            }
            index /= 2;
            width = width / 2 + width % 2;
            proofIndex++;
        }
        return proofIndex == proof.length && acc == root;
    }

    /// keccak256 variant — gas comparison only (a NEW scheme id if adopted).
    function merkleVerifyKeccak(bytes32 root, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        public
        pure
        returns (bool)
    {
        bytes32 acc = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            acc = index % 2 == 0 ? keccak256(bytes.concat(acc, proof[i])) : keccak256(bytes.concat(proof[i], acc));
            index /= 2;
        }
        return acc == root;
    }

    // ------------------------------------------------------------------
    // Dispute-path entry points (mirror the Rust verifier surface)
    // ------------------------------------------------------------------

    /// `verify_tile_fraud_proof` fast equivalent: the claimed per-tile value
    /// is committed under partials_root, the tile bytes are canonical under
    /// the model root, and the recomputed sketch disagrees. Returns
    /// 0 = Fraud, 1 = NoFraud, 2 = Invalid.
    /// @dev An integration adapter must authenticate `solutionModelId`,
    /// `modelNLeaves`, and `coverageNLeaves` before forwarding them here.
    function verifyTileFraudProof(
        bytes32 partialsRoot,
        uint64 coverageNLeaves,
        bytes32 modelRoot,
        bytes32 solutionModelId,
        uint64 modelNLeaves,
        bytes32 globalChallenge,
        bytes32 deviceId,
        uint64 tileIdx,
        uint32 claimedSTile,
        uint64 partialsIndex,
        bytes32[] calldata partialsProof,
        bytes calldata tileBytes,
        bytes32[] calldata weightsProof
    ) external pure returns (uint8) {
        if (modelRoot != solutionModelId || tileBytes.length != TILE_BYTES) return 2;
        if (!merkleVerifyCounted(
                partialsRoot, partialsLeaf(tileIdx, claimedSTile), partialsIndex, coverageNLeaves, partialsProof
            )) {
            return 2;
        }
        if (!merkleVerifyCounted(modelRoot, weightsLeaf(tileIdx, tileBytes), tileIdx, modelNLeaves, weightsProof)) {
            return 2;
        }
        uint32 slotSeed = deriveSlotSeed(globalChallenge, deviceId);
        uint32 trueSTile = sketchTile(slotSeed, tileIdx, tileBytes);
        return trueSTile == claimedSTile ? 1 : 0;
    }

    /// `verify_opening_response`, Committed arm: the challenged tile's opening.
    function verifyOpeningCommitted(
        bytes32 partialsRoot,
        uint64 nLeaves,
        uint64 challengedTile,
        uint32 sTile,
        uint64 index,
        bytes32[] calldata proof
    ) external pure returns (bool) {
        return merkleVerifyCounted(partialsRoot, partialsLeaf(challengedTile, sTile), index, nLeaves, proof);
    }

    /// `verify_opening_response`, NotCommitted bracketed arm: adjacent
    /// committed leaves strictly bracketing the challenged tile.
    function verifyOpeningNonInclusion(
        bytes32 partialsRoot,
        uint64 nLeaves,
        uint64 challengedTile,
        uint64 leftTile,
        uint32 leftS,
        uint64 leftIndex,
        bytes32[] calldata leftProof,
        uint64 rightTile,
        uint32 rightS,
        uint64 rightIndex,
        bytes32[] calldata rightProof
    ) external pure returns (bool) {
        if (leftIndex == type(uint64).max || leftIndex + 1 != rightIndex) return false;
        if (!(leftTile < challengedTile && challengedTile < rightTile)) return false;
        if (!merkleVerifyCounted(partialsRoot, partialsLeaf(leftTile, leftS), leftIndex, nLeaves, leftProof)) {
            return false;
        }
        return merkleVerifyCounted(partialsRoot, partialsLeaf(rightTile, rightS), rightIndex, nLeaves, rightProof);
    }

    /// `verify_opening_response`, NotCommitted before-first arm: the first
    /// committed leaf is greater than the challenged tile.
    function verifyOpeningNonInclusionBeforeFirst(
        bytes32 partialsRoot,
        uint64 nLeaves,
        uint64 challengedTile,
        uint64 rightTile,
        uint32 rightS,
        uint64 rightIndex,
        bytes32[] calldata rightProof
    ) external pure returns (bool) {
        if (rightIndex != 0 || challengedTile >= rightTile) return false;
        return merkleVerifyCounted(partialsRoot, partialsLeaf(rightTile, rightS), rightIndex, nLeaves, rightProof);
    }

    /// `verify_opening_response`, NotCommitted after-last arm: the last
    /// committed leaf is less than the challenged tile.
    function verifyOpeningNonInclusionAfterLast(
        bytes32 partialsRoot,
        uint64 nLeaves,
        uint64 challengedTile,
        uint64 leftTile,
        uint32 leftS,
        uint64 leftIndex,
        bytes32[] calldata leftProof
    ) external pure returns (bool) {
        if (nLeaves == 0 || leftIndex != nLeaves - 1 || leftTile >= challengedTile) {
            return false;
        }
        return merkleVerifyCounted(partialsRoot, partialsLeaf(leftTile, leftS), leftIndex, nLeaves, leftProof);
    }
}
