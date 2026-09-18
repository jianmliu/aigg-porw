// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @title PoRW mesh settlement interfaces — redundancy / cross-audit for browser instances
/// @notice Design-level interfaces (see contracts/evm/DESIGN-cross-audit.md). Encodings are
///         pinned by the browser node and by test/BrowserClaim.t.sol. Nothing here changes a
///         PoRW scheme id; the stake asset and beacon source are deployment choices.

/// @dev CSR chunk size for synapse-record leaves (dispute openings)
uint32 constant CSR_CHUNK = 64;
/// @dev keccak256("aigg:porw:sketch-tile-keccak:v3")
/// @dev v3 vs v2: the Claim has no `deviceId`. It was self-declared and only varied the sketch seed; the seed is now
///      `deriveSlotSeed(challenge, instance)`, a function of the instance the claim resolves to. That changes the Claim's
///      EIP-712 type, the aggregated leaf and the seed of every sketch, so a v2 claim does not verify under v3 and vice versa.
/// @dev v2 vs v1: a residency claim attests residency only. `execDigest` and `stimulusSeed` are gone from
///      the Claim (nothing ever adjudicated them -- the only verdict that can invalidate a claim is the tile
///      fraud proof, which reads partialsRoot and the model root), and `steps` / the commit stride moved off
///      the MEP onto the Task, where the dispute machinery is the only thing that reads them. The sketch and
///      tile math is unchanged: this is a change of what the mesh signs, not of how bytes are committed.
bytes32 constant SCHEME_SKETCH_TILE_KECCAK_V3 = 0x48bbcf993c40ccbab6c43697518f5ebe860e8ef282390f3519bfd5c212111726;

library PorwMeshHash {
    /// @dev mep_id = keccak256(abi.encodePacked(schemeDigest, modelId, execKind, neurons, synapses, synapseRoot))
    ///      Every field is a function of the model bytes and the execution kind, so two honest registrants
    ///      derive the same id and a front-runner can only register the correct profile. Step count and commit
    ///      stride are NOT here: they are per-task, and folding them in used to split one brain's residency set
    ///      (and its bonds, claims and sortition pool) across every step count anyone wanted to run.
    function mepId(bytes32 schemeDigest, bytes32 modelId, bytes32 execKind, uint32 neurons, uint32 synapses, bytes32 synapseRoot)
        internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(schemeDigest, modelId, execKind, neurons, synapses, synapseRoot)); }

    /// @dev a profile WITH terms: who is owed a share of every fee paid for a task against it, and how much. The terms wrap
    ///      the profile id rather than joining its fields, so a royalty-free profile keeps the id it always had, and the
    ///      terms are inside the id for the reason every other field is: what a settlement depends on is not left to
    ///      whoever registers first. The same brain under other terms is another MEP, with its own bonds and claims.
    function mepIdWithTerms(bytes32 profileId, address beneficiary, uint16 royaltyBps) internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(profileId, beneficiary, royaltyBps)); }

    /// @dev residency claim hash — the raw identifier auditors use off-chain; the on-chain signature is
    ///      over the EIP-712 Claim digest (PorwEIP712), signed by the wallet or a delegated session key
    function claimHash(
        bytes32 schemeDigest, bytes32 mepId_, bytes32 modelId, bytes32 partialsRoot, uint64 coverageBytes,
        bytes32 challenge
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(schemeDigest, mepId_, modelId, partialsRoot, coverageBytes, challenge));
    }

    /// @dev task id binds EVERY parameter of the task, not just (mep, seed, nonce): steps and the commit
    ///      stride live on the Task now, and an id that did not cover them would let anyone front-run a
    ///      client's post with the same (mepId, seed, nonce) and different parameters -- the client's own
    ///      postTask would revert "posted" and the executors would run the squatter's task.
    function taskId(ITaskMarket.Task calldata t, bytes32 nonce) internal pure returns (bytes32)
    { return keccak256(abi.encode(t, nonce)); }

    // ---- batches: one task, many runs of the same brain (TaskMarket.postBatch) ----
    /// @dev A batch is a Task whose `initStateRoot` is the root of its runs and whose `stimulusSeed` is 0: run k is the
    ///      pair (seed_k, initStateRoot_k) -- the stimulus set AND the silence set are both inside state_0 -- under the
    ///      task's steps and stride. The id covers the run count, so a batch is never the single task with the same fields.
    function batchId(ITaskMarket.Task calldata t, uint32 runs, bytes32 nonce) internal pure returns (bytes32)
    { return keccak256(abi.encode(keccak256(abi.encode(t, nonce)), runs)); }
    function runLeaf(uint32 k, uint32 seed, bytes32 initStateRoot) internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(_le32(k), _le32(seed), initStateRoot)); }
    /// @dev what an executor commits to for run k: the run's own execRoot. There is deliberately no per-run digest
    ///      beside it. A digest that the root does not determine is something two parties can disagree about with no
    ///      step to bisect to; the last segment root already commits every neuron's spike count.
    function runResultLeaf(uint32 k, bytes32 execRoot) internal pure returns (bytes32)
    { return keccak256(abi.encodePacked(_le32(k), execRoot)); }
    /// @dev a batch result has ONE degree of freedom, the root of its run results; the digest is a function of it
    function batchDigest(bytes32 execRoot) internal pure returns (bytes32) { return keccak256(abi.encodePacked("aigg:batch:v1", execRoot)); }
    function _le32(uint32 x) private pure returns (bytes4) { return bytes4(uint32((x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24))); }

    /// @dev sortition index j for (beacon, mep, key); the executor is votes[idx % votes.length]
    function sortition(bytes32 beacon, bytes32 mepId_, bytes32 key, uint32 j) internal pure returns (uint256)
    { return uint256(keccak256(abi.encodePacked(beacon, mepId_, key, j))); }
}

