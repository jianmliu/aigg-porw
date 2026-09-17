// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice Epoch randomness for the mesh (sortition, challenges, auditors). Chain-specific:
///         PoT BlockRandomness on Auto EVM; prevrandao is NOT random on BNB Smart Chain / opBNB
///         (PoSA sets it to a constant), so those deployments plug in a VRF or a commit-reveal
///         beacon (see the aigg-bnb repository). A beacon must be fixed before the epoch's claims
///         and never controllable by a claimant.
interface IBeacon {
    /// @return b the beacon for `epoch` (zero if not yet available)
    function beaconFor(uint64 epoch) external view returns (bytes32 b);
}
