// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/mesh/FlyDeltaSampler.sol";
import "../src/mesh/FlyDeltaRecordVerifier.sol";
import {FlyDeltaFixtures as FX} from "./fixtures/FlyDeltaFixtures.sol";

contract SamplerHarness {
    function hash64(uint64 s, uint32 a, uint32 b) external pure returns (uint32, uint32) { return FlyDeltaSampler.hash64(s, a, b); }
    function lnQ60(uint256 n, uint256 d) external pure returns (int256) { return FlyDeltaSampler.lnQ60(n, d); }
    function expQ256(int256 y) external pure returns (uint256) { return FlyDeltaSampler.expQ256(y); }
    function sample(uint32 c, uint256 R, uint256 MR, uint64 U) external pure returns (uint32) { return FlyDeltaSampler.sample(c, R, MR, U); }
}

/// The on-chain sampler equals the JS / Python one on vectors exported from sample.js, and the one-record check decides
/// honest and tampered in-place children of a synthetic lineage built by delta.js (fixtures: export_delta_fixtures.mjs).
contract FlyDeltaTest is Test {
    SamplerHarness S = new SamplerHarness();
    FlyDeltaRecordVerifier VR = new FlyDeltaRecordVerifier();
    FlyDeltaRecordVerifier.Lineage L = FlyDeltaRecordVerifier.Lineage(FX.ROOT_BASE, FX.N_TILES, FX.SYN_OFFSET, FX.SYNAPSES, FX.NAME_LEN);

    function test_sampler_matches_the_js_vectors() public {
        for (uint256 i = 0; i < FX.N_HASH; i++) { (uint64 s, uint32 a, uint32 b, uint32 hi, uint32 lo) = FX.hashVec(i); (uint32 h, uint32 l) = S.hash64(s, a, b); assertEq(h, hi, "hash64 hi"); assertEq(l, lo, "hash64 lo"); }
        for (uint256 i = 0; i < FX.N_LN; i++) { (uint256 n, uint256 d, int256 v) = FX.lnVec(i); assertEq(S.lnQ60(n, d), v, "lnQ60"); }
        for (uint256 i = 0; i < FX.N_EXP; i++) { (int256 y, uint256 v) = FX.expVec(i); assertEq(S.expQ256(y), v, "expQ256"); }
        uint256 gMax; uint32 cMax; uint32 kMax;
        for (uint256 i = 0; i < FX.N_SAMPLE; i++) {
            (uint32 c, uint256 R, uint256 MR, uint64 U, uint32 k) = FX.sampleVec(i);
            uint256 g0 = gasleft(); uint32 got = S.sample(c, R, MR, U); uint256 g = g0 - gasleft();
            assertEq(got, k, "NB draw"); if (g > gMax) { gMax = g; cMax = c; kMax = k; }
        }
        emit log_named_uint("sampler vectors checked", FX.N_HASH + FX.N_LN + FX.N_EXP + FX.N_SAMPLE);
        emit log_named_uint("gas of the most expensive draw", gMax); emit log_named_uint("  its base count", cMax); emit log_named_uint("  its drawn count", kMax);
    }
    function test_draw_gas_by_count() public {
        uint32[5] memory cs = [uint32(5), 22, 150, 1000, 2405];
        for (uint256 i = 0; i < cs.length; i++) { uint256 g0 = gasleft(); uint32 k = S.sample(cs[i], 4412, 60293, uint64(1) << 63); emit log_named_uint(string.concat("gas of a median draw at base count ", vm.toString(cs[i]), " (k = ", vm.toString(k), ")"), g0 - gasleft()); }
    }

    // ---- openings ----
    function _one(uint64 idx, bytes memory tile, bytes32[] memory proof) internal pure returns (FlyDeltaRecordVerifier.TileOpening[] memory o) { o = new FlyDeltaRecordVerifier.TileOpening[](1); o[0] = FlyDeltaRecordVerifier.TileOpening(idx, tile, proof); }
    function _two(uint64 idx, bytes memory t0, bytes32[] memory p0, bytes memory t1, bytes32[] memory p1) internal pure returns (FlyDeltaRecordVerifier.TileOpening[] memory o) { o = new FlyDeltaRecordVerifier.TileOpening[](2); o[0] = FlyDeltaRecordVerifier.TileOpening(idx, t0, p0); o[1] = FlyDeltaRecordVerifier.TileOpening(idx + 1, t1, p1); }
    function _none() internal pure returns (FlyDeltaRecordVerifier.TileOpening[] memory o) { o = new FlyDeltaRecordVerifier.TileOpening[](0); }
    function _tileOf(uint64 j) internal pure returns (uint64) { return (FX.SYN_OFFSET + j * 10) / 4096; }
    /// the four single-tile openings of record j (all fixture cases but the straddler lie in tile T)
    function _check(uint64 j, bytes32 childRoot, bytes memory childTile, bytes32[] memory childProof) internal returns (uint8 verdict, int16 expected, int16 got) {
        assertEq(_tileOf(j), FX.TILE_T, "fixture record in tile T");
        uint256 g0 = gasleft();
        (verdict, expected, got) = VR.checkRecord(L, FX.deltaChild(), j, childRoot, FX.ROOT_A, FX.ROOT_B, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, childTile, childProof));
        emit log_named_uint("gas checkRecord (four tiles opened)", g0 - gasleft());
    }

    function test_honest_child_records_are_consistent() public {
        uint64[4] memory js = [FX.J_FROMA, FX.J_FROMB, FX.J_MUTATED, FX.J_ZEROED]; int16[4] memory ws = [FX.W_FROMA, FX.W_FROMB, FX.W_MUTATED, FX.W_ZEROED];
        for (uint256 i = 0; i < 4; i++) { (uint8 v, int16 e, int16 g) = _check(js[i], FX.ROOT_C, FX.tile_C_T(), FX.proof_C_T()); assertEq(v, 1, "consistent"); assertEq(e, ws[i], "expected = what delta.js wrote"); assertEq(g, ws[i]); }
        assertEq(FX.W_ZEROED, 0, "the zeroed case is a record below min_syn");
    }
    function test_a_record_straddling_two_tiles() public {
        (uint8 v, int16 e,) = VR.checkRecord(L, FX.deltaChild(), FX.J_STRADDLING, FX.ROOT_C, FX.ROOT_A, FX.ROOT_B,
            _two(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T(), FX.tile_base_T1(), FX.proof_base_T1()), _two(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T(), FX.tile_A_T1(), FX.proof_A_T1()),
            _two(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T(), FX.tile_B_T1(), FX.proof_B_T1()), _two(FX.TILE_T, FX.tile_C_T(), FX.proof_C_T(), FX.tile_C_T1(), FX.proof_C_T1()));
        assertEq(v, 1); assertEq(e, FX.W_STRADDLING);
        vm.expectRevert(bytes("openings")); // one tile is not enough for it
        VR.checkRecord(L, FX.deltaChild(), FX.J_STRADDLING, FX.ROOT_C, FX.ROOT_A, FX.ROOT_B, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, FX.tile_C_T(), FX.proof_C_T()));
    }
    function test_a_founder_needs_only_the_base() public {
        (uint8 v,,) = VR.checkRecord(L, FX.deltaFounderA(), FX.J_MUTATED, FX.ROOT_A, bytes32(0), bytes32(0), _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _none(), _none(), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()));
        assertEq(v, 1, "founder A's record re-derives from the base");
        vm.expectRevert(bytes("A is the base")); // its parents are the base: no parent opening is accepted
        VR.checkRecord(L, FX.deltaFounderA(), FX.J_MUTATED, FX.ROOT_A, bytes32(0), bytes32(0), _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _none(), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()));
    }
    function test_a_wrong_model_id_is_fraud_at_the_record_that_differs() public {
        // the registrant declared ROOT_W: the child with one weight off by one. Every other record still checks out.
        (uint8 v, int16 e, int16 g) = _check(FX.J_FROMA, FX.ROOT_W, FX.tile_W_T(), FX.proof_W_T()); assertEq(v, 0, "fraud"); assertEq(e, FX.W_FROMA); assertEq(g, FX.W_FROMA + 1);
        (uint8 v2,,) = _check(FX.J_FROMB, FX.ROOT_W, FX.tile_W_T(), FX.proof_W_T()); assertEq(v2, 1, "the untouched records of the same tile are consistent");
    }
    function test_static_bytes() public {
        FlyDeltaRecordVerifier.TileOpening memory b = FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_base_static(), FX.proof_base_static());
        uint256 g0 = gasleft(); (uint8 v,) = VR.checkStaticTile(L, FX.ROOT_C, b, FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_C_static(), FX.proof_C_static())); emit log_named_uint("gas checkStaticTile", g0 - gasleft());
        assertEq(v, 1, "the honest child changed only its name in the header tile");
        (uint8 v2, uint64 at) = VR.checkStaticTile(L, FX.ROOT_S, b, FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_S_static(), FX.proof_S_static()));
        assertEq(v2, 0, "a flipped root-id byte is fraud"); assertEq(at, 30 + FX.NAME_LEN + 8 * 100, "reported at its payload offset");
    }
    function test_malformed_input_reverts() public {
        bytes32[] memory bad = FX.proof_C_T(); bad[0] = bytes32(uint256(bad[0]) ^ 1);
        vm.expectRevert(bytes("tile proof")); _checkWith(FX.ROOT_C, FX.tile_C_T(), bad);
        vm.expectRevert(bytes("tile proof")); _checkWith(FX.ROOT_A, FX.tile_C_T(), FX.proof_C_T()); // a tile of another brain under this root
        vm.expectRevert(bytes("in-place cross expected")); VR.decodeCross(FX.deltaCompact());
        FlyDeltaRecordVerifier.Lineage memory other = L; other.baseModelId = bytes32(uint256(1));
        vm.expectRevert(bytes("base")); VR.checkRecord(other, FX.deltaChild(), FX.J_FROMA, FX.ROOT_C, FX.ROOT_A, FX.ROOT_B, _none(), _none(), _none(), _none());
    }
    function _checkWith(bytes32 root, bytes memory tile, bytes32[] memory proof) internal view { VR.checkRecord(L, FX.deltaChild(), FX.J_FROMA, root, FX.ROOT_A, FX.ROOT_B, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, tile, proof)); }
}