interface IMEPRegistry {
    struct MEP {
        bytes32 modelId;      // weights Merkle root (content address of the model)
        bytes32 schemeDigest; // pinned PoRW scheme
        bytes32 execKind;     // keccak256("aigg:exec:int-spmv-q16:v1")
        uint32 neurons;       // act-tree width (bound into mep_id)
        uint32 synapses;      // CSR record count (bound into mep_id)
        bytes32 synapseRoot;  // keccak256(csrRoot || rowRoot): csrRoot over keccak(LE32 c || 64 post-sorted records), rowRoot over keccak(LE32 i || LE32 rowStart[i])
        bytes weightsDA;      // content pointer for the bytes (Greenfield object / DSN piece / CID)
    }
    event MEPRegistered(bytes32 indexed mepId, bytes32 indexed modelId, bytes32 schemeDigest);
    event MEPTerms(bytes32 indexed mepId, bytes32 indexed profileId, address indexed beneficiary, uint16 royaltyBps);
    function registerMEP(MEP calldata mep) external returns (bytes32 mepId);
    /// @notice the same profile under terms: `royaltyBps` of every settled fee is owed to `beneficiary` (TaskMarket)
    function registerMEPWithTerms(MEP calldata mep, address beneficiary, uint16 royaltyBps) external returns (bytes32 mepId);
    /// @notice (0, 0) for a royalty-free MEP -- and for an unknown one: callers that care have checked existence already
    function termsOf(bytes32 mepId) external view returns (address beneficiary, uint16 royaltyBps);
    function getMEP(bytes32 mepId) external view returns (MEP memory);
    /// @notice the two fields a residency claim is signed over; reverts for an unknown MEP. A claim path reads this instead
    ///         of copying the whole profile (with its dynamic `weightsDA`) out of storage.
    function claimBinding(bytes32 mepId) external view returns (bytes32 schemeDigest, bytes32 modelId);
}

interface IInstanceRegistry {
    event Bonded(address indexed instance, bytes32 indexed mepId, uint256 amount);
    event ExitRequested(address indexed instance, uint64 unlockEpoch);
    event Slashed(address indexed instance, uint256 amount, address beneficiary, bytes32 reason);
    function bond(bytes32[] calldata mepIds) external payable;
    /// @notice add to SOMEONE ELSE's bond (a mint that funds its minter's stake, a breeder endowing a child's owner). A payer
    ///         can only increase a bond: exit and withdrawal remain the instance's own calls.
    function bondFor(address instance, bytes32[] calldata mepIds) external payable;
    function requestExit() external;
    function finalizeExit() external;
    /// @notice bonded AND has an unchallenged / defended residency claim for epoch-1 on this MEP
    function isEligible(address instance, bytes32 mepId, uint64 epoch) external view returns (bool);
    /// @notice stake-weighted vote list used by sortition (each instance repeated `weight` times)
    function eligibleVotes(bytes32 mepId, uint64 epoch) external view returns (address[] memory);
    /// @notice how many instances have ever enrolled for the MEP (the list is append-only)
    function enrolled(bytes32 mepId) external view returns (uint256);
    /// @notice one constant-time draw of the stake-weighted sortition; address(0) for a miss (see InstanceRegistry)
    function sortitionPick(bytes32 mepId, uint64 epoch, uint256 len, uint256 h) external view returns (address);
    function slash(address instance, uint256 amount, address beneficiary, bytes32 reason) external;
}

