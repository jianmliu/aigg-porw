// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @title PoRW mesh settlement interfaces — redundancy / cross-audit for browser instances
/// @notice Design-level interfaces (see contracts/evm/DESIGN-cross-audit.md). Encodings are
///         pinned by the browser node and by test/BrowserClaim.t.sol. Nothing here changes a
///         PoRW scheme id; the stake asset and beacon source are deployment choices.

/// @dev CSR chunk size for synapse-record leaves (dispute openings)
uint32 constant CSR_CHUNK = 64;
/// @dev keccak256("aigg:porw:sketch-tile-keccak:v1")
bytes32 constant SCHEME_SKETCH_TILE_KECCAK_V1 = 0x718b2eb3b33a6d18d904363ee1cc2fb797e344af10132ebfd93aef8d5d72e4b4;

library PorwMeshHash {
    /// @dev mep_id = keccak256(abi.encodePacked(schemeDigest, modelId, execKind, steps, clampQ16))
    function mepId(bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 steps, uint32 clampQ16)
        internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(schemeDigest, modelId, execKind, steps, clampQ16)); }

    /// @dev residency claim hash — the raw identifier auditors use off-chain; the on-chain signature is
    ///      over the EIP-712 Claim digest (PorwEIP712), signed by the wallet or a delegated session key
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
        uint32 neurons;       // registry metadata pinned at registration (act-tree width)
        uint32 synapses;      // registry metadata pinned at registration (CSR chunk count)
        bytes32 synapseRoot;  // keccak256(csrRoot || rowRoot): csrRoot over keccak(LE32 c || 64 post-sorted records), rowRoot over keccak(LE32 i || LE32 rowStart[i])
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
    /// @dev aggregated path: one Merkle root per (MEP, epoch, aggregator) over claim leaves
    ///      leaf = keccak256(abi.encode(instance, partialsRoot, coverageBytes, deviceId, execDigest, stimulusSeed, keccak256(signature)))
    struct ClaimLeaf { address instance; bytes32 partialsRoot; uint64 coverageBytes; bytes32 deviceId; bytes32 execDigest; uint32 stimulusSeed; bytes signature; }
    event EpochRootPosted(bytes32 indexed mepId, uint64 indexed epoch, address indexed aggregator, bytes32 root, uint64 count);
    event ClaimSubmitted(bytes32 indexed claimId, address indexed instance, bytes32 indexed mepId, uint64 epoch);
    event OpeningChallenged(bytes32 indexed claimId, uint64 tileIdx, address challenger);
    event OpeningResolved(bytes32 indexed claimId, uint64 tileIdx, uint8 verdict); // 0 Fraud, 1 NoFraud, 2 Invalid, 3 Timeout
    function submitClaim(Claim calldata claim, bytes calldata signature) external returns (bytes32 claimId);
    /// @notice aggregated path: anyone posts a root over the epoch's signed claims (off-chain collected); untrusted
    function postEpochRoot(bytes32 mepId, uint64 epoch, bytes32 root, uint64 count) external;
    /// @notice materialize one claim from a posted root: inclusion proof + the leaf; the signature is verified here
    function materializeClaim(bytes32 mepId, uint64 epoch, address aggregator, uint64 index, ClaimLeaf calldata leaf, bytes32[] calldata proof) external returns (bytes32 claimId);
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
    /// @dev interactive bisection: step -> neuron -> synapse -> one term recomputed on-chain.
    ///      `Refine` exists only for execution kinds that commit segment roots (int-lif): the parties
    ///      post the per-step roots of the first differing segment before the neuron bisection.
    enum Phase { Step, Refine, Neuron, Synapse, Resolved }
    event DisputeRound(bytes32 indexed taskId, Phase phase, uint256 lo, uint256 hi);
    event DisputeResolved(bytes32 indexed taskId, address loser, address winner);
    function open(bytes32 taskId, address a, address b) external payable;
    function bisect(bytes32 taskId, uint256 mid, bytes32 commitmentAtMid) external;
    struct RowBounds { uint32 start; bytes32[] startProof; uint32 end; bytes32[] endProof; } // rowStart[i], rowStart[i+1] in rowRoot
    struct ChunkOpening { uint32 c; bytes records; bytes32[] proof; }                          // CSR chunk containing k* (csrRoot)
    /// @notice Step phase: reveal actRoots bound to the party's execRoot
    function revealRoots(bytes32 taskId, bytes32[] calldata actRoots) external;
    /// @notice Neuron phase: post the two children of the party's current node (keccak(l||r) == node)
    function postChildren(bytes32 taskId, bytes32 left, bytes32 right) external;
    /// @notice Row phase: claimed activation (bound to the party's leaf) + CSR-ordered partial sums
    function postRow(bytes32 taskId, uint32 claimedAct, uint64[] calldata sums) external;
    /// @notice Final term: row bounds (rowRoot), the CSR chunk holding k* (csrRoot), the input activation
    ///         act_{s-1}[pre] (agreed root, or the stimulus rule when s == 1); term = w * act in u64;
    ///         exactly one party's sums fail (row length, row check, or the term) and it loses.
    function proveSynapseTerm(bytes32 taskId, uint32 kStar, bytes32 csrRoot, bytes32 rowRoot, RowBounds calldata bounds, ChunkOpening calldata chunk, uint32 actPre, bytes32[] calldata actProof) external;
    function timeout(bytes32 taskId) external;

    // ---- `aigg:exec:int-lif:v1` (segment roots every `stride` = MEP.clampQ16 steps; state leaves) ----
    /// @dev a neuron's state opened against a state root (LifRowCheck.stateLeaf)
    struct StateOpening { int32 v; int32 g; uint16 refr; uint16 flags; uint32 count; bytes32[] proof; }
    struct LifTermProof { uint32 kStar; bytes32 csrRoot; bytes32 rowRoot; RowBounds bounds; ChunkOpening chunk; StateOpening self; StateOpening pre; }
    /// @notice Refine phase: the per-step state roots of the first differing segment; the last must equal the
    ///         party's committed segment root (binding) — the previous segment root (or initStateRoot) is agreed
    function postStepRoots(bytes32 taskId, bytes32[] calldata roots) external;
    /// @notice Row phase (LIF): claimed state (bound to the party's leaf) + CSR-ordered SIGNED partial sums
    function postRowLif(bytes32 taskId, int32 v, int32 g, uint16 refr, uint16 flags, uint32 count, int64[] calldata sums) external;
    /// @notice Final term (LIF): `self` opens state_{s-1}[i*] against the agreed previous root (row check =
    ///         LifRowCheck.transition), `pre` opens state_{s-1}[pre] for the term w * spiked(pre)
    function proveSynapseTermLif(bytes32 taskId, LifTermProof calldata pf) external;
}
