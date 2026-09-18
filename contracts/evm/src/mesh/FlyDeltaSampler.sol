// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice The FLYDELTA sampler as the EVM computes it. It is the same integer procedure as web/porw-browser/sample.js
///         and demo/fly_brain/flywire_delta.py, not an approximation of it: hash-driven uniforms (fmix32), ln / exp by
///         fixed-length series in Q60, the negative-binomial pmf recurrence in exact integer ratios in Q256 (the EVM's
///         word size; products through a 512-bit mulDiv), entries floored to Q64, the last table entry pinned to 1.
///         One record of a procedural brain is therefore re-derivable on-chain (`inheritRecord`).
library FlyDeltaSampler {
    uint256 internal constant Q60 = 1 << 60;
    uint256 internal constant LN2_Q60 = 799144290325165978; // floor(ln 2 * 2^60)
    uint32 internal constant GOLDEN32 = 0x9E3779B9;
    uint32 internal constant DOM_PICK = 0x5049434B;
    uint32 internal constant DOM_MUT = 0x4D555421;
    uint32 internal constant DOM_DRAW = 0x44524157;
    uint32 internal constant MUT_ALWAYS = 0xFFFFFFFF;

    /// @dev the fields of a FLYDELTAv3 cross that the per-record rule reads
    struct Recipe {
        uint64 seed; uint8 granularity; uint8 layout; uint16 minSyn; uint32 mutRateQ32; uint32 meanRatioQ16;
        uint32[] rFrom; uint16[] rQ8; // shape table rows (ascending c_from, first = 1)
    }

    function fmix32(uint32 h) internal pure returns (uint32) {
        unchecked { h ^= h >> 16; h *= 0x85EBCA6B; h ^= h >> 13; h *= 0xC2B2AE35; h ^= h >> 16; return h; }
    }

    /// @notice the 64-bit uniform of a key (a, b) under a 64-bit seed; both seed words reach the high word
    function hash64(uint64 seed, uint32 a, uint32 b) internal pure returns (uint32 hi, uint32 lo) {
        unchecked {
            uint32 h1 = fmix32((a * GOLDEN32 + b) ^ uint32(seed));
            hi = fmix32(h1 ^ uint32(seed >> 32));
            lo = fmix32((b * GOLDEN32 + a) ^ hi ^ 0x85EBCA6B);
        }
    }

    /// @dev seed-domain separation: the constant is XORed into both words of the seed
    function dom(uint64 seed, uint32 d) internal pure returns (uint64) { return seed ^ (uint64(d) << 32) ^ uint64(d); }

    function bitLength(uint256 x) internal pure returns (uint256 n) { while (x != 0) { n++; x >>= 1; } }

    /// @notice fixed-point ln(num/den) in Q60 (num, den > 0): x = y * 2^e with y in [1, 2), atanh series, 30 terms
    function lnQ60(uint256 num, uint256 den) internal pure returns (int256) {
        int256 e = int256(bitLength(num)) - int256(bitLength(den));
        if (e >= 0 ? (num << 60) < (den << (60 + uint256(e))) : (num << (60 + uint256(-e))) < (den << 60)) e -= 1; // ensure 2^e <= num/den
        uint256 y = e <= 60 ? (num << uint256(60 - e)) / den : (num >> uint256(e - 60)) / den; // Q60, [1, 2)
        uint256 t = ((y - Q60) << 60) / (y + Q60); uint256 t2 = (t * t) >> 60; uint256 p = t; uint256 acc = t;
        for (uint256 k = 1; k <= 30; k++) { p = (p * t2) >> 60; acc += p / (2 * k + 1); }
        return int256(2 * acc) + e * int256(LN2_Q60);
    }

    /// @notice fixed-point exp(y) for y < 0 in Q60, result in Q256: y = n ln2 + f with f in [0, ln2), Taylor series, 40 terms
    function expQ256(int256 y) internal pure returns (uint256) {
        require(y < 0, "exp: y >= 0"); // exp(0) = 2^256 does not fit; it cannot occur for a base count >= 1
        int256 n = y / int256(LN2_Q60); if (y % int256(LN2_Q60) != 0) n -= 1; // floor division, y < 0
        uint256 f = uint256(y - n * int256(LN2_Q60)); uint256 term = Q60; uint256 acc = Q60;
        for (uint256 k = 1; k <= 40; k++) { term = (term * f) / (k * Q60); acc += term; }
        uint256 down = uint256(-n); // (acc << 196) >> down, without overflowing the word
        return down <= 196 ? acc << (196 - down) : acc >> (down - 196);
    }

    /// @notice the shape r*256 for a base count: the last row with c_from <= c
    function rOf(uint32 c, uint32[] memory rFrom, uint16[] memory rQ8) internal pure returns (uint256 r) {
        r = rQ8[0];
        for (uint256 i = 0; i < rFrom.length; i++) { if (rFrom[i] > c) break; r = rQ8[i]; }
    }

    /// @notice the draw: smallest k with CDF_NB(k; mean c*MR/65536, shape R/256) > U / 2^64 (the last table index if none)
    function sample(uint32 c, uint256 R, uint256 MR, uint64 U) internal pure returns (uint32) {
        uint256 kmax = 8 * uint256(c) + 256; if (kmax > 32767) kmax = 32767;
        uint256 cMR = uint256(c) * MR; uint256 pn = 256 * R; uint256 pd = pn + cMR; // p = r/(r+m) = 256R / (256R + c*MR)
        int256 lnp = lnQ60(pn, pd); int256 yy = int256(R) * lnp; int256 y = yy / 256; if (yy % 256 != 0) y -= 1; // floor(R ln p / 256), <= 0
        uint256 P = expQ256(y); uint256 cum = P; uint256 k = 0;
        if (uint64(cum >> 192) > U) return 0;
        while (k < kmax) {
            P = mulDiv(P, (256 * k + R) * cMR, 256 * (k + 1) * pd);
            if (P == 0 && 65536 * (k + 1) > cMR) return uint32(k); // the table ends at k: it is the last index
            k++;
            unchecked { uint256 s = cum + P; cum = s < cum ? type(uint256).max : s; } // saturate, as min(cum, 2^256 - 1)
            if (uint64(cum >> 192) > U) return uint32(k);
        }
        return uint32(k); // k == kmax: the last index, whose entry is pinned to 1
    }

    /// @notice the per-record rule of a cross: c = |base weight|, a / b = the parents' values for this record
    function inheritRecord(Recipe memory d, uint32 pre, uint32 post, uint32 c, uint32 a, uint32 b) internal pure returns (uint32 v) {
        (uint32 ka, uint32 kb) = d.granularity == 0 ? (pre, post) : d.granularity == 1 ? (pre, type(uint32).max) : (type(uint32).max, post);
        (uint32 ph,) = hash64(dom(d.seed, DOM_PICK), ka, kb);
        v = (ph >> 31) == 0 ? a : b;
        (uint32 mh,) = hash64(dom(d.seed, DOM_MUT), pre, post);
        if (d.mutRateQ32 == MUT_ALWAYS || mh < d.mutRateQ32) {
            (uint32 dh, uint32 dl) = hash64(dom(d.seed, DOM_DRAW), pre, post);
            v = sample(c, rOf(c, d.rFrom, d.rQ8), d.meanRatioQ16, (uint64(dh) << 32) | uint64(dl)); // a fresh draw around the BASE count
            if (v > 32767) v = 32767;
        }
        if (d.layout == 1 && v < d.minSyn) v = 0;
    }

    /// @dev floor(a * b / d) with a 512-bit intermediate (Remco Bloemen's mulDiv)
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0; uint256 prod1;
            assembly { let mm := mulmod(a, b, not(0)) prod0 := mul(a, b) prod1 := sub(sub(mm, prod0), lt(mm, prod0)) }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly { remainder := mulmod(a, b, d) prod1 := sub(prod1, gt(remainder, prod0)) prod0 := sub(prod0, remainder) }
            uint256 twos = d & (~d + 1);
            assembly { d := div(d, twos) prod0 := div(prod0, twos) twos := add(div(sub(0, twos), twos), 1) }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2; inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}
