// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "./InstanceRegistry.sol";
import "./PoRWClaimManager.sol";
import "./PorwEIP712.sol";
import "./LifRowCheck.sol";

interface IDisputeOpener { function openDispute(bytes32 taskId, address a, address b) external; }

/// @notice Inference tasks executed redundantly by beacon-sortitioned, bonded instances.
///         Unanimous results settle and pay; any disagreement opens an execution dispute;
///         after resolution the executors agreeing with the winner are paid.
///
///         A settled result is also disputable by somebody who was never sortitioned. Every input to a task is
///         on chain (`taskInfo`, `taskInput`) and every output is published, so re-executing one is
///         permissionless already -- what `challengeResult` adds is *standing*: a deposit buys a non-executor
///         the right to open the same bisection the two executors would have run. One honest replicator is
///         then enough, which is the property a fraud proof is supposed to have and did not.
contract TaskMarket is ITaskMarket {
    /// @notice the largest `bytes32[]` a single dispute round may require a party to post. int-spmv-q16 reveals
    ///         one root per step; int-lif reveals one per SEGMENT and then one per step inside the first
    ///         differing segment, so its two arrays are ceil(steps/commitStride) and commitStride. An unbounded
    ///         task would make the honest party's round physically unpostable and hand the dispute to whoever
    ///         moves second -- which is why this is checked at postTask: the parameters are the client's now.
    ///         512 roots is ~16 KiB of calldata and ~10M gas to store, well inside a BNB Chain block; it admits
    ///         the production shape (5000 int-lif steps at stride 500 -> 10 segments) with room to spare.
    uint32 public constant MAX_ROOTS = 512;
    uint64 public immutable TASK_TIMEOUT;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    PoRWClaimManager public immutable claimManager;
    address public disputes;
    address public owner;
    bytes32 public immutable DOMAIN_SEPARATOR; // EIP-712: results are signed as typed data (wallet or delegated session key)

    struct StoredTask { Task t; address client; uint64 epoch; uint64 postedAt; uint64 settledAt; bool exists; bool settled; bool disputed; bool repudiated; }
    mapping(bytes32 => StoredTask) public tasks;
    mapping(bytes32 => mapping(address => Result)) internal results;
    mapping(bytes32 => mapping(address => bool)) public submitted;

    // ---- challenge by a non-executor ----
    // Set once at wiring time rather than taken in the constructor, like `disputes`: the deposit has to be
    // sized against the gas an honest executor spends defending a full bisection, which is a measurement
    // (`Gas.t.sol`), not a number known when this contract is written. `challengeWindow == 0` means the
    // feature is off, so a deployment that forgets the call fails safe instead of accepting free challenges.
    uint256 public challengeDepositWei;
    uint64 public challengeWindow;
    address public challengeSink; // receives the half of a lost challenge's deposit the defender does not get
    mapping(bytes32 => address) public challenger;
    mapping(bytes32 => uint256) public challengeDeposit;
    /// @notice the executor whose result the task settled on, recorded AT settle. A challenge disputes this address, not
    ///         whatever the live roster says later: `requestExit` takes an instance off `executors()` at once while its
    ///         bond stays slashable for EXIT_DELAY, so a roster lookup let liars that asked to exit escape every challenge.
    mapping(bytes32 => address) public settledRef;
    /// @notice the executor a successful challenge beat; `ExecutionDisputes.slashAgreeing` compares against its result
    mapping(bytes32 => address) public repudiatedExecutor;
    /// @notice challenges this task has already seen and thrown out. The next one costs twice the last (see challengeResult)
    mapping(bytes32 => uint8) public failedChallenges;
    mapping(bytes32 => uint64) internal challengedAt;
    /// @notice a transfer that the recipient refused. `_pay` may revert and be retried; a dispute resolution
    ///         may not -- a reverting recipient there would leave the dispute permanently unresolvable -- so
    ///         the deposit paths credit instead of reverting.
    mapping(address => uint256) public withdrawable;
    /// @notice fees set aside under a MEP's terms and not yet collected, by mepId (`withdrawRoyalty`)
    mapping(bytes32 => uint256) public royalties;
    /// @notice how many executors `_pay` paid for this task, recorded at settle (0: refunded, or not settled). Something
    ///         outside this contract that pays per executed task -- a hosting endowment -- needs the head count, and must
    ///         not take it from `executors()`, which is a live roster.
    mapping(bytes32 => uint8) public paidExecutors;
    event RoyaltyAccrued(bytes32 indexed taskId, bytes32 indexed mepId, uint256 amount);

    constructor(IMEPRegistry m, InstanceRegistry i, PoRWClaimManager cm, uint64 taskTimeout) { meps = m; instances = i; claimManager = cm; TASK_TIMEOUT = taskTimeout; owner = msg.sender; DOMAIN_SEPARATOR = PorwEIP712.domainSeparator(address(this)); }
    function setDisputes(address d) external { require(msg.sender == owner && disputes == address(0), "set"); disputes = d; }
    /// @notice one-shot wiring, as `setDisputes`. The window must stay <= InstanceRegistry.EXIT_DELAY, or a
    ///         liar can settle, exit, and be challenged with nothing left to slash.
    function setChallengeParams(uint256 deposit, uint64 window, address sink) external {
        require(msg.sender == owner && challengeWindow == 0, "set");
        require(window > 0 && window <= instances.EXIT_DELAY(), "window"); // enforced, not just said: see the note above
        require(sink != address(0), "sink");
        challengeDepositWei = deposit; challengeWindow = window; challengeSink = sink;
    }
    /// @notice what the NEXT challenge of this task must deposit: the base, doubled for every challenge already lost on it
    function requiredChallengeDeposit(bytes32 taskId) public view returns (uint256) { uint8 n = failedChallenges[taskId]; return challengeDepositWei << (n > 16 ? 16 : n); }

    function postTask(Task calldata t, bytes32 nonce) external payable returns (bytes32 taskId) {
        require(msg.value == t.fee, "fee");
        require(t.redundancy >= 1, "r");
        require(t.steps >= 1 && t.commitStride >= 1 && t.commitStride <= t.steps, "steps");
        IMEPRegistry.MEP memory m = meps.getMEP(t.mepId);
        if (m.execKind == LifRowCheck.execKind()) {
            require((t.steps + t.commitStride - 1) / t.commitStride <= MAX_ROOTS && t.commitStride <= MAX_ROOTS, "dispute rounds");
        } else {
            require(t.steps <= MAX_ROOTS && t.commitStride == 1, "dispute rounds"); // int-spmv-q16 commits every step
        }
        uint64 e = claimManager.currentEpoch();
        require(claimManager.beacon(e) != bytes32(0), "no beacon");
        taskId = PorwMeshHash.taskId(t, nonce);
        require(!tasks[taskId].exists, "posted");
        tasks[taskId] = StoredTask(t, msg.sender, e, uint64(block.number), 0, true, false, false, false);
        emit TaskPosted(taskId, t.mepId, t.redundancy);
    }

    /// @notice stake-weighted index sortition over the eligible votes of the task's epoch
    function executors(bytes32 taskId) public view returns (address[] memory out) {
        StoredTask storage st = tasks[taskId];
        require(st.exists, "task");
        address[] memory votes = instances.eligibleVotes(st.t.mepId, st.epoch);
        require(votes.length > 0, "no eligible instances");
        bytes32 b = claimManager.beacon(st.epoch);
        address[] memory chosen = new address[](st.t.redundancy);
        uint256 n = 0;
        for (uint32 j = 0; n < st.t.redundancy && j < 64 * uint32(st.t.redundancy); j++) {
            address cand = votes[PorwMeshHash.sortition(b, st.t.mepId, taskId, j) % votes.length];
            bool dup = false;
            for (uint256 k = 0; k < n; k++) if (chosen[k] == cand) { dup = true; break; }
            if (!dup) chosen[n++] = cand;
        }
        out = new address[](n);
        for (uint256 k = 0; k < n; k++) out[k] = chosen[k];
    }

    /// @notice the EIP-712 digest an executor signs for a result
    function resultDigest(bytes32 taskId, bytes32 execDigest, bytes32 execRoot) public view returns (bytes32) { return PorwEIP712.digest(DOMAIN_SEPARATOR, PorwEIP712.resultStructHash(taskId, execDigest, execRoot)); }
    function resultOf(bytes32 taskId, address who) external view returns (bytes32 execDigest, bytes32 execRoot) { Result storage r = results[taskId][who]; return (r.execDigest, r.execRoot); }
    function taskInfo(bytes32 taskId) external view returns (bytes32 mepId, uint32 stimulusSeed, address client, uint32 steps, uint32 commitStride) { StoredTask storage st = tasks[taskId]; return (st.t.mepId, st.t.stimulusSeed, st.client, st.t.steps, st.t.commitStride); }
    /// @notice the state root agreed before step 1 (int-lif: over state_0, which anyone derives from the stimulus set)
    function taskInitStateRoot(bytes32 taskId) external view returns (bytes32) { return tasks[taskId].t.initStateRoot; }

    function submitResult(bytes32 taskId, Result calldata r, bytes calldata signature) external {
        StoredTask storage st = tasks[taskId];
        require(st.exists && !st.settled, "task");
        address signer = instances.resolve(PorwEIP712.recover(resultDigest(taskId, r.execDigest, r.execRoot), signature));
        require(signer != address(0) && _isExecutor(taskId, signer), "not an executor");
        require(!submitted[taskId][signer], "submitted");
        results[taskId][signer] = r; submitted[taskId][signer] = true;
        emit ResultSubmitted(taskId, signer, r.execDigest);
    }

    function settle(bytes32 taskId) external {
        StoredTask storage st = tasks[taskId];
        require(st.exists && !st.settled && !st.disputed, "task");
        address[] memory ex = executors(taskId);
        uint256 have = 0; for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]]) have++;
        require(have == ex.length || block.number > st.postedAt + TASK_TIMEOUT, "waiting");
        // first disagreeing pair opens a dispute; otherwise pay the (agreeing) submitters
        for (uint256 i = 0; i < ex.length; i++) {
            if (!submitted[taskId][ex[i]]) continue;
            for (uint256 j = i + 1; j < ex.length; j++) {
                if (!submitted[taskId][ex[j]]) continue;
                if (results[taskId][ex[i]].execDigest != results[taskId][ex[j]].execDigest || results[taskId][ex[i]].execRoot != results[taskId][ex[j]].execRoot) {
                    st.disputed = true; emit DisputeOpened(taskId, ex[i], ex[j]);
                    IDisputeOpener(disputes).openDispute(taskId, ex[i], ex[j]);
                    return;
                }
            }
        }
        _pay(taskId, ex, have == 0 ? address(0) : ex[_firstSubmitted(taskId, ex)]);
    }

    /// @notice Buy standing to dispute a SETTLED result. The caller must not have submitted a result for this task itself,
    ///         and must post a result that disagrees with the one the task settled on (`settledRef`, recorded at settle).
    ///         `submitted` is deliberately left false for the challenger: `executors()`, `_pay` and `_firstSubmitted` keep
    ///         their meaning, and the only thing that has to see the challenger's result is `resultOf`, which does.
    ///         What this cannot do is claw back the fee: `_pay` ran at `settle` and that transfer is gone. The deterrent
    ///         is the slash; what a win buys is that the digest stops being citable (`repudiated`).
    ///
    ///         A LOST challenge does not close the task. If it did, a liar's accomplice could challenge first -- or
    ///         front-run the honest replicator -- throw the game, and leave the wrong digest unchallengeable for good,
    ///         for the price of gas (the forfeited deposit would land in its partner's pocket). So after a lost challenge
    ///         the task can be challenged again; the clock does not run while a challenge is open, so stalling cannot
    ///         consume the window; half of a forfeited deposit goes to a sink, so a thrown challenge costs the pair
    ///         something; and each further challenge of the same task must deposit twice the last, so holding a task
    ///         "in dispute" forever gets exponentially dear while an honest challenger gets its (larger) deposit back.
    function challengeResult(bytes32 taskId, Result calldata r) external payable {
        StoredTask storage st = tasks[taskId];
        require(st.exists && st.settled && !st.disputed, "task"); // no open dispute, and not a task that settled through one
        require(challengeWindow != 0, "disabled");
        require(block.number <= st.settledAt + challengeWindow, "window");
        require(msg.value >= requiredChallengeDeposit(taskId), "deposit");
        require(!submitted[taskId][msg.sender], "executor");
        address ref = settledRef[taskId]; require(ref != address(0), "none"); // nothing was ever submitted: no result to dispute
        require(results[taskId][ref].execDigest != r.execDigest || results[taskId][ref].execRoot != r.execRoot, "agrees");
        results[taskId][msg.sender] = r;
        challenger[taskId] = msg.sender; challengeDeposit[taskId] = msg.value; challengedAt[taskId] = uint64(block.number);
        st.disputed = true;
        emit ResultChallenged(taskId, msg.sender, r.execDigest);
        emit DisputeOpened(taskId, ref, msg.sender);
        IDisputeOpener(disputes).openDispute(taskId, ref, msg.sender);
    }

    /// @notice called by the disputes contract. Two endings, one function: the pre-settlement one pays the
    ///         executors agreeing with the winner exactly as before, and the post-settlement one settles the
    ///         challenger's deposit. `_pay` is reachable only from the first, which is what the old
    ///         `!st.settled` guard was protecting -- kept here by structure rather than by a blanket require.
    ///         It branches on who the parties are (`challenger`) rather than on `st.settled`, because that is
    ///         the fact being branched on and a flag could in principle be set by another path.
    function onDisputeResolved(bytes32 taskId, address loser, address winner) external {
        require(msg.sender == disputes, "disputes");
        StoredTask storage st = tasks[taskId];
        require(st.exists && st.disputed, "task");
        submitted[taskId][loser] = false; // the loser's result no longer counts

        address c = challenger[taskId];
        if (c == address(0)) {
            require(!st.settled, "settled");
            _pay(taskId, executors(taskId), winner);
            return;
        }
        uint256 dep = challengeDeposit[taskId]; challengeDeposit[taskId] = 0;
        if (loser == c) {
            // the defence is paid, but only half: the other half leaves the pair for good (see challengeResult)
            uint256 toDefender = dep / 2; _send(winner, toDefender); _send(challengeSink, dep - toDefender);
            // ... and the task is challengeable again, with the time this challenge took handed back
            delete results[taskId][c]; challenger[taskId] = address(0); st.disputed = false;
            st.settledAt += uint64(block.number) - challengedAt[taskId];
            if (failedChallenges[taskId] < type(uint8).max) failedChallenges[taskId]++;
            emit ChallengeFailed(taskId, c, winner);
        } else {
            st.repudiated = true; repudiatedExecutor[taskId] = loser;
            emit ResultRepudiated(taskId, loser, results[taskId][c].execDigest);
            _send(c, dep); // deposit back; the slash paid the challenger already
        }
    }

    function _pay(bytes32 taskId, address[] memory ex, address ref) internal {
        StoredTask storage st = tasks[taskId];
        st.settled = true; st.settledAt = uint64(block.number); // the challenge window starts here
        settledRef[taskId] = ref; // who a challenge will dispute, fixed now rather than looked up in a roster that can change
        uint256 agree = 0;
        if (ref != address(0)) for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]] && _same(taskId, ex[i], ref)) agree++;
        if (agree == 0) { (bool ok,) = st.client.call{value: st.t.fee}(""); require(ok, "refund"); emit TaskSettled(taskId, bytes32(0), new address[](0)); return; }
        // the MEP's terms: a share of the fee is set aside for its beneficiary before the executors split the rest. Set
        // aside rather than sent, because a beneficiary that refuses ether must not be able to stop a task from settling.
        (address ben, uint16 bps) = meps.termsOf(st.t.mepId);
        uint256 cut = ben == address(0) ? 0 : st.t.fee * bps / 10000;
        if (cut > 0) { royalties[st.t.mepId] += cut; emit RoyaltyAccrued(taskId, st.t.mepId, cut); }
        paidExecutors[taskId] = uint8(agree); // redundancy is a uint8, so this fits
        uint256 share = (st.t.fee - cut) / agree; address[] memory paid = new address[](agree); uint256 p = 0;
        for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]] && _same(taskId, ex[i], ref)) { paid[p++] = ex[i]; (bool ok,) = ex[i].call{value: share}(""); require(ok, "pay"); }
        emit TaskSettled(taskId, results[taskId][ref].execDigest, paid);
    }

    /// @notice the beneficiary of a MEP collects what its tasks have set aside. Only the beneficiary, and the amount is
    ///         returned: a forwarding contract (one that pays a token's current owner) has to know what arrived and for
    ///         which MEP, which it could not if anybody were able to push the balance at it.
    function withdrawRoyalty(bytes32 mepId) external returns (uint256 amt) {
        (address ben,) = meps.termsOf(mepId); require(msg.sender == ben, "beneficiary");
        amt = royalties[mepId]; require(amt > 0, "nothing"); royalties[mepId] = 0;
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "withdraw");
    }

    function _send(address to, uint256 amt) internal { if (amt == 0) return; (bool ok,) = to.call{value: amt}(""); if (!ok) withdrawable[to] += amt; }
    function withdraw() external { uint256 a = withdrawable[msg.sender]; require(a > 0, "nothing"); withdrawable[msg.sender] = 0; (bool ok,) = msg.sender.call{value: a}(""); require(ok, "withdraw"); }
    function _same(bytes32 taskId, address a, address b) internal view returns (bool) { return results[taskId][a].execDigest == results[taskId][b].execDigest && results[taskId][a].execRoot == results[taskId][b].execRoot; }
    function _firstSubmitted(bytes32 taskId, address[] memory ex) internal view returns (uint256) { for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]]) return i; revert("none"); }
    function _isExecutor(bytes32 taskId, address who) internal view returns (bool) { address[] memory ex = executors(taskId); for (uint256 i = 0; i < ex.length; i++) if (ex[i] == who) return true; return false; }
}
