// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";

/// @notice Append-only registry of Model Execution Profiles (one per released fly brain).
///         mep_id is computed on-chain from the pinned fields; an entry is immutable. Every field that a
///         verdict depends on is inside the id, so registration is not a race: a would-be squatter can only
///         register the profile everyone else would have derived. `weightsDA` is outside the id -- it is a
///         location hint for bytes that `modelId` already content-addresses, not a consensus input.
contract MEPRegistry is IMEPRegistry {
    mapping(bytes32 => MEP) internal meps;
    mapping(bytes32 => bool) public exists;

    function registerMEP(MEP calldata m) external returns (bytes32 id) {
        require(m.schemeDigest == SCHEME_SKETCH_TILE_KECCAK_V2, "scheme");
        require(m.neurons > 0 && m.synapses > 0 && m.synapseRoot != bytes32(0), "profile");
        id = PorwMeshHash.mepId(m.schemeDigest, m.modelId, m.execKind, m.neurons, m.synapses, m.synapseRoot);
        require(!exists[id], "registered");
        meps[id] = m;
        exists[id] = true;
        emit MEPRegistered(id, m.modelId, m.schemeDigest);
    }

    function getMEP(bytes32 id) external view returns (MEP memory) {
        require(exists[id], "unknown mep");
        return meps[id];
    }
}
