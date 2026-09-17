// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "./PorwVerifier.sol";

/// @notice keccak scheme (aigg:porw:sketch-tile-keccak:v1) — counted Merkle verification and the tile
///         fraud proof used by the settlement contracts. Kept in a separate contract so the released,
///         benchmark-locked PorwVerifier bytecode is untouched. Leaf counts are pinned by the signed
///         coverage, so duplicate-last padding is checked, never trusted.
contract PorwVerifierKeccak is PorwVerifier {
    function partialsLeafKeccak(uint64 tileIdx, uint32 sTile) public pure returns (bytes32) {
        return keccak256(bytes.concat(le64(tileIdx), le32(sTile)));
    }

    function weightsLeafKeccak(uint64 tileIdx, bytes calldata tile) public pure returns (bytes32) {
        require(tile.length == TILE_BYTES, "tile length");
        return keccak256(bytes.concat(le64(tileIdx), tile));
    }

    function deriveSlotSeedKeccak(bytes32 globalChallenge, bytes32 deviceId) public pure returns (uint32) {
        bytes32 h = keccak256(bytes.concat(globalChallenge, deviceId));
        return uint32(uint8(h[0])) | (uint32(uint8(h[1])) << 8) | (uint32(uint8(h[2])) << 16) | (uint32(uint8(h[3])) << 24);
    }

    function merkleVerifyCountedKeccak(bytes32 root, bytes32 leaf, uint64 index, uint64 leafCount, bytes32[] calldata proof)
        public pure returns (bool)
    {
        if (leafCount == 0 || index >= leafCount) return false;
        bytes32 acc = leaf; uint64 width = leafCount; uint256 proofIndex = 0;
        while (width > 1) {
            if (proofIndex >= proof.length) return false;
            bytes32 sibling = proof[proofIndex];
            if (index % 2 == 0) { if (index + 1 == width && sibling != acc) return false; acc = keccak256(bytes.concat(acc, sibling)); }
            else acc = keccak256(bytes.concat(sibling, acc));
            index /= 2; width = width / 2 + width % 2; proofIndex++;
        }
        return proofIndex == proof.length && acc == root;
    }

    /// keccak-scheme tile fraud proof, counted. 0 = Fraud, 1 = NoFraud, 2 = Invalid.
    function verifyTileFraudProofKeccakCounted(
        bytes32 partialsRoot, uint64 coverageNLeaves, bytes32 modelRoot, uint64 modelNLeaves,
        bytes32 globalChallenge, bytes32 deviceId, uint64 tileIdx, uint32 claimedSTile, uint64 partialsIndex,
        bytes32[] calldata partialsProof, bytes calldata tileBytes, bytes32[] calldata weightsProof
    ) external pure returns (uint8) {
        if (tileBytes.length != TILE_BYTES) return 2;
        if (!merkleVerifyCountedKeccak(partialsRoot, partialsLeafKeccak(tileIdx, claimedSTile), partialsIndex, coverageNLeaves, partialsProof)) return 2;
        if (!merkleVerifyCountedKeccak(modelRoot, weightsLeafKeccak(tileIdx, tileBytes), tileIdx, modelNLeaves, weightsProof)) return 2;
        return sketchTile(deriveSlotSeedKeccak(globalChallenge, deviceId), tileIdx, tileBytes) == claimedSTile ? 1 : 0;
    }
}
