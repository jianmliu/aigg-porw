// FLYDELTAv2 sampler: deterministic integer resampling of synapse counts (a synthetic individual of a released brain).
// Every quantity is an integer (BigInt where it exceeds 2^53), so JS and Python (flywire_delta.py) agree bit for bit:
//   U = hash64(seed, pre, post) (two fmix32 chains, identity-based);  m = c * mean_ratio / 65536;  r = r_q8(c) / 256
//   CDF of NB(mean m, shape r) tabulated in Q256 fixed point (ln / exp by fixed-length series in Q60), entries floored to Q64
//   c' = smallest k with CDF(k) > U (the last table entry if none); records with c' < min_syn are dropped; sign kept.
const M32 = 0xffffffff; const GOLDEN32 = 0x9e3779b9;
export const fmix32 = (h) => { h >>>= 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h >>> 0; };
/** the two 32-bit words [high, low] of the 64-bit uniform of a key (a, b) under a 64-bit seed: both seed words reach the high
 *  word (h1 <- seedLo, hi <- seedHi) and the low word hashes the swapped key, so it is not a function of the high word */
export function hash64Words(seedLo, seedHi, a, b) { const h1 = fmix32(((Math.imul(a >>> 0, GOLDEN32) + b) >>> 0) ^ seedLo); const hi = fmix32((h1 ^ seedHi) >>> 0); const lo = fmix32((((Math.imul(b >>> 0, GOLDEN32) + a) >>> 0) ^ hi ^ 0x85ebca6b) >>> 0); return [hi, lo]; }
/** 64-bit uniform for a record as a BigInt */
export function hash64(seedLo, seedHi, pre, post) { const [hi, lo] = hash64Words(seedLo, seedHi, pre, post); return (BigInt(hi) << 32n) | BigInt(lo); }
const Q60 = 1n << 60n, Q256 = 1n << 256n, LN2_Q60 = 799144290325165978n; // floor(ln 2 * 2^60)
const floorDiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };
const bitLength = (x) => x.toString(2).length;
/** fixed-point ln(num/den) in Q60, num, den > 0 */
export function lnQ60(num, den) {
  let e = bitLength(num) - bitLength(den);
  if ((num << BigInt(e >= 0 ? 60 : 60 - e)) < (den << BigInt(e >= 0 ? 60 + e : 60))) e -= 1;
  const Y = e <= 60 ? (num << BigInt(60 - e)) / den : (num >> BigInt(e - 60)) / den;
  const T = ((Y - Q60) << 60n) / (Y + Q60); const T2 = (T * T) >> 60n; let p = T, acc = T;
  for (let k = 1; k <= 30; k++) { p = (p * T2) >> 60n; acc += p / BigInt(2 * k + 1); }
  return 2n * acc + BigInt(e) * LN2_Q60;
}
/** fixed-point exp(y), y <= 0 in Q60, result in Q256 */
export function expQ256(y) {
  const n = floorDiv(y, LN2_Q60); const f = y - n * LN2_Q60; let term = Q60, acc = Q60;
  for (let k = 1; k <= 40; k++) { term = floorDiv(term * f, BigInt(k) * Q60); acc += term; }
  return n <= 0n ? (acc << (256n - 60n)) >> -n : acc << (256n - 60n + n);
}
export const DEFAULT_R_TABLE = [[1, 423], [2, 479], [3, 677], [5, 806], [8, 1015], [12, 1396], [20, 1991], [35, 2883], [60, 4132], [100, 4412]]; // (c_from, r*256): individual-level NB shape from FlyWire L/R mirror pairs, Var_ind = Var_pair / 2
export function rOf(c, rows) { let r = rows[0][1]; for (const [cFrom, rq] of rows) { if (c <= cFrom - 1 && cFrom > 1) break; if (cFrom <= c) r = rq; } return r; }
/** CDF table (BigUint64Array of Q64 entries) for base count c, shape R (r*256), mean ratio MR (Q16) */
export function nbTable(c, R, MR, kmax = null) {
  if (kmax === null) kmax = Math.min(32767, 8 * c + 256);
  const cb = BigInt(c), Rb = BigInt(R), cMR = cb * BigInt(MR); const pn = 256n * Rb, pd = 256n * Rb + cMR;
  const y = floorDiv(Rb * lnQ60(pn, pd), 256n); let P = expQ256(y); let cum = P; const out = [cum >> 192n]; let k = 0;
  while (k < kmax) {
    const num = (256n * BigInt(k) + Rb) * cMR; const den = 256n * BigInt(k + 1) * pd; P = (P * num) / den; k++;
    if (P === 0n && 65536n * BigInt(k) > cMR) break;
    cum += P; out.push((cum < Q256 - 1n ? cum : Q256 - 1n) >> 192n);
  }
  out[out.length - 1] = (1n << 64n) - 1n; // the tail beyond the table belongs to the last k by definition (the fixed-point P(0) is exact only to ~1e-9)
  return BigUint64Array.from(out);
}
/** smallest k with table[k] > U, or the last index */
export function sampleFromTable(table, U) { let lo = 0, hi = table.length - 1; if (table[hi] <= U) return hi; while (lo < hi) { const mid = (lo + hi) >> 1; if (table[mid] > U) hi = mid; else lo = mid + 1; } return lo; }
