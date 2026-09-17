// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @title PoRW mesh settlement interfaces — redundancy / cross-audit for browser instances
/// @notice Design-level interfaces (see contracts/evm/DESIGN-cross-audit.md). Encodings are
///         pinned by the browser node and by test/BrowserClaim.t.sol. Nothing here changes a
///         PoRW scheme id; the stake asset and beacon source are deployment choices.

/// @dev keccak256("aigg:porw:sketch-tile-keccak:v1")
bytes32 constant SCHEME_SKETCH_TILE_KECCAK_V1 = 0x718b2eb3b33a6d18d904363ee1cc2fb797e344af10132ebfd93aef8d5d72e4b4;

library PorwMeshHash {
    /// @dev mep_id = keccak256(abi.encodePacked(schemeDigest, modelId, execKind, steps, clampQ16))
    function mepId(bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 steps, uint32 clampQ16)
        internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(schemeDigest, modelId, execKind, steps, clampQ16)); }

    /// @dev residency claim hash, signed raw by the instance (EIP-712 in wallet deployments)
    function claimHash(
        bytes32 schemeDigest, bytes32 mepId_, bytes32 modelId, bytes32 partialsRoot, uint64 coverageBytes,
        bytes32 challenge, bytes32 deviceId, bytes32 execDigest, uint32 stimulusSeed
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(schemeDigest, mepId_, modelId, partialsRoot, coverageBytes, challenge, deviceId, execDigest, stimulusSeed));
    }

    /// @dev task id = keccak256(mepId ‖ stimulusSeed ‖ nonce)
    function taskId(bytes32 mepId_, uint32 stimulusSeed, bytes32 nonce) internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(mepId_, stimulusSeed, nonce)); }

    /// @dev sortition index j for (beacon, mep, key); the executor is votes[idx % votes.length]
    function sortition(bytes32 beacon, bytes32 mepId_, bytes32 key, uint32 j) internal pure returns (uint256)
    { return uint256(keccak256(abi.encodePacked(beacon, mepId_, key, j))); }
}

interface IMEPRegistry {
    struct MEP {
        bytes32 modelId;      // weights Merkle root (content address of the model)
        bytes32 schemeDigest; // pinned PoRW scheme
        bytes32 execKind;     // keccak256("aigg:exec:int-spmv-q16:v1")
        uint32 steps;
        uint32 clampQ16;
        bytes32 synapseRoot;  // Merkle root over CSR (post-sorted) synapse records — execution disputes
        bytes weightsDA;      // content pointer for the bytes (Greenfield object / DSN piece / CID)
    }
    event MEPRegistered(bytes32 indexed mepId, bytes32 indexed modelId, bytes32 schemeDigest);
    function registerMEP(MEP calldata mep) external returns (bytes32 mepId);
    function getMEP(bytes32 mepId) external view returns (MEP memory);
}

interface IInstanceRegistry {
    event Bonded(address indexed instance, bytes32 indexed mepId, uint256 amount);
    event ExitRequested(address indexed instance, uint64 unlockEpoch);
    event Slashed(address indexed instance, uint256 amount, address beneficiary, bytes32 reason);
    function bond(bytes32[] calldata mepIds) external payable;
    function requestExit() external;
    function finalizeExit() external;
    /// @notice bonded AND has an unchallenged / defended residency claim for epoch-1 on this MEP
    function isEligible(address instance, bytes32 mepId, uint64 epoch) external view returns (bool);
    /// @notice stake-weighted vote list used by sortition (each instance repeated `weight` times)
    function eligibleVotes(bytes32 mepId, uint64 epoch) external view returns (address[] memory);
    function slash(address instance, uint256 amount, address beneficiary, bytes32 reason) external;
}

interface IPoRWClaimManager {
    struct Claim {
        bytes32 mepId;
        bytes32 partialsRoot;
        uint64 coverageBytes;
        bytes32 challenge;   // epoch beacon-derived public challenge
        bytes32 deviceId;
        bytes32 execDigest;
        uint32 stimulusSeed;
    }
    /// @dev tile opening as consumed by PorwVerifier.verifyTileFraudProofKeccak
    struct Opening {
        uint64 tileIdx;
        bytes tile;               // 4096 canonical bytes
        uint32 sTile;             // committed sketch
        uint64 partialsIndex;
        bytes32[] partialsProof;
        bytes32[] weightsProof;
    }
    event ClaimSubmitted(bytes32 indexed claimId, address indexed instance, bytes32 indexed mepId, uint64 epoch);
    event OpeningChallenged(bytes32 indexed claimId, uint64 tileIdx, address challenger);
    event OpeningResolved(bytes32 indexed claimId, uint64 tileIdx, uint8 verdict); // 0 Fraud, 1 NoFraud, 2 Invalid, 3 Timeout
    function submitClaim(Claim calldata claim, bytes calldata signature) external returns (bytes32 claimId);
    function challengeOpening(bytes32 claimId, uint64 tileIdx) external payable;
    function respondOpening(bytes32 claimId, Opening calldata opening) external;
    function claimExpiredChallenge(bytes32 claimId, uint64 tileIdx) external;
}

interface ITaskMarket {
    struct Task { bytes32 mepId; uint32 stimulusSeed; bytes32 inputCommit; uint256 fee; uint64 deadline; uint8 redundancy; }
    struct Result { bytes32 execDigest; bytes32 execRoot; } // execRoot = merkle([actRoot[1..steps]])
    event TaskPosted(bytes32 indexed taskId, bytes32 indexed mepId, uint8 redundancy);
    event ResultSubmitted(bytes32 indexed taskId, address indexed executor, bytes32 execDigest);
    event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors);
    event DisputeOpened(bytes32 indexed taskId, address a, address b);
    function postTask(Task calldata task, bytes32 nonce) external payable returns (bytes32 taskId);
    /// @notice executors = sortition over IInstanceRegistry.eligibleVotes(mepId, epoch); anyone can compute
    function executors(bytes32 taskId) external view returns (address[] memory);
    function submitResult(bytes32 taskId, Result calldata result, bytes calldata signature) external;
    function settle(bytes32 taskId) external;
}

interface IExecutionDisputes {
    /// @dev interactive bisection: step -> neuron -> synapse -> one u64 term recomputed on-chain
    enum Phase { Step, Neuron, Synapse, Resolved }
    event DisputeRound(bytes32 indexed taskId, Phase phase, uint256 lo, uint256 hi);
    event DisputeResolved(bytes32 indexed taskId, address loser, address winner);
    function open(bytes32 taskId, address a, address b) external payable;
    function bisect(bytes32 taskId, uint256 mid, bytes32 commitmentAtMid) external;
    /// @notice final step: one synapse record proof (synapseRoot) + one input activation proof (actRoot[s-1])
    function proveSynapseTerm(
        bytes32 taskId, uint32 post, uint32 pre, uint16 weight, bytes32[] calldata synapseProof,
        uint32 actPre, bytes32[] calldata actProof, uint64 partialBefore, uint64 partialAfter
    ) external;
    function timeout(bytes32 taskId) external;
}