interface IPoRWClaimManager {
    /// @dev residency only: the sketch of every resident tile, committed under a challenge the instance
    ///      cannot choose, bound to its device. No execution artifact appears here because none is ever
    ///      adjudicated -- `respondOpening` decides a tile against partialsRoot and the model root.
    struct Claim {
        bytes32 mepId;
        bytes32 partialsRoot;
        uint64 coverageBytes;
        bytes32 challenge;   // epoch beacon-derived public challenge
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
    /// @dev aggregated path: ONE Merkle root per (epoch, aggregator) over the claim leaves of every MEP
    ///      leaf = keccak256(abi.encode(mepId, instance, partialsRoot, coverageBytes, keccak256(signature)))
    struct ClaimLeaf { bytes32 mepId; address instance; bytes32 partialsRoot; uint64 coverageBytes; bytes signature; }
    event EpochRootPosted(uint64 indexed epoch, address indexed aggregator, bytes32 root, uint64 count);
    /// @dev the claim's contents. The contract keeps only a commitment to them, so this log is where a challenger
    ///      finds what to pass to `challengeOpening`.
    event ClaimData(bytes32 indexed claimId, bytes32 partialsRoot, uint64 coverageBytes);
    event ClaimSubmitted(bytes32 indexed claimId, address indexed instance, bytes32 indexed mepId, uint64 epoch);
    event OpeningChallenged(bytes32 indexed claimId, uint64 tileIdx, address challenger);
    event OpeningResolved(bytes32 indexed claimId, uint64 tileIdx, uint8 verdict); // 0 Fraud, 1 NoFraud, 2 Invalid, 3 Timeout
    function submitClaim(Claim calldata claim, bytes calldata signature) external returns (bytes32 claimId);
    /// @notice aggregated path: anyone posts a root over the epoch's signed claims (off-chain collected); untrusted
    function postEpochRoot(uint64 epoch, bytes32 root, uint64 count) external;
    /// @notice materialize one claim from a posted root: inclusion proof + the leaf; the signature is verified here
    function materializeClaim(uint64 epoch, address aggregator, uint64 index, ClaimLeaf calldata leaf, bytes32[] calldata proof) external returns (bytes32 claimId);
    /// @notice the challenger supplies the claim's contents (from `ClaimData`); they must match the stored commitment
    function challengeOpening(address instance, bytes32 mepId, uint64 epoch, bytes32 partialsRoot, uint64 coverageBytes, uint64 tileIdx) external payable returns (bytes32 claimId);
    function respondOpening(bytes32 claimId, Opening calldata opening) external;
    function claimExpiredChallenge(bytes32 claimId, uint64 tileIdx) external;
}

interface ITaskMarket {
    /// @dev `steps` and `commitStride` are per-task: the dispute machinery is the only thing that reads them,
    ///      and both executors read the same stored Task. `commitStride` is the segment-root granularity for
    ///      int-lif (it was the MEP's misnamed `clampQ16`); int-spmv-q16 commits every step and ignores it.
    struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }
    struct Result { bytes32 execDigest; bytes32 execRoot; } // execRoot = merkle([actRoot[1..steps]])
    event TaskPosted(bytes32 indexed taskId, bytes32 indexed mepId, uint8 redundancy);
    event ResultSubmitted(bytes32 indexed taskId, address indexed executor, bytes32 execDigest);
    event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors);
    event DisputeOpened(bytes32 indexed taskId, address a, address b);
    /// @notice a non-executor put up a deposit and a disagreeing result against a settled task
    event ResultChallenged(bytes32 indexed taskId, address indexed challenger, bytes32 execDigest);
    /// @notice a challenge won: the settled digest is void. The fee it already paid is not clawed back
    event ResultRepudiated(bytes32 indexed taskId, address indexed executor, bytes32 correctDigest);
    /// @notice a challenge lost; the task can be challenged again (for twice the deposit)
    event ChallengeFailed(bytes32 indexed taskId, address indexed challenger, address indexed defender);
    function postTask(Task calldata task, bytes32 nonce) external payable returns (bytes32 taskId);
    /// @notice one task, `runs` runs of the same brain: see PorwMeshHash.batchId. int-lif only
    function postBatch(Task calldata task, uint32 runs, bytes32 nonce) external payable returns (bytes32 taskId);
    /// @notice the executors drawn when the task was posted (IInstanceRegistry.sortitionPick), fixed from then on
    function executors(bytes32 taskId) external view returns (address[] memory);
    function submitResult(bytes32 taskId, Result calldata result, bytes calldata signature) external;
    function settle(bytes32 taskId) external;
    /// @notice anyone who is not an executor may buy standing to dispute a settled result (see the notes on
    ///         `TaskMarket.challengeResult`); returns nothing, the dispute is opened synchronously
    function challengeResult(bytes32 taskId, Result calldata result) external payable;
    /// @notice the challenger of a settled task, or address(0). Also the discriminator resolution branches on
    function challenger(bytes32 taskId) external view returns (address);
}

interface IExecutionDisputes {
    /// @dev interactive bisection: step -> neuron -> synapse -> one term recomputed on-chain.
    ///      `Refine` exists only for execution kinds that commit segment roots (int-lif): the parties
    ///      post the per-step roots of the first differing segment before the neuron bisection.
    ///      `Run` exists only for a BATCH (TaskMarket.postBatch): the parties bisect the tree of per-run results down
    ///      to the first run they disagree on and open it, and from there the dispute is that run's, from `Step`.
    ///      It is last in the enum, not first in the order of play, so that no existing ordinal moves.
    enum Phase { Step, Refine, Neuron, Synapse, Resolved, Run }
    event DisputeRound(bytes32 indexed taskId, Phase phase, uint256 lo, uint256 hi);
    event DisputeResolved(bytes32 indexed taskId, address loser, address winner);
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

    // ---- `aigg:exec:int-lif:v1` (segment roots every `stride` = Task.commitStride steps; state leaves) ----
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
