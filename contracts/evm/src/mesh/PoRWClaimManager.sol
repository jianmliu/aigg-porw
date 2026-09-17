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
///         and posts one Merkle root per (MEP, epoch); an instance `materializeClaim`s its own leaf with an
///         inclusion proof only when it needs on-chain eligibility (tasks) or is challenged. The signature is
///         verified at materialization, so a bad leaf simply cannot be materialized; an aggregator that omits a
///         claim is bypassed by `submitClaim`. Epoch challenge = keccak(beacon[epoch] || mepId); the beacon is
///         recorded once per epoch from an IBeacon provider, or — when none is configured (pilot,
///         chains with a random prevrandao) — from keccak(prevrandao || blockNumber).
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

    struct StoredClaim {
        address instance; bytes32 mepId; uint64 epoch; bytes32 partialsRoot; uint64 coverageBytes;
        bytes32 challenge; bytes32 deviceId; bytes32 execDigest; uint32 stimulusSeed; bool valid; bool exists;
    }
    struct OpenChallenge { address challenger; uint256 deposit; uint64 deadline; bool open; }

    mapping(uint64 => bytes32) public beacon;
    mapping(bytes32 => StoredClaim) public claims;
    mapping(bytes32 => mapping(uint64 => OpenChallenge)) public challenges;
    struct EpochRoot { bytes32 root; uint64 count; }
    mapping(bytes32 => mapping(uint64 => mapping(address => EpochRoot))) public epochRoots; // mepId -> epoch -> aggregator

    constructor(IMEPRegistry m, InstanceRegistry i, PorwVerifierKeccak v, uint64 epochBlocks, uint64 openingWindow, uint256 openingDeposit, uint256 slashAmount, IBeacon beaconProvider_) {
        meps = m; instances = i; verifier = v; EPOCH_BLOCKS = epochBlocks; OPENING_WINDOW = openingWindow; OPENING_DEPOSIT = openingDeposit; SLASH_AMOUNT = slashAmount; beaconProvider = beaconProvider_;
        DOMAIN_SEPARATOR = PorwEIP712.domainSeparator(address(this));
    }
    /// @notice the EIP-712 digest a wallet / session key signs for a claim (schemeDigest and modelId come from the MEP)
    function claimDigest(Claim calldata c) public view returns (bytes32) {
        IMEPRegistry.MEP memory m = meps.getMEP(c.mepId);
        return PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(m.schemeDigest, c.mepId, m.modelId, c.partialsRoot, c.coverageBytes, c.challenge, c.deviceId, c.execDigest, c.stimulusSeed));
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
    function hasValidClaim(address instance, bytes32 mepId, uint64 epoch) external view returns (bool) { StoredClaim storage c = claims[claimIdOf(instance, mepId, epoch)]; return c.exists && c.valid; }

    function submitClaim(Claim calldata c, bytes calldata signature) external returns (bytes32 claimId) {
        uint64 e = currentEpoch();
        require(beacon[e] != bytes32(0), "no beacon");
        require(c.challenge == epochChallenge(e, c.mepId), "challenge");
        IMEPRegistry.MEP memory m = meps.getMEP(c.mepId);
        require(c.coverageBytes > 0 && c.coverageBytes % 4096 == 0, "coverage");
        bytes32 h = PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(m.schemeDigest, c.mepId, m.modelId, c.partialsRoot, c.coverageBytes, c.challenge, c.deviceId, c.execDigest, c.stimulusSeed));
        address instance = instances.resolve(PorwEIP712.recover(h, signature)); // the wallet itself, or its delegated session key
        require(instance != address(0) && instances.isBondedFor(instance, c.mepId), "not bonded");
        claimId = claimIdOf(instance, c.mepId, e);
        require(!claims[claimId].exists, "claimed");
        claims[claimId] = StoredClaim(instance, c.mepId, e, c.partialsRoot, c.coverageBytes, c.challenge, c.deviceId, c.execDigest, c.stimulusSeed, true, true);
        emit ClaimSubmitted(claimId, instance, c.mepId, e);
    }

    // ---- aggregated path ----
    function claimLeafHash(ClaimLeaf calldata l) public pure returns (bytes32) {
        return keccak256(abi.encode(l.instance, l.partialsRoot, l.coverageBytes, l.deviceId, l.execDigest, l.stimulusSeed, keccak256(l.signature)));
    }
    function postEpochRoot(bytes32 mepId, uint64 epoch, bytes32 root, uint64 count) external {
        require(beacon[epoch] != bytes32(0), "no beacon");
        require(root != bytes32(0) && count > 0, "root");
        meps.getMEP(mepId);
        require(epochRoots[mepId][epoch][msg.sender].root == bytes32(0), "posted"); // one root per aggregator per (mep, epoch)
        epochRoots[mepId][epoch][msg.sender] = EpochRoot(root, count);
        emit EpochRootPosted(mepId, epoch, msg.sender, root, count);
    }
    function materializeClaim(bytes32 mepId, uint64 epoch, address aggregator, uint64 index, ClaimLeaf calldata l, bytes32[] calldata proof) external returns (bytes32 claimId) {
        EpochRoot storage er = epochRoots[mepId][epoch][aggregator];
        require(er.root != bytes32(0), "no root");
        require(_verify(er.root, claimLeafHash(l), index, er.count, proof), "not included");
        IMEPRegistry.MEP memory m = meps.getMEP(mepId);
        require(l.coverageBytes > 0 && l.coverageBytes % 4096 == 0, "coverage");
        bytes32 challenge = epochChallenge(epoch, mepId);
        bytes32 h = PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.claimStructHash(m.schemeDigest, mepId, m.modelId, l.partialsRoot, l.coverageBytes, challenge, l.deviceId, l.execDigest, l.stimulusSeed));
        address instance = instances.resolve(PorwEIP712.recover(h, l.signature));
        require(instance != address(0) && instance == l.instance && instances.isBondedFor(instance, mepId), "not bonded");
        claimId = claimIdOf(instance, mepId, epoch);
        require(!claims[claimId].exists, "claimed");
        claims[claimId] = StoredClaim(instance, mepId, epoch, l.partialsRoot, l.coverageBytes, challenge, l.deviceId, l.execDigest, l.stimulusSeed, true, true);
        emit ClaimSubmitted(claimId, instance, mepId, epoch);
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

    function challengeOpening(bytes32 claimId, uint64 tileIdx) external payable {
        StoredClaim storage c = claims[claimId];
        require(c.exists && c.valid, "claim");
        require(tileIdx < c.coverageBytes / 4096, "tile");
        require(msg.value >= OPENING_DEPOSIT, "deposit");
        OpenChallenge storage ch = challenges[claimId][tileIdx];
        require(!ch.open, "open");
        challenges[claimId][tileIdx] = OpenChallenge(msg.sender, msg.value, uint64(block.number) + OPENING_WINDOW, true);
        emit OpeningChallenged(claimId, tileIdx, msg.sender);
    }

    /// @notice anyone may post the opening; the verdict binds the instance (full-coverage claims:
    ///         the partials tree and the weights tree have the same leaf count).
    function respondOpening(bytes32 claimId, Opening calldata o) external {
        StoredClaim storage c = claims[claimId];
        OpenChallenge storage ch = challenges[claimId][o.tileIdx];
        require(c.exists && ch.open && block.number <= ch.deadline, "no open challenge");
        IMEPRegistry.MEP memory m = meps.getMEP(c.mepId);
        uint64 nLeaves = c.coverageBytes / 4096;
        uint8 verdict = verifier.verifyTileFraudProofKeccakCounted(
            c.partialsRoot, nLeaves, m.modelId, nLeaves, c.challenge, c.deviceId,
            o.tileIdx, o.sTile, o.partialsIndex, o.partialsProof, o.tile, o.weightsProof
        );
        require(verdict != 2, "invalid opening"); // the instance may retry before the deadline
        ch.open = false;
        emit OpeningResolved(claimId, o.tileIdx, verdict);
        if (verdict == 0) { _fraud(c, ch); }
        else { (bool ok,) = c.instance.call{value: ch.deposit}(""); require(ok, "pay"); }
    }

    function claimExpiredChallenge(bytes32 claimId, uint64 tileIdx) external {
        StoredClaim storage c = claims[claimId];
        OpenChallenge storage ch = challenges[claimId][tileIdx];
        require(c.exists && ch.open && block.number > ch.deadline, "not expired");
        ch.open = false;
        emit OpeningResolved(claimId, tileIdx, 3);
        _fraud(c, ch);
    }

    function _fraud(StoredClaim storage c, OpenChallenge storage ch) internal {
        c.valid = false;
        instances.slash(c.instance, SLASH_AMOUNT, ch.challenger, "porw:tile-fraud");
        (bool ok,) = ch.challenger.call{value: ch.deposit}(""); require(ok, "refund");
    }

}
