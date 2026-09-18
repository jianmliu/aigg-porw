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

    struct StoredTask { Task t; address client; uint64 epoch; uint64 postedAt; bool exists; bool settled; bool disputed; }
    mapping(bytes32 => StoredTask) public tasks;
    mapping(bytes32 => mapping(address => Result)) internal results;
    mapping(bytes32 => mapping(address => bool)) public submitted;

    constructor(IMEPRegistry m, InstanceRegistry i, PoRWClaimManager cm, uint64 taskTimeout) { meps = m; instances = i; claimManager = cm; TASK_TIMEOUT = taskTimeout; owner = msg.sender; DOMAIN_SEPARATOR = PorwEIP712.domainSeparator(address(this)); }
    function setDisputes(address d) external { require(msg.sender == owner && disputes == address(0), "set"); disputes = d; }

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
        tasks[taskId] = StoredTask(t, msg.sender, e, uint64(block.number), true, false, false);
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

    /// @notice called by the disputes contract: pay executors agreeing with the winner
    function onDisputeResolved(bytes32 taskId, address loser, address winner) external {
        require(msg.sender == disputes, "disputes");
        StoredTask storage st = tasks[taskId];
        require(st.exists && st.disputed && !st.settled, "task");
        submitted[taskId][loser] = false; // the loser's result no longer counts
        _pay(taskId, executors(taskId), winner);
    }

    function _pay(bytes32 taskId, address[] memory ex, address ref) internal {
        StoredTask storage st = tasks[taskId];
        st.settled = true;
        uint256 agree = 0;
        if (ref != address(0)) for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]] && _same(taskId, ex[i], ref)) agree++;
        if (agree == 0) { (bool ok,) = st.client.call{value: st.t.fee}(""); require(ok, "refund"); emit TaskSettled(taskId, bytes32(0), new address[](0)); return; }
        uint256 share = st.t.fee / agree; address[] memory paid = new address[](agree); uint256 p = 0;
        for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]] && _same(taskId, ex[i], ref)) { paid[p++] = ex[i]; (bool ok,) = ex[i].call{value: share}(""); require(ok, "pay"); }
        emit TaskSettled(taskId, results[taskId][ref].execDigest, paid);
    }

    function _same(bytes32 taskId, address a, address b) internal view returns (bool) { return results[taskId][a].execDigest == results[taskId][b].execDigest && results[taskId][a].execRoot == results[taskId][b].execRoot; }
    function _firstSubmitted(bytes32 taskId, address[] memory ex) internal view returns (uint256) { for (uint256 i = 0; i < ex.length; i++) if (submitted[taskId][ex[i]]) return i; revert("none"); }
    function _isExecutor(bytes32 taskId, address who) internal view returns (bool) { address[] memory ex = executors(taskId); for (uint256 i = 0; i < ex.length; i++) if (ex[i] == who) return true; return false; }
}
