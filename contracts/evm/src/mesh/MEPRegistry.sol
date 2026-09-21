// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "./LifRowCheck.sol";

/// @notice Append-only registry of Model Execution Profiles (one per released fly brain).
///         mep_id is computed on-chain from the pinned fields; an entry is immutable. Every field that a
///         verdict depends on is inside the id, so registration is not a race: a would-be squatter can only
///         register the profile everyone else would have derived. `weightsDA` is outside the id -- it is a
///         location hint for bytes that `modelId` already content-addresses, not a consensus input.
///         A profile may also be registered under TERMS (a beneficiary and its share of every settled fee). The terms
///         wrap the profile id, so they are inside the id too and the sentence above still holds.
contract MEPRegistry is IMEPRegistry {
    mapping(bytes32 => MEP) internal meps;
    mapping(bytes32 => bool) public exists;
    mapping(bytes32 => bytes32) public baseOf;
    struct Terms { address beneficiary; uint16 royaltyBps; }
    mapping(bytes32 => Terms) internal terms;

    /// @notice int-lif kinds: the weight unit behind an execKind digest, 0 if the digest is not a declared int-lif kind.
    ///         Anybody may declare a unit; the digest is computed here, so a declaration can only say something true.
    ///         The market and the disputes ask this instead of comparing against one compiled-in digest, which is what
    ///         lets a second connectome, counted on another scale, be tasked and disputed without a second contract.
    mapping(bytes32 => uint32) public lifWeightUnit;
    event LifKindDeclared(bytes32 indexed execKind, uint32 wUnitQ16);
    constructor() { declareLifKind(uint32(uint64(LifRowCheck.W_UNIT_Q16))); } // FlyWire's unit: the kind every existing MEP has
    function declareLifKind(uint32 wUnitQ16) public returns (bytes32 kind) {
        require(wUnitQ16 > 0, "unit"); kind = LifRowCheck.execKind(wUnitQ16);
        if (lifWeightUnit[kind] == 0) { lifWeightUnit[kind] = wUnitQ16; emit LifKindDeclared(kind, wUnitQ16); }
    }

    function registerMEP(MEP calldata m) external returns (bytes32 id) { id = _profileId(m); _store(id, m); }

    /// @notice The same profile under terms: `royaltyBps` of every fee settled for a task against this MEP is owed to
    ///         `beneficiary` (`TaskMarket._pay` sets it aside; the beneficiary withdraws). The terms are inside the id, so
    ///         this is no more a race than `registerMEP` is: registering somebody else's brain under your own name makes
    ///         ANOTHER MEP, which nobody is bonded for and no client has a reason to post to, and registering it under
    ///         theirs only saves them the gas. What the rule cannot do is make the bytes scarce -- they are public, and
    ///         a royalty-free twin is one call away. It holds as long as the royalty costs a client less than standing
    ///         up that twin's executors would (their bonds, and a residency claim per epoch each). Price it like that.
    ///         A beneficiary that must follow something transferable (a token's owner) is a contract that forwards.
    function registerMEPWithTerms(MEP calldata m, address beneficiary, uint16 royaltyBps) external returns (bytes32 id) {
        require(beneficiary != address(0) && royaltyBps > 0 && royaltyBps <= 10000, "terms"); // no terms has one spelling: registerMEP
        bytes32 profileId = _profileId(m);
        id = PorwMeshHash.mepIdWithTerms(profileId, beneficiary, royaltyBps);
        _store(id, m);
        terms[id] = Terms(beneficiary, royaltyBps);
        emit MEPTerms(id, profileId, beneficiary, royaltyBps);
    }

    /// @notice Root enrolment association is immutable and part of the ID. This checks execution layout,
    ///         not scientific lineage or ownership of the model bytes.
    function registerDerivedMEP(MEP calldata m, bytes32 baseMepId) external returns (bytes32 id) {
        id = _derivedId(m, baseMepId);
        _store(id, m); baseOf[id] = baseMepId;
        emit MEPBase(id, baseMepId);
    }

    function registerDerivedMEPWithTerms(MEP calldata m, bytes32 baseMepId, address beneficiary, uint16 royaltyBps) external returns (bytes32 id) {
        require(beneficiary != address(0) && royaltyBps > 0 && royaltyBps <= 10000, "terms");
        bytes32 derivedId = _derivedId(m, baseMepId);
        id = PorwMeshHash.mepIdWithTerms(derivedId, beneficiary, royaltyBps);
        _store(id, m); baseOf[id] = baseMepId;
        terms[id] = Terms(beneficiary, royaltyBps);
        emit MEPBase(id, baseMepId);
        emit MEPTerms(id, derivedId, beneficiary, royaltyBps);
    }

    function _derivedId(MEP calldata m, bytes32 baseMepId) internal view returns (bytes32) {
        require(exists[baseMepId], "unknown base");
        require(baseOf[baseMepId] == bytes32(0), "nested base");
        MEP storage b = meps[baseMepId];
        require(m.schemeDigest == b.schemeDigest && m.execKind == b.execKind && m.neurons == b.neurons && m.synapses == b.synapses, "base layout");
        return PorwMeshHash.mepIdWithBase(_profileId(m), baseMepId);
    }

    function termsOf(bytes32 id) external view returns (address beneficiary, uint16 royaltyBps) { Terms storage t = terms[id]; return (t.beneficiary, t.royaltyBps); }

    function _profileId(MEP calldata m) internal pure returns (bytes32) {
        require(m.schemeDigest == SCHEME_SKETCH_TILE_KECCAK_V3, "scheme");
        require(m.neurons > 0 && m.synapses > 0 && m.synapseRoot != bytes32(0), "profile");
        return PorwMeshHash.mepId(m.schemeDigest, m.modelId, m.execKind, m.neurons, m.synapses, m.synapseRoot);
    }
    function _store(bytes32 id, MEP calldata m) internal {
        require(!exists[id], "registered");
        meps[id] = m;
        exists[id] = true;
        emit MEPRegistered(id, m.modelId, m.schemeDigest);
    }

    function claimBinding(bytes32 id) external view returns (bytes32 schemeDigest, bytes32 modelId) {
        MEP storage m = meps[id]; schemeDigest = m.schemeDigest; // every registered MEP carries the (non-zero) scheme digest
        require(schemeDigest != bytes32(0), "unknown mep");
        modelId = m.modelId;
    }

    function getMEP(bytes32 id) external view returns (MEP memory) {
        require(exists[id], "unknown mep");
        return meps[id];
    }
}
