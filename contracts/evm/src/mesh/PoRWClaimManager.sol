// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "../PorwVerifierKeccak.sol";
import "./InstanceRegistry.sol";
import "./PorwEIP712.sol";
import "../interfaces/IBeacon.sol";

/// @notice Per-epoch residency claims for browser instances, with on-chain opening challenges
///         adjudicated by the keccak-scheme tile fraud proof. The honest path is off-chain
///         (beacon-selected auditors sample openings directly); a challenge escalates only on
///         a failed check. Two ways to get a claim on-chain: `submitClaim` (one tx per instance, cheap
///         chains) or the AGGREGATED path — an untrusted aggregator collects the epoch's signed claims off-chain
///         and posts ONE Merkle root per epoch over the claims of every MEP (the leaf carries its mepId, so the cost
///         of the root does not grow with the number of brains); an instance `materializeClaim`s its own leaf with an
///         inclusion proof only when it needs on-chain eligibility (tasks) or is challenged. The signature is
///         verified at materialization, so a bad leaf simply cannot be materialized; an aggregator that omits a
///         claim is bypassed by `submitClaim`. Epoch challenge = keccak(beacon[epoch] || mepId); the beacon is
///         recorded once per epoch from an IBeacon provider, or — when none is configured (pilot,
///         chains with a random prevrandao) — from keccak(prevrandao || blockNumber).
///
///         STORAGE. A claim on-chain is one word: a commitment to (partialsRoot, coverageBytes, deviceId) with the
///         validity flag in its lowest bit. Eligibility reads that word and nothing else. The contents are emitted
///         (`ClaimData`) rather than stored; a challenger passes them back to `challengeOpening`, which checks them
///         against the commitment and only then writes them down — so the six storage slots a claim used to cost
///         every instance, every MEP, every epoch are paid once, by the challenger, on the rare path that needs them.
contract PoRWClaimManager is IPoRWClaimManager {
    uint64 public immutable EPOCH_BLOCKS;
    uint64 public immutable OPENING_WINDOW;
    uint256 public immutable OPENING_DEPOSIT;
    uint256 public immutable SLASH_AMOUNT;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    PorwVerifierKeccak public immutable verifier;
    IBeacon public immutable beaconProvider; // address(0): prevrandao pilot beacon
    bytes32 public immutable DOMAIN_SEPARATOR; // EIP-712: claims are signed as typed data (wallet or delegated session key)

    /// @dev what a tile verdict needs; written by the first challenge against a claim, not by the claim
    struct ChallengedClaim { address instance; bytes32 mepId; uint64 epoch; bytes32 partialsRoot; uint64 coverageBytes; bytes32 deviceId; }
    struct OpenChallenge { address challenger; uint256 deposit; uint64 deadline; bool open; }

    mapping(uint64 => bytes32) public beacon;
    /// @notice claimId -> (keccak(partialsRoot, coverageBytes, deviceId) with bit 0 cleared) | valid. Zero: no such claim.
    mapping(bytes32 => bytes32) public claimRecord;
    /// @notice (epoch + 1) of the instance's most recent valid claim for a MEP; 0: none, or struck down by a fraud verdict.
    ///         One reused word per (instance, MEP), so eligibility over a validity window of any length is a single read.
    mapping(address => mapping(bytes32 => uint64)) public lastValidEpochPlus1;
    mapping(bytes32 => ChallengedClaim) public challenged;
    mapping(bytes32 => mapping(uint64 => OpenChallenge)) public challenges;
    struct EpochRoot { bytes32 root; uint64 count; }
    mapping(uint64 => mapping(address => EpochRoot)) public epochRoots; // epoch -> aggregator (all MEPs in one tree)

    constructor(IMEPRegistry m, InstanceRegistry i, PorwVerifierKeccak v, uint64 epochBlocks, uint64 openingWindow, uint256 openingDeposit, uint256 slashAmount, IBeacon beaconProvider_) {
        meps = m; instances = i; verifier = v; EPOCH_BLOCKS = epochBlocks; OPENING_WINDOW = openingWindow; OPENING_DEPOSIT = openingDeposit; SLASH_AMOUNT = slashAmount; beaconProvider = beaconProvider_;
        DOMAIN_SEPARATOR = PorwEIP712.domainSeparator(address(this));
    }
    /// @notice the EIP-712 digest a wallet / session key signs for a claim (schemeDigest and modelId come from the MEP)
    function claimDigest(Claim calldata c) public view returns (bytes32) {
        (bytes32 scheme, bytes32 modelId) = meps.claimBinding(c.mepId);
        return PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(scheme, c.mepId, modelId, c.partialsRoot, c.coverageBytes, c.challenge, c.deviceId));
    }

    function currentEpoch() public view returns (uint64) { return uint64(block.number) / EPOCH_BLOCKS; }

    /// @notice record this epoch's beacon (once): from the configured provider, else (pilot) from (prevrandao, block.number).
    function rollEpoch() external returns (bytes32 b) {
        uint64 e = currentEpoch();
        require(beacon[e] == bytes32(0), "rolled");
        if (address(beaconProvider) != address(0)) { b = beaconProvider.beaconFor(e); require(b != bytes32(0), "beacon not ready"); }
        else b = keccak256(abi.encodePacked(block.prevrandao, uint256(block.number)));
        beacon[e] = b;
    }

    function epochChallenge(uint64 epoch, bytes32 mepId) public view returns (bytes32) { return keccak256(abi.encodePacked(beacon[epoch], mepId)); }
    function claimIdOf(address instance, bytes32 mepId, uint64 epoch) public pure returns (bytes32) { return keccak256(abi.encodePacked(instance, mepId, epoch)); }
    function hasValidClaim(address instance, bytes32 mepId, uint64 epoch) external view returns (bool) { return uint256(claimRecord[claimIdOf(instance, mepId, epoch)]) & 1 == 1; }
    function claimCommit(bytes32 partialsRoot, uint64 coverageBytes, bytes32 deviceId) public pure returns (bytes32) { return keccak256(abi.encode(partialsRoot, coverageBytes, deviceId)); }
    /// @dev one fresh word per claim; the contents go to the log
    function _record(address instance, bytes32 mepId, uint64 epoch, bytes32 partialsRoot, uint64 coverageBytes, bytes32 deviceId) internal returns (bytes32 claimId) {
        claimId = claimIdOf(instance, mepId, epoch);
        require(claimRecord[claimId] == bytes32(0), "claimed");
        claimRecord[claimId] = claimCommit(partialsRoot, coverageBytes, deviceId) | bytes32(uint256(1));
        if (epoch + 1 > lastValidEpochPlus1[instance][mepId]) lastValidEpochPlus1[instance][mepId] = epoch + 1;
        emit ClaimSubmitted(claimId, instance, mepId, epoch);
        emit ClaimData(claimId, partialsRoot, coverageBytes, deviceId);
    }

    function submitClaim(Claim calldata c, bytes calldata signature) external returns (bytes32 claimId) {
        uint64 e = currentEpoch();
        require(beacon[e] != bytes32(0), "no beacon");
        require(c.challenge == epochChallenge(e, c.mepId), "challenge");
        (bytes32 scheme, bytes32 modelId) = meps.claimBinding(c.mepId);
        require(c.coverageBytes > 0 && c.coverageBytes % 4096 == 0, "coverage");
        bytes32 h = PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(scheme, c.mepId, modelId, c.partialsRoot, c.coverageBytes, c.challenge, c.deviceId));
        address instance = instances.resolve(PorwEIP712.recover(h, signature)); // the wallet itself, or its delegated session key
        require(instance != address(0) && instances.isBondedFor(instance, c.mepId), "not bonded");
        claimId = _record(instance, c.mepId, e, c.partialsRoot, c.coverageBytes, c.deviceId);
    }

    // ---- aggregated path ----
    function claimLeafHash(ClaimLeaf calldata l) public pure returns (bytes32) {
        return keccak256(abi.encode(l.mepId, l.instance, l.partialsRoot, l.coverageBytes, l.deviceId, keccak256(l.signature)));
    }
    /// @notice one root per aggregator per epoch, over the claims of every MEP it serves. The root is untrusted: a leaf
    ///         for an unknown MEP, an unbonded instance or with a bad signature simply cannot be materialized.
    function postEpochRoot(uint64 epoch, bytes32 root, uint64 count) external {
        require(beacon[epoch] != bytes32(0), "no beacon");
        require(root != bytes32(0) && count > 0, "root");
        require(epochRoots[epoch][msg.sender].root == bytes32(0), "posted");
        epochRoots[epoch][msg.sender] = EpochRoot(root, count);
        emit EpochRootPosted(epoch, msg.sender, root, count);
    }
    function materializeClaim(uint64 epoch, address aggregator, uint64 index, ClaimLeaf calldata l, bytes32[] calldata proof) external returns (bytes32 claimId) {
        EpochRoot storage er = epochRoots[epoch][aggregator];
        require(er.root != bytes32(0), "no root");
        require(_verify(er.root, claimLeafHash(l), index, er.count, proof), "not included");
        (bytes32 scheme, bytes32 modelId) = meps.claimBinding(l.mepId);
        require(l.coverageBytes > 0 && l.coverageBytes % 4096 == 0, "coverage");
        bytes32 h = PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(scheme, l.mepId, modelId, l.partialsRoot, l.coverageBytes, epochChallenge(epoch, l.mepId), l.deviceId));
        address instance = instances.resolve(PorwEIP712.recover(h, l.signature));
        require(instance != address(0) && instance == l.instance && instances.isBondedFor(instance, l.mepId), "not bonded");
        claimId = _record(instance, l.mepId, epoch, l.partialsRoot, l.coverageBytes, l.deviceId);
    }
    function _verify(bytes32 root, bytes32 leaf, uint64 index, uint64 count, bytes32[] calldata proof) internal pure returns (bool) {
        if (count == 0 || index >= count) return false;
        bytes32 acc = leaf; uint64 width = count; uint256 pi = 0;
        while (width > 1) {
            if (pi >= proof.length) return false;
            bytes32 sib = proof[pi];
            if (index % 2 == 0) { if (index + 1 == width && sib != acc) return false; acc = keccak256(bytes.concat(acc, sib)); }
            else acc = keccak256(bytes.concat(sib, acc));
            index /= 2; width = width / 2 + width % 2; pi++;
        }
        return pi == proof.length && acc == root;
    }

    /// @notice challenge one tile of a claim. The challenger supplies the claim's contents (from `ClaimData`); they must
    ///         hash to the recorded commitment of a still-valid claim. The first challenge against a claim writes them
    ///         down for `respondOpening`; later ones (other tiles) reuse them.
    function challengeOpening(address instance, bytes32 mepId, uint64 epoch, bytes32 partialsRoot, uint64 coverageBytes, bytes32 deviceId, uint64 tileIdx) external payable returns (bytes32 claimId) {
        claimId = claimIdOf(instance, mepId, epoch);
        require(claimRecord[claimId] == (claimCommit(partialsRoot, coverageBytes, deviceId) | bytes32(uint256(1))), "claim"); // exists, valid, these contents
        require(tileIdx < coverageBytes / 4096, "tile");
        require(msg.value >= OPENING_DEPOSIT, "deposit");
        OpenChallenge storage ch = challenges[claimId][tileIdx];
        require(!ch.open, "open");
        if (challenged[claimId].instance == address(0)) challenged[claimId] = ChallengedClaim(instance, mepId, epoch, partialsRoot, coverageBytes, deviceId);
        challenges[claimId][tileIdx] = OpenChallenge(msg.sender, msg.value, uint64(block.number) + OPENING_WINDOW, true);
        emit OpeningChallenged(claimId, tileIdx, msg.sender);
    }

    /// @notice anyone may post the opening; the verdict binds the instance (full-coverage claims:
    ///         the partials tree and the weights tree have the same leaf count).
    function respondOpening(bytes32 claimId, Opening calldata o) external {
        ChallengedClaim storage c = challenged[claimId];
        OpenChallenge storage ch = challenges[claimId][o.tileIdx];
        require(ch.open && block.number <= ch.deadline, "no open challenge"); // an open challenge implies `challenged[claimId]` is set
        (, bytes32 modelId) = meps.claimBinding(c.mepId);
        uint64 nLeaves = c.coverageBytes / 4096;
        uint8 verdict = verifier.verifyTileFraudProofKeccakCounted(
            c.partialsRoot, nLeaves, modelId, nLeaves, epochChallenge(c.epoch, c.mepId), c.deviceId,
            o.tileIdx, o.sTile, o.partialsIndex, o.partialsProof, o.tile, o.weightsProof
        );
        require(verdict != 2, "invalid opening"); // the instance may retry before the deadline
        ch.open = false;
        emit OpeningResolved(claimId, o.tileIdx, verdict);
        if (verdict == 0) { _fraud(claimId, c, ch); }
        else { (bool ok,) = c.instance.call{value: ch.deposit}(""); require(ok, "pay"); }
    }

    function claimExpiredChallenge(bytes32 claimId, uint64 tileIdx) external {
        ChallengedClaim storage c = challenged[claimId];
        OpenChallenge storage ch = challenges[claimId][tileIdx];
        require(ch.open && block.number > ch.deadline, "not expired");
        ch.open = false;
        emit OpeningResolved(claimId, tileIdx, 3);
        _fraud(claimId, c, ch);
    }

    function _fraud(bytes32 claimId, ChallengedClaim storage c, OpenChallenge storage ch) internal {
        claimRecord[claimId] &= ~bytes32(uint256(1)); // still recorded (cannot be re-claimed), no longer valid
        lastValidEpochPlus1[c.instance][c.mepId] = 0; // a residency fraud voids the standing of every earlier claim too: claim again to be eligible
        instances.slash(c.instance, SLASH_AMOUNT, ch.challenger, "porw:tile-fraud");
        (bool ok,) = ch.challenger.call{value: ch.deposit}(""); require(ok, "refund");
    }

}
