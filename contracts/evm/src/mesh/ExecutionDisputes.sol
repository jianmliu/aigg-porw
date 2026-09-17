// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "../PorwVerifierKeccak.sol";
import "./InstanceRegistry.sol";
import "./TaskMarket.sol";

/// @notice Interactive execution fraud proof between two executors of the same task:
///   Step   : both reveal actRoots (bound to their execRoot); first differing step s*.
///   Neuron : descend both parties' activation trees for s*: each round every party posts the two
///            children of its current node (bound by keccak(l||r) == node); the contract follows the
///            first differing child down to the leaf i* — the leaf hashes are then bound to the roots.
///   Row    : each party posts its claimed activation (bound to its leaf) and its CSR-ordered partial
///            sums for neuron i*'s incoming range.
///   Term   : anyone proves row bounds (rowRoot), the CSR chunk holding the first divergent position
///            k* (csrRoot), and the input activation act_{s*-1}[pre] (agreed root, or the stimulus rule);
///            the contract recomputes w*act and the party whose sums don't add up loses.
///   Timeouts: a party that doesn't post within ROUND_BLOCKS loses.
contract ExecutionDisputes is IExecutionDisputes {
    uint64 public immutable ROUND_BLOCKS;
    uint256 public immutable SLASH_AMOUNT;
    uint32 public constant MAX_IN_DEGREE = 8192;
    uint32 public constant CLAMP_Q16 = 65536;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    TaskMarket public immutable market;

    struct Party { bytes32 execRoot; bytes32[] actRoots; bool revealed; bytes32 node; bytes32[2] pair; bool posted; bytes32 leaf; uint32 act; uint64[] sums; bool rowPosted; }
    struct Dispute {
        bytes32 mepId; uint32 neurons; uint32 synapses; uint32 steps; uint32 stimulusSeed; bytes32 synapseRoot;
        Phase phase; uint32 step; bytes32 prevRoot; uint32 level; uint32 idx; uint32 neuron;
        uint64 deadline; bool exists; address loser;
    }
    mapping(bytes32 => Dispute) public disputes;
    mapping(bytes32 => mapping(address => Party)) internal parties;
    mapping(bytes32 => address) public partyA;
    mapping(bytes32 => address) public partyB;

    constructor(IMEPRegistry m, InstanceRegistry i, TaskMarket mk, uint64 roundBlocks, uint256 slashAmount) { meps = m; instances = i; market = mk; ROUND_BLOCKS = roundBlocks; SLASH_AMOUNT = slashAmount; }

    // ---- lifecycle ----
    function openDispute(bytes32 taskId, address a, address b) external {
        require(msg.sender == address(market), "market");
        require(!disputes[taskId].exists, "open");
        (bytes32 mepId, uint32 seed,) = market.taskInfo(taskId);
        IMEPRegistry.MEP memory m = meps.getMEP(mepId);
        Dispute storage d = disputes[taskId];
        d.mepId = mepId; d.neurons = m.neurons; d.synapses = m.synapses; d.steps = m.steps; d.stimulusSeed = seed; d.synapseRoot = m.synapseRoot;
        d.phase = Phase.Step; d.exists = true; d.deadline = uint64(block.number) + ROUND_BLOCKS;
        partyA[taskId] = a; partyB[taskId] = b;
        (, parties[taskId][a].execRoot) = market.resultOf(taskId, a);
        (, parties[taskId][b].execRoot) = market.resultOf(taskId, b);
        emit DisputeRound(taskId, Phase.Step, 0, m.steps);
    }
    function open(bytes32, address, address) external payable { revert("use market"); }
    function bisect(bytes32, uint256, bytes32) external pure { revert("use postChildren"); }

    function _party(bytes32 taskId) internal view returns (Party storage) { require(msg.sender == partyA[taskId] || msg.sender == partyB[taskId], "party"); return parties[taskId][msg.sender]; }
    function _other(bytes32 taskId, address who) internal view returns (address) { return who == partyA[taskId] ? partyB[taskId] : partyA[taskId]; }

    // ---- Step phase ----
    function revealRoots(bytes32 taskId, bytes32[] calldata actRoots) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Step, "phase");
        Party storage p = _party(taskId); require(!p.revealed, "revealed");
        require(actRoots.length == d.steps && _rootOf(actRoots) == p.execRoot, "execRoot");
        p.actRoots = actRoots; p.revealed = true;
        Party storage q = parties[taskId][_other(taskId, msg.sender)];
        if (!q.revealed) return;
        uint32 s = 0; while (s < d.steps && p.actRoots[s] == q.actRoots[s]) s++;
        require(s < d.steps, "no divergence"); // identical roots cannot yield different execRoots
        d.step = s + 1; d.prevRoot = s == 0 ? bytes32(0) : p.actRoots[s - 1];
        p.node = p.actRoots[s]; q.node = q.actRoots[s];
        d.level = _levels(d.neurons) - 1; d.idx = 0; d.phase = Phase.Neuron; d.deadline = uint64(block.number) + ROUND_BLOCKS;
        emit DisputeRound(taskId, Phase.Neuron, d.level, 0);
    }

    // ---- Neuron phase: each party posts the children of its current node ----
    function postChildren(bytes32 taskId, bytes32 left, bytes32 right) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Neuron && d.level > 0, "phase");
        Party storage p = _party(taskId); require(!p.posted, "posted");
        uint32 childWidth = _width(d.neurons, d.level - 1);
        if (2 * d.idx + 1 >= childWidth) require(right == left, "single child"); // duplicate-last
        require(keccak256(bytes.concat(left, right)) == p.node, "not children");
        p.pair = [left, right]; p.posted = true;
        Party storage q = parties[taskId][_other(taskId, msg.sender)];
        if (!q.posted) return;
        bool goLeft = p.pair[0] != q.pair[0];
        require(goLeft || p.pair[1] != q.pair[1], "children equal");
        uint32 child = goLeft ? 2 * d.idx : 2 * d.idx + 1;
        p.node = goLeft ? p.pair[0] : p.pair[1]; q.node = goLeft ? q.pair[0] : q.pair[1];
        p.posted = false; q.posted = false; d.idx = child; d.level -= 1; d.deadline = uint64(block.number) + ROUND_BLOCKS;
        if (d.level == 0) { d.neuron = child; p.leaf = p.node; q.leaf = q.node; d.phase = Phase.Synapse; }
        emit DisputeRound(taskId, d.phase, d.level, child);
    }

    // ---- Row phase (inside Phase.Synapse): claimed activation bound to the leaf + partial sums ----
    function postRow(bytes32 taskId, uint32 claimedAct, uint64[] calldata sums) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse, "phase");
        Party storage p = _party(taskId); require(!p.rowPosted, "posted");
        require(keccak256(bytes.concat(_le32(d.neuron), _le32(claimedAct))) == p.leaf, "leaf");
        require(sums.length <= MAX_IN_DEGREE, "in-degree");
        p.act = claimedAct; p.sums = sums; p.rowPosted = true; d.deadline = uint64(block.number) + ROUND_BLOCKS;
    }

    /// @notice final adjudication once both rows are posted (anyone may call with the openings)
    function proveSynapseTerm(bytes32 taskId, uint32 kStar, bytes32 csrRoot, bytes32 rowRoot, RowBounds calldata bounds, ChunkOpening calldata chunk, uint32 actPre, bytes32[] calldata actProof) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse, "phase");
        Party storage a = parties[taskId][partyA[taskId]]; Party storage b = parties[taskId][partyB[taskId]];
        require(a.rowPosted && b.rowPosted, "rows");
        require(keccak256(bytes.concat(csrRoot, rowRoot)) == d.synapseRoot, "synapseRoot");
        uint32 n = d.neurons;
        require(_verify(rowRoot, _leaf32(d.neuron, bounds.start), d.neuron, n + 1, bounds.startProof) && _verify(rowRoot, _leaf32(d.neuron + 1, bounds.end), d.neuron + 1, n + 1, bounds.endProof), "row bounds");
        uint32 len = bounds.end - bounds.start;
        bool lenA = a.sums.length == len; bool lenB = b.sums.length == len;
        if (lenA != lenB) return _resolve(taskId, lenA ? partyB[taskId] : partyA[taskId], "row length");
        require(lenA, "both wrong length");
        bool rowA = _rowOk(a, len); bool rowB = _rowOk(b, len);
        if (rowA != rowB) return _resolve(taskId, rowA ? partyB[taskId] : partyA[taskId], "row check");
        require(rowA, "both rows inconsistent");
        require(kStar >= bounds.start && kStar < bounds.end, "k range");
        uint32 j = kStar - bounds.start;
        require(a.sums[j] != b.sums[j] && (j == 0 || a.sums[j - 1] == b.sums[j - 1]), "not first divergence");
        // synapse record at k* from the opened CSR chunk
        uint32 nChunks = (d.synapses + CSR_CHUNK - 1) / CSR_CHUNK;
        require(chunk.c == kStar / CSR_CHUNK && _verify(csrRoot, keccak256(bytes.concat(_le32(chunk.c), chunk.records)), chunk.c, nChunks, chunk.proof), "chunk");
        uint32 off = (kStar - chunk.c * CSR_CHUNK) * 10;
        require(chunk.records.length >= off + 10, "record");
        (uint32 pre, uint32 post, uint16 w) = _record(chunk.records, off);
        require(post == d.neuron, "record post");
        // input activation
        if (d.step == 1) require(actPre == _stimulus(pre, d.stimulusSeed), "stimulus");
        else require(_verify(d.prevRoot, _leaf32(pre, actPre), pre, n, actProof), "act proof");
        uint64 term = uint64(w) * uint64(actPre);
        bool okA = a.sums[j] == (j == 0 ? 0 : a.sums[j - 1]) + term;
        bool okB = b.sums[j] == (j == 0 ? 0 : b.sums[j - 1]) + term;
        require(okA != okB, "no single loser");
        _resolve(taskId, okA ? partyB[taskId] : partyA[taskId], "term");
    }

    function timeout(bytes32 taskId) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase != Phase.Resolved && block.number > d.deadline, "not expired");
        Party storage a = parties[taskId][partyA[taskId]]; Party storage b = parties[taskId][partyB[taskId]];
        bool aDone; bool bDone;
        if (d.phase == Phase.Step) { aDone = a.revealed; bDone = b.revealed; }
        else if (d.phase == Phase.Neuron) { aDone = a.posted; bDone = b.posted; }
        else { aDone = a.rowPosted; bDone = b.rowPosted; }
        require(aDone != bDone, "both or neither"); // both silent: the dispute simply stalls (no evidence either way)
        _resolve(taskId, aDone ? partyB[taskId] : partyA[taskId], "timeout");
    }

    function _resolve(bytes32 taskId, address loser, string memory) internal {
        Dispute storage d = disputes[taskId];
        address winner = _other(taskId, loser);
        d.phase = Phase.Resolved; d.loser = loser;
        instances.slash(loser, SLASH_AMOUNT, winner, "porw:exec-fraud");
        market.onDisputeResolved(taskId, loser, winner);
        emit DisputeResolved(taskId, loser, winner);
    }

    // ---- helpers (LE32 leaves, counted keccak Merkle, tree geometry, stimulus rule) ----
    function _rowOk(Party storage p, uint32 len) internal view returns (bool) {
        if (len == 0) return p.act == 0;
        uint64 v = p.sums[len - 1] >> 16; return p.act == (v > CLAMP_Q16 ? CLAMP_Q16 : uint32(v));
    }
    function _record(bytes calldata rec, uint32 off) internal pure returns (uint32 pre, uint32 post, uint16 w) {
        for (uint256 i = 0; i < 4; i++) { pre |= uint32(uint8(rec[off + i])) << uint32(8 * i); post |= uint32(uint8(rec[off + 4 + i])) << uint32(8 * i); }
        w = uint16(uint8(rec[off + 8])) | (uint16(uint8(rec[off + 9])) << 8);
    }
    function _le32(uint32 x) internal pure returns (bytes memory o) { o = new bytes(4); for (uint256 i = 0; i < 4; i++) o[i] = bytes1(uint8(x >> uint32(8 * i))); }
    function _leaf32(uint32 a, uint32 b) internal pure returns (bytes32) { return keccak256(bytes.concat(_le32(a), _le32(b))); }
    function _fmix32(uint32 h) internal pure returns (uint32) { unchecked { h ^= h >> 16; h *= 0x85EBCA6B; h ^= h >> 13; h *= 0xC2B2AE35; h ^= h >> 16; } return h; }
    function _stimulus(uint32 i, uint32 seed) internal pure returns (uint32) { unchecked { return _fmix32(i * 0x9E3779B9 + seed) % 100 == 0 ? CLAMP_Q16 : 0; } }
    function _width(uint32 n, uint32 level) internal pure returns (uint32 w) { w = n; for (uint32 l = 0; l < level; l++) w = (w + 1) / 2; }
    function _levels(uint32 n) internal pure returns (uint32 c) { uint32 w = n; c = 1; while (w > 1) { w = (w + 1) / 2; c++; } }
    function _rootOf(bytes32[] calldata leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return keccak256("");
        bytes32[] memory lvl = leaves;
        while (lvl.length > 1) {
            bytes32[] memory nx = new bytes32[]((lvl.length + 1) / 2);
            for (uint256 i = 0; i < nx.length; i++) nx[i] = keccak256(bytes.concat(lvl[2 * i], 2 * i + 1 < lvl.length ? lvl[2 * i + 1] : lvl[2 * i]));
            lvl = nx;
        }
        return lvl[0];
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
}
