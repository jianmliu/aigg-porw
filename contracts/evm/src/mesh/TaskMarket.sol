// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "./InstanceRegistry.sol";
import "./PoRWClaimManager.sol";

interface IDisputeOpener { function openDispute(bytes32 taskId, address a, address b) external; }

/// @notice Inference tasks executed redundantly by beacon-sortitioned, bonded instances.
///         Unanimous results settle and pay; any disagreement opens an execution dispute;
///         after resolution the executors agreeing with the winner are paid.
contract TaskMarket is ITaskMarket {
    uint64 public immutable TASK_TIMEOUT;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    PoRWClaimManager public immutable claimManager;
    address public disputes;
    address public owner;

    struct StoredTask { Task t; address client; uint64 epoch; uint64 postedAt; bool exists; bool settled; bool disputed; }
    mapping(bytes32 => StoredTask) public tasks;
    mapping(bytes32 => mapping(address => Result)) internal results;
    mapping(bytes32 => mapping(address => bool)) public submitted;

    constructor(IMEPRegistry m, InstanceRegistry i, PoRWClaimManager cm, uint64 taskTimeout) { meps = m; instances = i; claimManager = cm; TASK_TIMEOUT = taskTimeout; owner = msg.sender; }
    function setDisputes(address d) external { require(msg.sender == owner && disputes == address(0), "set"); disputes = d; }

    function postTask(Task calldata t, bytes32 nonce) external payable returns (bytes32 taskId) {
        require(msg.value == t.fee, "fee");
        require(t.redundancy >= 1, "r");
        meps.getMEP(t.mepId);
        uint64 e = claimManager.currentEpoch();
        require(claimManager.beacon(e) != bytes32(0), "no beacon");
        taskId = PorwMeshHash.taskId(t.mepId, t.stimulusSeed, nonce);
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

    function resultHash(bytes32 taskId, bytes32 execDigest, bytes32 execRoot) public pure returns (bytes32) { return keccak256(abi.encodePacked("porw-result", taskId, execDigest, execRoot)); }
    function resultOf(bytes32 taskId, address who) external view returns (bytes32 execDigest, bytes32 execRoot) { Result storage r = results[taskId][who]; return (r.execDigest, r.execRoot); }
    function taskInfo(bytes32 taskId) external view returns (bytes32 mepId, uint32 stimulusSeed, address client) { StoredTask storage st = tasks[taskId]; return (st.t.mepId, st.t.stimulusSeed, st.client); }

    function submitResult(bytes32 taskId, Result calldata r, bytes calldata signature) external {
        StoredTask storage st = tasks[taskId];
        require(st.exists && !st.settled, "task");
        address signer = _recover(resultHash(taskId, r.execDigest, r.execRoot), signature);
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
    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        return ecrecover(h, v, r, s);
    }
}
