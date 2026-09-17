// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice The `aigg:exec:int-lif:v1` transition rule and state leaf, as the execution-dispute
///         contract evaluates them (row check + single-term check). Mirrors lif_wasm.c / lif.js /
///         int_lif.py bit for bit: signed 64-bit intermediates, arithmetic (floor) shifts, int32
///         saturation of the synaptic drive. Parameters (Shiu et al. 2024, Q16 mV / Q32) are pinned
///         by the execution-kind digest that the MEP carries.
library LifRowCheck {
    string constant KIND_ID = "aigg:exec:int-lif:v1";
    uint32 constant DT_TAU_M_Q16 = 328;      // 0.1 ms / 20 ms
    uint32 constant DT_TAU_S_Q16 = 1311;     // 0.1 ms / 5 ms
    int64  constant THRESH_Q16   = 458752;   // 7 mV above rest
    int64  constant W_UNIT_Q16   = 18022;    // 0.275 mV per synapse
    uint16 constant REFRACT      = 22;       // 2.2 ms
    uint32 constant EXT_P_Q32    = 64424509; // 150 Hz * 0.1 ms
    uint32 constant GOLDEN32 = 0x9E3779B9;

    struct State { int32 v; int32 g; uint16 refr; uint16 flags; uint32 count; }

    function execKind() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(KIND_ID, DT_TAU_M_Q16, DT_TAU_S_Q16, uint32(uint64(THRESH_Q16)), uint32(uint64(W_UNIT_Q16)), uint32(REFRACT), EXT_P_Q32));
    }
    function fmix32(uint32 h) internal pure returns (uint32) { unchecked { h ^= h >> 16; h *= 0x85EBCA6B; h ^= h >> 13; h *= 0xC2B2AE35; h ^= h >> 16; } return h; }
    /// @dev deterministic Poisson-like drive of a stimulated neuron
    function ext(uint32 i, uint32 step, uint32 seed) internal pure returns (bool) { unchecked { return fmix32(fmix32(i * GOLDEN32 + seed) + step * GOLDEN32) < EXT_P_Q32; } }
    function spiked(State memory s) internal pure returns (int64) { return (s.flags & 2) != 0 ? int64(1) : int64(0); }

    /// @notice next state of neuron i at `step` given the previous state and the signed input sum I
    function transition(State memory S, int64 I, uint32 i, uint32 step, uint32 seed) internal pure returns (State memory R) {
        int64 g = int64(S.g);
        g = g - ((g * int64(uint64(DT_TAU_S_Q16))) >> 16) + I * W_UNIT_Q16;
        if (g > type(int32).max) g = type(int32).max;
        if (g < type(int32).min) g = type(int32).min;
        R.g = int32(g);
        uint32 spike;
        if (S.flags & 1 != 0) { spike = ext(i, step, seed) ? 1 : 0; R.v = 0; R.refr = 0; }
        else if (S.refr > 0) { spike = 0; R.v = 0; R.refr = S.refr - 1; }
        else {
            int64 v = int64(S.v) + (((g - int64(S.v)) * int64(uint64(DT_TAU_M_Q16))) >> 16);
            if (v >= THRESH_Q16) { spike = 1; v = 0; R.refr = REFRACT; } else { spike = 0; R.refr = 0; }
            R.v = int32(v);
        }
        R.count = S.count + spike;
        R.flags = uint16((S.flags & 1) | (spike << 1));
    }
    function same(State memory a, State memory b) internal pure returns (bool) { return a.v == b.v && a.g == b.g && a.refr == b.refr && a.flags == b.flags && a.count == b.count; }
    /// @dev leaf = keccak(LE32 i || LE32 v || LE32 g || LE16 refr || LE16 flags || LE32 count)
    function stateLeaf(uint32 i, State memory s) internal pure returns (bytes32) {
        return keccak256(bytes.concat(_le32(i), _le32(uint32(s.v)), _le32(uint32(s.g)), _le16(s.refr), _le16(s.flags), _le32(s.count)));
    }
    function _le32(uint32 x) internal pure returns (bytes memory o) { o = new bytes(4); for (uint256 k = 0; k < 4; k++) o[k] = bytes1(uint8(x >> uint32(8 * k))); }
    function _le16(uint16 x) internal pure returns (bytes memory o) { o = new bytes(2); o[0] = bytes1(uint8(x)); o[1] = bytes1(uint8(x >> 8)); }
}
