// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";

interface IClaimValidity {
    function hasValidClaim(address instance, bytes32 mepId, uint64 epoch) external view returns (bool);
}

/// @notice Bonded fly-brain instances. The bond is the deployment's native asset (AI3 on Auto
///         EVM, BNB on BSC). Weight = bond / UNIT (capped) is the instance's number of sortition
///         votes. Eligibility for epoch e = bonded ∧ not exiting ∧ hosts the MEP ∧ valid residency
///         claim for e-1 (from the claim manager). Slashing is restricted to the settlement
///         contracts.
contract InstanceRegistry is IInstanceRegistry {
    uint256 public immutable UNIT;
    uint64 public immutable EXIT_DELAY;
    uint256 public constant MAX_WEIGHT = 16;

    address public owner;
    address public claimManager;
    mapping(address => bool) public slasher;

    mapping(address => uint256) public bonded;
    mapping(address => uint64) public exitAt;
    mapping(bytes32 => address[]) internal instancesOf;
    mapping(bytes32 => mapping(address => bool)) public inMep;

    constructor(uint256 unit, uint64 exitDelay) { UNIT = unit; EXIT_DELAY = exitDelay; owner = msg.sender; }

    function setClaimManager(address cm) external { require(msg.sender == owner && claimManager == address(0), "set"); claimManager = cm; slasher[cm] = true; }
    function setSlasher(address s, bool ok) external { require(msg.sender == owner, "owner"); slasher[s] = ok; }

    function bond(bytes32[] calldata mepIds) external payable {
        require(msg.value > 0, "bond");
        require(exitAt[msg.sender] == 0, "exiting");
        bonded[msg.sender] += msg.value;
        for (uint256 i = 0; i < mepIds.length; i++) {
            if (!inMep[mepIds[i]][msg.sender]) { inMep[mepIds[i]][msg.sender] = true; instancesOf[mepIds[i]].push(msg.sender); }
            emit Bonded(msg.sender, mepIds[i], msg.value);
        }
    }

    function requestExit() external { require(bonded[msg.sender] > 0 && exitAt[msg.sender] == 0, "exit"); exitAt[msg.sender] = uint64(block.number) + EXIT_DELAY; emit ExitRequested(msg.sender, exitAt[msg.sender]); }

    function finalizeExit() external {
        require(exitAt[msg.sender] != 0 && block.number >= exitAt[msg.sender], "delay");
        uint256 amt = bonded[msg.sender]; bonded[msg.sender] = 0; exitAt[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "pay");
    }

    function weightOf(address inst) public view returns (uint256) { uint256 w = bonded[inst] / UNIT; return w > MAX_WEIGHT ? MAX_WEIGHT : w; }

    function isBondedFor(address inst, bytes32 mepId) public view returns (bool) { return weightOf(inst) > 0 && exitAt[inst] == 0 && inMep[mepId][inst]; }

    function isEligible(address inst, bytes32 mepId, uint64 epoch) public view returns (bool) {
        if (!isBondedFor(inst, mepId)) return false;
        if (epoch == 0 || claimManager == address(0)) return true; // bootstrap epoch: no prior claim can exist
        return IClaimValidity(claimManager).hasValidClaim(inst, mepId, epoch - 1);
    }

    /// @notice stake-weighted vote list for sortition (each eligible instance repeated weight times)
    function eligibleVotes(bytes32 mepId, uint64 epoch) external view returns (address[] memory votes) {
        address[] storage all = instancesOf[mepId];
        uint256 total = 0;
        for (uint256 i = 0; i < all.length; i++) if (isEligible(all[i], mepId, epoch)) total += weightOf(all[i]);
        votes = new address[](total);
        uint256 k = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (!isEligible(all[i], mepId, epoch)) continue;
            uint256 w = weightOf(all[i]);
            for (uint256 j = 0; j < w; j++) votes[k++] = all[i];
        }
    }

    function slash(address inst, uint256 amount, address beneficiary, bytes32 reason) external {
        require(slasher[msg.sender], "slasher");
        uint256 amt = amount > bonded[inst] ? bonded[inst] : amount;
        bonded[inst] -= amt;
        emit Slashed(inst, amt, beneficiary, reason);
        if (amt > 0 && beneficiary != address(0)) { (bool ok,) = beneficiary.call{value: amt}(""); require(ok, "pay"); }
    }
}
