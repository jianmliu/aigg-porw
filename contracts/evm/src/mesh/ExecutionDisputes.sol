// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "../interfaces/PorwMesh.sol";
import "../PorwVerifierKeccak.sol";
import "./InstanceRegistry.sol";
import "./TaskMarket.sol";
import "./LifRowCheck.sol";

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
/// Execution kinds are dispatched on MEP.execKind at open time:
///   int-spmv-q16 : per-step activation roots; row = min(sum >> 16, clamp); u64 sums.
///   int-lif      : segment state roots every `stride` = Task.commitStride steps -> Refine phase (per-step roots of
///                  the first differing segment, bound to the committed segment root) -> state-tree bisection ->
///                  row = LifRowCheck.transition(state_{s-1}[i], last signed sum) -> term = w(int16) * spiked(pre).
///                  The agreed root before step 1 is the task's initStateRoot.
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
    struct LifDispute { bool lif; uint32 stride; uint32 segments; uint32 seg; bytes32 initStateRoot; }
    struct LifParty { bytes32[] stepRoots; bool refined; LifRowCheck.State state; int64[] sums; bool rowPosted; }
    mapping(bytes32 => Dispute) public disputes;
    mapping(bytes32 => LifDispute) public lifs;
    mapping(bytes32 => mapping(address => LifParty)) internal lifParties;
    mapping(bytes32 => mapping(address => Party)) internal parties;
    mapping(bytes32 => address) public partyA;
    mapping(bytes32 => address) public partyB;

    constructor(IMEPRegistry m, InstanceRegistry i, TaskMarket mk, uint64 roundBlocks, uint256 slashAmount) { meps = m; instances = i; market = mk; ROUND_BLOCKS = roundBlocks; SLASH_AMOUNT = slashAmount; }

    // ---- lifecycle ----
    function openDispute(bytes32 taskId, address a, address b) external {
        require(msg.sender == address(market), "market");
        require(!disputes[taskId].exists, "open");
        // steps and the commit stride come from the TASK: both parties executed the same stored Task, and
        // postTask has already bounded them so every round of this dispute is postable.
        (bytes32 mepId, uint32 seed,, uint32 steps, uint32 stride) = market.taskInfo(taskId);
        IMEPRegistry.MEP memory m = meps.getMEP(mepId);
        Dispute storage d = disputes[taskId];
        d.mepId = mepId; d.neurons = m.neurons; d.synapses = m.synapses; d.steps = steps; d.stimulusSeed = seed; d.synapseRoot = m.synapseRoot;
        d.phase = Phase.Step; d.exists = true; d.deadline = uint64(block.number) + ROUND_BLOCKS;
        if (m.execKind == LifRowCheck.execKind()) {
            LifDispute storage ld = lifs[taskId];
            ld.lif = true; ld.stride = stride; ld.segments = (steps + stride - 1) / stride; ld.initStateRoot = market.taskInitStateRoot(taskId);
        }
        partyA[taskId] = a; partyB[taskId] = b;
        (, parties[taskId][a].execRoot) = market.resultOf(taskId, a);
        (, parties[taskId][b].execRoot) = market.resultOf(taskId, b);
        emit DisputeRound(taskId, Phase.Step, 0, steps);
    }
    function open(bytes32, address, address) external payable { revert("use market"); }
    function bisect(bytes32, uint256, bytes32) external pure { revert("use postChildren"); }

    /// @dev a party may act through its delegated session key (the tab's key); state is keyed by the instance
    function _who(bytes32 taskId) internal view returns (address w) { w = instances.resolve(msg.sender); require(w != address(0) && (w == partyA[taskId] || w == partyB[taskId]), "party"); }
    function _party(bytes32 taskId) internal view returns (Party storage) { return parties[taskId][_who(taskId)]; }
    function _other(bytes32 taskId, address who) internal view returns (address) { return who == partyA[taskId] ? partyB[taskId] : partyA[taskId]; }

    // ---- Step phase ----
    function revealRoots(bytes32 taskId, bytes32[] calldata actRoots) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Step, "phase");
        Party storage p = _party(taskId); require(!p.revealed, "revealed");
        LifDispute storage ld = lifs[taskId];
        uint32 count = ld.lif ? ld.segments : d.steps;
        require(actRoots.length == count && _rootOf(actRoots) == p.execRoot, "execRoot");
        p.actRoots = actRoots; p.revealed = true;
        Party storage q = parties[taskId][_other(taskId, _who(taskId))];
        if (!q.revealed) return;
        uint32 s = 0; while (s < count && p.actRoots[s] == q.actRoots[s]) s++;
        require(s < count, "no divergence"); // identical roots cannot yield different execRoots
        if (ld.lif) { // first differing SEGMENT: refine to steps first
            ld.seg = s; d.prevRoot = s == 0 ? ld.initStateRoot : p.actRoots[s - 1];
            d.phase = Phase.Refine; d.deadline = uint64(block.number) + ROUND_BLOCKS;
            emit DisputeRound(taskId, Phase.Refine, s, 0); return;
        }
        d.step = s + 1; d.prevRoot = s == 0 ? bytes32(0) : p.actRoots[s - 1];
        _startNeuron(taskId, d, p, q, p.actRoots[s], q.actRoots[s]);
    }
    function _startNeuron(bytes32 taskId, Dispute storage d, Party storage p, Party storage q, bytes32 nodeP, bytes32 nodeQ) internal {
        p.node = nodeP; q.node = nodeQ;
        d.level = _levels(d.neurons) - 1; d.idx = 0; d.phase = Phase.Neuron; d.deadline = uint64(block.number) + ROUND_BLOCKS;
        emit DisputeRound(taskId, Phase.Neuron, d.level, 0);
    }

    // ---- Refine phase (int-lif): per-step roots inside the first differing segment ----
    function postStepRoots(bytes32 taskId, bytes32[] calldata roots) external {
        Dispute storage d = disputes[taskId]; LifDispute storage ld = lifs[taskId]; require(d.exists && d.phase == Phase.Refine, "phase");
        address me = _who(taskId); Party storage p = parties[taskId][me]; LifParty storage lp = lifParties[taskId][me]; require(!lp.refined, "refined");
        uint32 s0 = ld.seg * ld.stride; uint32 len = d.steps - s0 < ld.stride ? d.steps - s0 : ld.stride;
        require(roots.length == len && roots[len - 1] == p.actRoots[ld.seg], "unbound chain"); // must end at the committed segment root
        lp.stepRoots = roots; lp.refined = true;
        address o = _other(taskId, me); LifParty storage lq = lifParties[taskId][o];
        if (!lq.refined) return;
        uint32 j = 0; while (j < len && lp.stepRoots[j] == lq.stepRoots[j]) j++;
        require(j < len, "no divergence"); // the chains end at different segment roots, so they differ somewhere
        d.step = s0 + j + 1; if (j > 0) d.prevRoot = lp.stepRoots[j - 1]; // else: the agreed previous segment root already in d.prevRoot
        _startNeuron(taskId, d, p, parties[taskId][o], lp.stepRoots[j], lq.stepRoots[j]);
    }

    // ---- Neuron phase: each party posts the children of its current node ----
    function postChildren(bytes32 taskId, bytes32 left, bytes32 right) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Neuron && d.level > 0, "phase");
        Party storage p = _party(taskId); require(!p.posted, "posted");
        uint32 childWidth = _width(d.neurons, d.level - 1);
        if (2 * d.idx + 1 >= childWidth) require(right == left, "single child"); // duplicate-last
        require(keccak256(bytes.concat(left, right)) == p.node, "not children");
        p.pair = [left, right]; p.posted = true;
        Party storage q = parties[taskId][_other(taskId, _who(taskId))];
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
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse && !lifs[taskId].lif, "phase");
        Party storage p = _party(taskId); require(!p.rowPosted, "posted");
        require(keccak256(bytes.concat(_le32(d.neuron), _le32(claimedAct))) == p.leaf, "leaf");
        require(sums.length <= MAX_IN_DEGREE, "in-degree");
        p.act = claimedAct; p.sums = sums; p.rowPosted = true; d.deadline = uint64(block.number) + ROUND_BLOCKS;
    }

    // ---- Row phase (int-lif): claimed state bound to the leaf + signed partial sums ----
    function postRowLif(bytes32 taskId, int32 v, int32 g, uint16 refr, uint16 flags, uint32 count, int64[] calldata sums) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse && lifs[taskId].lif, "phase");
        address me = _who(taskId); Party storage p = parties[taskId][me]; LifParty storage lp = lifParties[taskId][me]; require(!lp.rowPosted, "posted");
        LifRowCheck.State memory st = LifRowCheck.State(v, g, refr, flags, count);
        require(LifRowCheck.stateLeaf(d.neuron, st) == p.leaf, "leaf");
        require(sums.length <= MAX_IN_DEGREE, "in-degree");
        lp.state = st; lp.sums = sums; lp.rowPosted = true; d.deadline = uint64(block.number) + ROUND_BLOCKS;
    }

    /// @notice final adjudication (int-lif) once both rows are posted; anyone may call with the openings
    function proveSynapseTermLif(bytes32 taskId, LifTermProof calldata pf) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse && lifs[taskId].lif, "phase");
        LifParty storage a = lifParties[taskId][partyA[taskId]]; LifParty storage b = lifParties[taskId][partyB[taskId]];
        require(a.rowPosted && b.rowPosted, "rows");
        require(keccak256(bytes.concat(pf.csrRoot, pf.rowRoot)) == d.synapseRoot, "synapseRoot");
        uint32 n = d.neurons;
        require(_verify(pf.rowRoot, _leaf32(d.neuron, pf.bounds.start), d.neuron, n + 1, pf.bounds.startProof) && _verify(pf.rowRoot, _leaf32(d.neuron + 1, pf.bounds.end), d.neuron + 1, n + 1, pf.bounds.endProof), "row bounds");
        // the neuron's own previous state, against the agreed previous-step root
        LifRowCheck.State memory prev = _state(pf.self);
        require(_verify(d.prevRoot, LifRowCheck.stateLeaf(d.neuron, prev), d.neuron, n, pf.self.proof), "prev state");
        uint32 len = pf.bounds.end - pf.bounds.start;
        bool lenA = a.sums.length == len; bool lenB = b.sums.length == len;
        if (lenA != lenB) return _resolve(taskId, lenA ? partyB[taskId] : partyA[taskId], "row length");
        require(lenA, "both wrong length");
        bool rowA = _rowOkLif(a, prev, len, d); bool rowB = _rowOkLif(b, prev, len, d);
        if (rowA != rowB) return _resolve(taskId, rowA ? partyB[taskId] : partyA[taskId], "row check");
        require(rowA, "both rows inconsistent");
        require(pf.kStar >= pf.bounds.start && pf.kStar < pf.bounds.end, "k range");
        uint32 j = pf.kStar - pf.bounds.start;
        require(a.sums[j] != b.sums[j] && (j == 0 || a.sums[j - 1] == b.sums[j - 1]), "not first divergence");
        uint32 nChunks = (d.synapses + CSR_CHUNK - 1) / CSR_CHUNK;
        require(pf.chunk.c == pf.kStar / CSR_CHUNK && _verify(pf.csrRoot, keccak256(bytes.concat(_le32(pf.chunk.c), pf.chunk.records)), pf.chunk.c, nChunks, pf.chunk.proof), "chunk");
        uint32 off = (pf.kStar - pf.chunk.c * CSR_CHUNK) * 10;
        require(pf.chunk.records.length >= off + 10, "record");
        (uint32 pre, uint32 post, uint16 wu) = _record(pf.chunk.records, off);
        require(post == d.neuron, "record post");
        // the input neuron's previous state (did it spike at s-1?), against the same agreed root
        LifRowCheck.State memory preState = _state(pf.pre);
        require(_verify(d.prevRoot, LifRowCheck.stateLeaf(pre, preState), pre, n, pf.pre.proof), "pre state");
        int64 term = int64(int16(wu)) * LifRowCheck.spiked(preState);
        bool okA = a.sums[j] == (j == 0 ? int64(0) : a.sums[j - 1]) + term;
        bool okB = b.sums[j] == (j == 0 ? int64(0) : b.sums[j - 1]) + term;
        require(okA != okB, "no single loser");
        _resolve(taskId, okA ? partyB[taskId] : partyA[taskId], "term");
    }
    function _state(StateOpening calldata o) internal pure returns (LifRowCheck.State memory) { return LifRowCheck.State(o.v, o.g, o.refr, o.flags, o.count); }
    function _rowOkLif(LifParty storage p, LifRowCheck.State memory prev, uint32 len, Dispute storage d) internal view returns (bool) {
        int64 I = len == 0 ? int64(0) : p.sums[len - 1];
        return LifRowCheck.same(LifRowCheck.transition(prev, I, d.neuron, d.step, d.stimulusSeed), p.state);
    }

    /// @notice final adjudication once both rows are posted (anyone may call with the openings)
    function proveSynapseTerm(bytes32 taskId, uint32 kStar, bytes32 csrRoot, bytes32 rowRoot, RowBounds calldata bounds, ChunkOpening calldata chunk, uint32 actPre, bytes32[] calldata actProof) external {
        Dispute storage d = disputes[taskId]; require(d.exists && d.phase == Phase.Synapse && !lifs[taskId].lif, "phase");
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
        else if (d.phase == Phase.Refine) { aDone = lifParties[taskId][partyA[taskId]].refined; bDone = lifParties[taskId][partyB[taskId]].refined; }
        else if (d.phase == Phase.Neuron) { aDone = a.posted; bDone = b.posted; }
        else if (lifs[taskId].lif) { aDone = lifParties[taskId][partyA[taskId]].rowPosted; bDone = lifParties[taskId][partyB[taskId]].rowPosted; }
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
