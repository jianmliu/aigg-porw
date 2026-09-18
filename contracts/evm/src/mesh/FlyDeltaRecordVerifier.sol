// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "./FlyDeltaSampler.sol";

/// @notice One-record check of an IN-PLACE procedural brain (FLYDELTAv3, layout 1; proposals/flydelta-inplace).
///         A registration declares (recipe, model_id). In the in-place layout record j of the child sits at the byte
///         offset of record j of the base, and its weight is a function of record j of the base and of the two parents'
///         payloads. So "this model_id is not what the recipe produces" reduces to a local statement: open the tile(s)
///         holding record j in the child, the base and the parents against their committed roots, recompute, compare.
///         A second local statement covers the bytes a recipe must not touch (`checkStaticTile`).
///
///         This contract is stateless: the caller (a registry) supplies the committed roots and the lineage constants it
///         stored when the base was registered. Verdicts: 0 = Fraud (the child's bytes contradict the recipe),
///         1 = Consistent. Malformed input (bad Merkle proof, wrong tile index, wrong recipe) reverts.
contract FlyDeltaRecordVerifier {
    uint256 internal constant TILE = 4096;
    uint256 internal constant REC = 10;

    /// @dev constants of a base and therefore of its whole in-place lineage (every member has the base's layout)
    struct Lineage { bytes32 baseModelId; uint64 nTiles; uint64 synOffset; uint64 synapses; uint16 nameLen; }
    struct TileOpening { uint64 idx; bytes tile; bytes32[] proof; }
    struct Cross { FlyDeltaSampler.Recipe recipe; bytes32 baseModelId; bytes32 parentA; bytes32 parentB; uint64 neurons; }

    // ---- recipe ----
    /// @notice parse a FLYDELTAv3 delta (little-endian fields at fixed offsets); only in-place crosses are accepted
    function decodeCross(bytes calldata d) public pure returns (Cross memory x) {
        require(d.length >= 138 && bytes12(d[0:12]) == bytes12("FLYDELTAv3\x00\x00"), "not FLYDELTAv3");
        x.baseModelId = bytes32(d[12:44]); x.neurons = uint64(_le(d, 44, 8)); x.parentA = bytes32(d[52:84]); x.parentB = bytes32(d[84:116]);
        FlyDeltaSampler.Recipe memory r = x.recipe;
        r.seed = uint64(_le(d, 116, 8)); r.granularity = uint8(d[124]); r.layout = uint8(d[125]); r.minSyn = uint16(_le(d, 126, 2));
        r.mutRateQ32 = uint32(_le(d, 128, 4)); r.meanRatioQ16 = uint32(_le(d, 132, 4)); uint256 rows = _le(d, 136, 2);
        require(r.granularity <= 2 && r.layout == 1, "in-place cross expected"); require(rows > 0 && d.length >= 138 + 6 * rows + 4, "rows");
        r.rFrom = new uint32[](rows); r.rQ8 = new uint16[](rows);
        for (uint256 i = 0; i < rows; i++) { r.rFrom[i] = uint32(_le(d, 138 + 6 * i, 4)); r.rQ8[i] = uint16(_le(d, 142 + 6 * i, 2)); require(i == 0 ? r.rFrom[0] == 1 : r.rFrom[i] > r.rFrom[i - 1], "row order"); }
        require(_le(d, 138 + 6 * rows, 4) == 0, "in-place deltas carry no ops");
    }
    function _le(bytes calldata d, uint256 off, uint256 n) internal pure returns (uint256 v) { for (uint256 i = 0; i < n; i++) v |= uint256(uint8(d[off + i])) << (8 * i); }

    // ---- tiles ----
    /// @notice model_id leaf of a payload tile: keccak(LE64 tile index || 4096 bytes)
    function tileLeaf(uint64 idx, bytes calldata tile) public pure returns (bytes32) {
        require(tile.length == TILE, "tile size");
        bytes8 le; for (uint256 i = 0; i < 8; i++) le |= bytes8(bytes1(uint8(idx >> (8 * i)))) >> (8 * i);
        return keccak256(bytes.concat(le, tile));
    }
    function merkleVerifyCounted(bytes32 root, bytes32 leaf, uint64 index, uint64 leafCount, bytes32[] calldata proof) public pure returns (bool) {
        if (leafCount == 0 || index >= leafCount) return false;
        bytes32 acc = leaf; uint64 width = leafCount; uint256 pi = 0;
        while (width > 1) {
            if (pi >= proof.length) return false;
            bytes32 sib = proof[pi];
            if (index % 2 == 0) { if (index + 1 == width && sib != acc) return false; acc = keccak256(bytes.concat(acc, sib)); }
            else acc = keccak256(bytes.concat(sib, acc));
            index /= 2; width = width / 2 + width % 2; pi++;
        }
        return pi == proof.length && acc == root;
    }
    /// @notice the 10 bytes at `byteOff` of the payload committed by `modelId`, from one opened tile (two if the record straddles)
    function readRecord(bytes32 modelId, uint64 nTiles, uint64 byteOff, TileOpening[] calldata o) public pure returns (uint32 pre, uint32 post, int16 w) {
        uint64 t0 = byteOff / uint64(TILE); uint256 in0 = byteOff % TILE; bool straddles = in0 + REC > TILE;
        require(o.length == (straddles ? 2 : 1), "openings"); require(o[0].idx == t0 && (!straddles || o[1].idx == t0 + 1), "tile index");
        for (uint256 i = 0; i < o.length; i++) require(merkleVerifyCounted(modelId, tileLeaf(o[i].idx, o[i].tile), o[i].idx, nTiles, o[i].proof), "tile proof");
        bytes memory r = new bytes(REC);
        for (uint256 i = 0; i < REC; i++) r[i] = in0 + i < TILE ? o[0].tile[in0 + i] : o[1].tile[in0 + i - TILE];
        pre = uint32(uint8(r[0])) | uint32(uint8(r[1])) << 8 | uint32(uint8(r[2])) << 16 | uint32(uint8(r[3])) << 24;
        post = uint32(uint8(r[4])) | uint32(uint8(r[5])) << 8 | uint32(uint8(r[6])) << 16 | uint32(uint8(r[7])) << 24;
        w = int16(uint16(uint8(r[8])) | uint16(uint8(r[9])) << 8);
    }
    function _abs(int16 w) internal pure returns (uint32) { return uint32(uint16(w < 0 ? -w : w)); }

    // ---- the record check ----
    /// @param parentAModelId the committed model_id of the delta's parent A (ignored when the delta names the base, zero id); same for B
    /// @return verdict 0 Fraud, 1 Consistent; expected / got: the weight the recipe gives and the weight the child commits to
    function checkRecord(
        Lineage calldata L, bytes calldata delta, uint64 j, bytes32 childModelId, bytes32 parentAModelId, bytes32 parentBModelId,
        TileOpening[] calldata baseT, TileOpening[] calldata aT, TileOpening[] calldata bT, TileOpening[] calldata childT
    ) external pure returns (uint8 verdict, int16 expected, int16 got) {
        Cross memory x = decodeCross(delta); require(x.baseModelId == L.baseModelId, "base"); require(j < L.synapses, "record index");
        uint64 off = L.synOffset + j * uint64(REC);
        (uint32 pre, uint32 post, int16 wBase) = readRecord(L.baseModelId, L.nTiles, off, baseT); uint32 c = _abs(wBase);
        uint32 a = c; uint32 b = c; // a parent named by the zero id is the base itself
        if (x.parentA != bytes32(0)) { (uint32 p1, uint32 q1, int16 wa) = readRecord(parentAModelId, L.nTiles, off, aT); require(p1 == pre && q1 == post, "parent A is not of this lineage"); a = _abs(wa); } else require(aT.length == 0, "A is the base");
        if (x.parentB != bytes32(0)) { (uint32 p2, uint32 q2, int16 wb) = readRecord(parentBModelId, L.nTiles, off, bT); require(p2 == pre && q2 == post, "parent B is not of this lineage"); b = _abs(wb); } else require(bT.length == 0, "B is the base");
        uint32 v = FlyDeltaSampler.inheritRecord(x.recipe, pre, post, c, a, b);
        expected = wBase < 0 ? -int16(uint16(v)) : int16(uint16(v));
        (uint32 pc, uint32 qc, int16 wChild) = readRecord(childModelId, L.nTiles, off, childT); got = wChild;
        verdict = (pc == pre && qc == post && wChild == expected) ? 1 : 0;
    }

    // ---- the bytes a recipe must not touch ----
    /// @notice every byte of tile `idx` outside the name and outside the records' weight fields must equal the base's.
    ///         0 Fraud (with the first offending byte offset in the payload), 1 Consistent.
    function checkStaticTile(Lineage calldata L, bytes32 childModelId, TileOpening calldata baseT, TileOpening calldata childT) external pure returns (uint8 verdict, uint64 at) {
        require(baseT.idx == childT.idx, "tile index");
        require(merkleVerifyCounted(L.baseModelId, tileLeaf(baseT.idx, baseT.tile), baseT.idx, L.nTiles, baseT.proof), "base proof");
        require(merkleVerifyCounted(childModelId, tileLeaf(childT.idx, childT.tile), childT.idx, L.nTiles, childT.proof), "child proof");
        uint256 start = uint256(baseT.idx) * TILE; uint256 recEnd = uint256(L.synOffset) + uint256(L.synapses) * REC; uint256 nameEnd = 30 + uint256(L.nameLen);
        for (uint256 w = 0; w < TILE; w += 32) { // word-wise first: an in-place child differs from its base in few words of a static tile
            if (bytes32(baseT.tile[w:w + 32]) == bytes32(childT.tile[w:w + 32])) continue;
            for (uint256 i = w; i < w + 32; i++) {
                if (baseT.tile[i] == childT.tile[i]) continue;
                uint256 p = start + i;
                bool free = (p >= 30 && p < nameEnd) || (p >= L.synOffset && p < recEnd && (p - L.synOffset) % REC >= 8);
                if (!free) return (0, uint64(p));
            }
        }
        return (1, 0);
    }
}
