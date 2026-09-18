// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "./PorwEIP712.sol";

interface IClaimValidity {
    function hasValidClaim(address instance, bytes32 mepId, uint64 epoch) external view returns (bool);
    function lastValidEpochPlus1(address instance, bytes32 mepId) external view returns (uint64);
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

    // ---- session keys: a bonded wallet delegates an ephemeral browser key (EIP-712 Delegation) ----
    bytes32 public immutable DOMAIN_SEPARATOR;
    struct Delegation { address instance; uint64 expiry; }
    mapping(address => Delegation) public delegations; // session -> (instance, expiry block)
    event SessionKeySet(address indexed instance, address indexed session, uint64 expiry);

    constructor(uint256 unit, uint64 exitDelay) { UNIT = unit; EXIT_DELAY = exitDelay; owner = msg.sender; DOMAIN_SEPARATOR = PorwEIP712.domainSeparator(address(this)); }

    function setSessionKey(address session, uint64 expiry) external { _setSession(msg.sender, session, expiry); }
    /// @notice anyone may submit the wallet's signed Delegation (e.g. the tab, through a relayer)
    function delegateBySig(address instance, address session, uint64 expiry, bytes calldata sig) external {
        address signer = PorwEIP712.recover(PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.delegationStructHash(instance, session, expiry)), sig);
        require(signer != address(0) && signer == instance, "delegation sig");
        _setSession(instance, session, expiry);
    }
    function revokeSessionKey(address session) external { require(delegations[session].instance == msg.sender, "not yours"); delete delegations[session]; emit SessionKeySet(msg.sender, session, 0); }
    function _setSession(address instance, address session, uint64 expiry) internal {
        require(session != address(0) && session != instance && bonded[session] == 0, "session");
        require(expiry > block.number, "expired");
        require(delegations[session].instance == address(0) || delegations[session].instance == instance, "taken");
        delegations[session] = Delegation(instance, expiry);
        emit SessionKeySet(instance, session, expiry);
    }
    /// @notice the bonded instance a signer acts for: itself, or the instance that delegated it (unexpired)
    function resolve(address signer) public view returns (address) {
        if (bonded[signer] > 0) return signer;
        Delegation storage d = delegations[signer];
        if (d.instance != address(0) && block.number <= d.expiry) return d.instance;
        return address(0);
    }

    /// @notice how many epochs a valid residency claim keeps its instance eligible. 1 (the default) is "a claim for the
    ///         previous epoch"; k > 1 divides the standing cost of staying eligible by k, at the price of proving residency
    ///         k times less often. Execution is enforced per task regardless, so what a longer window risks is liveness
    ///         (an instance that dropped the model times out on its task), not a wrong result being paid.
    uint64 public claimValidityEpochs = 1;
    function setClaimManager(address cm) external { setClaimManager(cm, 1); }
    function setClaimManager(address cm, uint64 validityEpochs) public { require(msg.sender == owner && claimManager == address(0), "set"); require(validityEpochs >= 1 && validityEpochs <= 64, "validity"); claimManager = cm; slasher[cm] = true; claimValidityEpochs = validityEpochs; }
    function setSlasher(address s, bool ok) external { require(msg.sender == owner, "owner"); slasher[s] = ok; }

    function bond(bytes32[] calldata mepIds) external payable { bondFor(msg.sender, mepIds); }

    /// @notice add `msg.value` to `instance`'s bond and enrol it for `mepIds`. Anyone may pay: a payer can only INCREASE a
    ///         bond -- requestExit / finalizeExit are the instance's own calls, and the money is the instance's from here on.
    ///         That is what lets a mint fund its minter's stake in one transaction, and a breeder endow a child's owner.
    ///         Enrolling someone else costs at least one UNIT: enrolment appends to the per-MEP list every sortition walks,
    ///         and the price of growing it on another's behalf should be a real bond (which the enrolled instance keeps).
    function bondFor(address instance, bytes32[] calldata mepIds) public payable {
        require(msg.value > 0 && instance != address(0), "bond");
        require(exitAt[instance] == 0, "exiting");
        require(instance == msg.sender || mepIds.length == 0 || msg.value >= UNIT, "enrolling another instance takes a UNIT");
        bonded[instance] += msg.value; uint256 w = weightOf(instance);
        for (uint256 i = 0; i < mepIds.length; i++) {
            if (!inMep[mepIds[i]][instance]) { inMep[mepIds[i]][instance] = true; instancesOf[mepIds[i]].push(instance); }
            if (w > weightCap[mepIds[i]]) weightCap[mepIds[i]] = w; // see sortitionPick
            emit Bonded(instance, mepIds[i], msg.value);
        }
        if (mepIds.length == 0) emit Bonded(instance, bytes32(0), msg.value);
    }

    function requestExit() external { require(bonded[msg.sender] > 0 && exitAt[msg.sender] == 0, "exit"); exitAt[msg.sender] = uint64(block.number) + EXIT_DELAY; emit ExitRequested(msg.sender, exitAt[msg.sender]); }

    /// @notice how many open execution disputes name this instance as a party. While it is non-zero the bond cannot leave:
    ///         a dispute takes a dozen rounds, and without this an instance that asked to exit when it settled a lie could
    ///         finalize before the verdict and leave nothing to slash. Every dispute ends (each round has a timeout), and
    ///         ends by releasing its hold, so the hold cannot be used to trap a bond.
    mapping(address => uint256) public disputeHolds;
    function hold(address inst) external { require(slasher[msg.sender], "slasher"); disputeHolds[inst]++; }
    function release(address inst) external { require(slasher[msg.sender], "slasher"); if (disputeHolds[inst] > 0) disputeHolds[inst]--; }

    function finalizeExit() external {
        require(exitAt[msg.sender] != 0 && block.number >= exitAt[msg.sender], "delay");
        require(disputeHolds[msg.sender] == 0, "in dispute");
        uint256 amt = bonded[msg.sender]; bonded[msg.sender] = 0; exitAt[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "pay");
    }

    function weightOf(address inst) public view returns (uint256) { uint256 w = bonded[inst] / UNIT; return w > MAX_WEIGHT ? MAX_WEIGHT : w; }

    function isBondedFor(address inst, bytes32 mepId) public view returns (bool) { return weightOf(inst) > 0 && exitAt[inst] == 0 && inMep[mepId][inst]; }

    function isEligible(address inst, bytes32 mepId, uint64 epoch) public view returns (bool) {
        if (!isBondedFor(inst, mepId)) return false;
        if (epoch == 0 || claimManager == address(0)) return true; // bootstrap epoch: no prior claim can exist
        // the most recent valid claim is at most `claimValidityEpochs` old (a claim for `epoch` itself is fresher still); a
        // fraud verdict zeroes the word, so a caught instance is out until it claims again
        uint64 last = IClaimValidity(claimManager).lastValidEpochPlus1(inst, mepId);
        return last != 0 && last - 1 + claimValidityEpochs >= epoch;
    }

    /// @notice the largest weight anybody has had when bonding for this MEP. It only grows, and it is the denominator of
    ///         the acceptance test below: with every instance at one UNIT it is 1 and every draw is accepted.
    mapping(bytes32 => uint256) public weightCap;
    function enrolled(bytes32 mepId) external view returns (uint256) { return instancesOf[mepId].length; }

    /// @notice One draw of the stake-weighted sortition, in constant time. `h` is the sortition hash: its low half picks
    ///         an ENROLLED instance uniformly (index below `len`, the enrolment count the task fixed when it was posted
    ///         -- the list is append-only, so later enrolments cannot move anybody), its high half accepts it with
    ///         probability weight / weightCap, and it must be eligible for `epoch`. Returns address(0) for a miss. Over
    ///         repeated draws an instance is chosen in proportion to its weight among the eligible ones, which is what
    ///         walking `eligibleVotes` gave -- but that walk read every enrolled instance, on every call, and the market
    ///         made it three times per task: about 55,000 gas per enrolled instance per task (test/TaskGas.t.sol).
    ///         An instance that tops up WITHOUT naming the MEP does not raise the cap, so it is drawn at the cap's
    ///         weight rather than its own: never more than its stake, and naming the MEP once corrects it.
    function sortitionPick(bytes32 mepId, uint64 epoch, uint256 len, uint256 h) external view returns (address cand) {
        cand = instancesOf[mepId][uint128(h) % len];
        uint256 cap = weightCap[mepId];
        if (cap == 0 || (h >> 128) % cap >= weightOf(cand) || !isEligible(cand, mepId, epoch)) return address(0);
    }

    /// @notice stake-weighted vote list (each eligible instance repeated weight times). A view for clients and tests: it
    ///         reads every enrolled instance, which is why the market no longer draws from it.
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
