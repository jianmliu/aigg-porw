/*
 * Deterministic integer leaky integrate-and-fire — execution kind `aigg:exec:int-lif:v1`.
 *
 * A fixed-point port of the whole-brain LIF model of Shiu et al. 2024 (Nature; Brian2,
 * dt = 0.1 ms, tau_m = 20 ms, tau_syn = 5 ms, threshold 7 mV above rest, refractory
 * 2.2 ms, 0.275 mV per synapse, GABA/glutamate inhibitory, activated neurons driven
 * as a Poisson process). Every quantity is an integer so all engines (wasm, numpy,
 * noble/JS, Solidity) reproduce the trajectory bit for bit and a disagreement can be
 * narrowed to one synapse term (see dispute_wasm.c / dispute.js / LifRowCheck.sol).
 *
 * Payload v2 synapse record (10 B): pre u32 LE, post u32 LE, w i16 LE — the signed
 * synapse count (sign = presynaptic neurotransmitter). Records sorted by post.
 *
 * State per neuron (16 B): v i32 (Q16 mV above rest), g i32 (Q16 mV synaptic drive),
 * refr u16 (refractory steps left), flags u16 (bit0 stimulated, bit1 spiked this step, bit2 silenced),
 * count u32 (spikes so far). state_0: everything 0 except flags.bit0 on stimulated neurons.
 *
 * Transition, neuron i, step s >= 1, with I = sum over incoming k of w_k * spiked_{s-1}[pre_k]
 * (signed; the CSR-ordered running sums of these terms are the dispute's partial sums):
 *   g1 = sat32( g - ((g * DT_TAU_S) >> 16) + I * W_UNIT )          (>> is floor / arithmetic)
 *   stimulated : spike = ext(i, s, seed);  v1 = 0; refr1 = 0
 *   refr > 0   : spike = 0;               v1 = 0; refr1 = refr - 1
 *   else       : v1 = v + (((g1 - v) * DT_TAU_M) >> 16)
 *                spike = v1 >= THRESH;  if spike { v1 = 0; refr1 = REFRACT } else refr1 = 0
 *   count1 = count + spike;  flags1 = (flags & 5) | (spike << 1)
 * A SILENCED neuron (bit2) never spikes: spike = 0, v1 = 0, refr1 = 0, whatever else is set -- silence wins over the
 * stimulus. Like bit0 it is part of state_0 and therefore of the task's initStateRoot, and it persists. Bits 3..15 are
 * reserved and must be zero. A state with bit2 clear evolves exactly as it did before bit2 had a meaning.
 *   ext(i, s, seed) = fmix32(fmix32(i * GOLDEN32 + seed) + s * GOLDEN32) < EXT_P_Q32
 *
 * The pinned parameter set is folded into the execution-kind digest (see lif.js).
 */
#include <stdint.h>
#define EXPORT(name) __attribute__((export_name(name)))
#define GOLDEN32 0x9E3779B9u

/* pinned parameters of int-lif:v1 (Shiu et al. values in Q16 / Q32) */
#define DT_TAU_M_Q16 328u      /* 0.1 ms / 20 ms */
#define DT_TAU_S_Q16 1311u     /* 0.1 ms / 5 ms  */
#define THRESH_Q16   458752    /* 7 mV           */
#define W_UNIT_Q16   18022     /* 0.275 mV       */
/* The weight unit is a parameter of the execution KIND, not of the rule: it is inside the kind digest, so a MEP whose
 * connectome counts synapses on another scale (MaleCNS reports ~1.6x FlyWire's for the same connection) pins another
 * unit and is another kind. The step functions take it as their LAST argument, and 0 means the default above -- which
 * is also what a caller that does not pass it at all gets, so every existing call site is unchanged. */
#define WU(w) ((w) ? (w) : (uint32_t)W_UNIT_Q16)
#define REFRACT      22u       /* 2.2 ms         */
#define EXT_P_Q32    64424509u /* 150 Hz * 0.1 ms */

void porw_keccak256(const uint8_t *in, uint32_t len, uint8_t *out);
static inline uint32_t fmix32(uint32_t h) { h ^= h >> 16; h *= 0x85EBCA6Bu; h ^= h >> 13; h *= 0xC2B2AE35u; h ^= h >> 16; return h; }
static inline uint32_t ld32(const uint8_t *p) { uint32_t v; __builtin_memcpy(&v, p, 4); return v; }
static inline int16_t ldi16(const uint8_t *p) { int16_t v; __builtin_memcpy(&v, p, 2); return v; }
static inline void st32(uint8_t *p, uint32_t v) { __builtin_memcpy(p, &v, 4); }
static inline void st16(uint8_t *p, uint16_t v) { __builtin_memcpy(p, &v, 2); }
static inline int64_t sar64(int64_t x, unsigned s) { return x >> s; } /* arithmetic shift (floor) on all targets we build */

typedef struct { int32_t v; int32_t g; uint16_t refr; uint16_t flags; uint32_t count; } lif_state_t;

EXPORT("porw_lif_params")
uint32_t porw_lif_params(uint32_t which) {
    switch (which) { case 0: return DT_TAU_M_Q16; case 1: return DT_TAU_S_Q16; case 2: return THRESH_Q16; case 3: return W_UNIT_Q16; case 4: return REFRACT; case 5: return EXT_P_Q32; default: return 0; }
}
EXPORT("porw_lif_ext")
uint32_t porw_lif_ext(uint32_t i, uint32_t step, uint32_t seed) { return fmix32(fmix32(i * GOLDEN32 + seed) + step * GOLDEN32) < EXT_P_Q32 ? 1u : 0u; }

/* canonical stimulus set for residency-claim runs: i stimulated iff fmix32(i*GOLDEN32 + seed) % 1000 == 0 */
EXPORT("porw_lif_state0_canonical")
uint32_t porw_lif_state0_canonical(lif_state_t *st, uint32_t n, uint32_t seed) {
    uint32_t k = 0;
    for (uint32_t i = 0; i < n; i++) { uint16_t f = (fmix32(i * GOLDEN32 + seed) % 1000u == 0u) ? 1u : 0u; st[i] = (lif_state_t){0, 0, 0, f, 0}; k += f; }
    return k;
}
/* explicit stimulus set (sorted or not; ids must be < n) */
EXPORT("porw_lif_state0_set")
int porw_lif_state0_set(lif_state_t *st, uint32_t n, const uint32_t *ids, uint32_t n_ids) {
    for (uint32_t i = 0; i < n; i++) st[i] = (lif_state_t){0, 0, 0, 0, 0};
    for (uint32_t j = 0; j < n_ids; j++) { if (ids[j] >= n) return 2; st[ids[j]].flags = 1; }
    return 0;
}

/* the single-neuron transition; I = signed input sum (units: synapse counts) */
static inline lif_state_t lif_step_one(lif_state_t S, int64_t I, uint32_t i, uint32_t step, uint32_t seed, uint32_t wu) {
    int64_t g = (int64_t)S.g;
    g = g - sar64(g * (int64_t)DT_TAU_S_Q16, 16) + I * (int64_t)wu;
    if (g > INT32_MAX) g = INT32_MAX; if (g < INT32_MIN) g = INT32_MIN;
    lif_state_t R; R.g = (int32_t)g; uint32_t spike;
    if (S.flags & 4u) { spike = 0; R.v = 0; R.refr = 0; }
    else if (S.flags & 1u) { spike = porw_lif_ext(i, step, seed); R.v = 0; R.refr = 0; }
    else if (S.refr > 0) { spike = 0; R.v = 0; R.refr = (uint16_t)(S.refr - 1); }
    else {
        int64_t v = (int64_t)S.v + sar64((g - (int64_t)S.v) * (int64_t)DT_TAU_M_Q16, 16);
        if (v >= THRESH_Q16) { spike = 1; v = 0; R.refr = REFRACT; } else { spike = 0; R.refr = 0; }
        R.v = (int32_t)v;
    }
    R.count = S.count + spike; R.flags = (uint16_t)((S.flags & 5u) | (spike << 1));
    return R;
}

/* silence set: OR bit2 into an already built state_0 (after state0_canonical / state0_set); ids must be < n */
EXPORT("porw_lif_state0_silence")
int porw_lif_state0_silence(lif_state_t *st, uint32_t n, const uint32_t *ids, uint32_t n_ids) {
    for (uint32_t j = 0; j < n_ids; j++) { if (ids[j] >= n) return 2; st[ids[j]].flags |= 4u; }
    return 0;
}

/* scatter step over all records (reference path): I[post] += w * spiked[pre]; acc = i64[n] scratch */
EXPORT("porw_lif_step")
int porw_lif_step(const uint8_t *syn, uint32_t n_syn, const lif_state_t *in, lif_state_t *out, int64_t *acc, uint32_t n, uint32_t step, uint32_t seed, uint32_t w_unit) {
    if (!syn || !in || !out || !acc) return 1;
    const uint32_t wu = WU(w_unit);
    for (uint32_t i = 0; i < n; i++) acc[i] = 0;
    for (uint32_t s = 0; s < n_syn; s++) {
        const uint8_t *r = syn + (uint64_t)s * 10u; uint32_t pre = ld32(r), post = ld32(r + 4);
        if (pre >= n || post >= n) return 2;
        if (in[pre].flags & 2u) acc[post] += (int64_t)ldi16(r + 8);
    }
    for (uint32_t i = 0; i < n; i++) out[i] = lif_step_one(in[i], acc[i], i, step, seed, wu);
    return 0;
}

/* CSR rows [i0, i1) via a permutation (unsorted payloads) */
EXPORT("porw_lif_step_csr_range")
int porw_lif_step_csr_range(const uint8_t *syn, const uint32_t *perm, const uint32_t *row_start, const lif_state_t *in, lif_state_t *out,
                            uint32_t n, uint32_t i0, uint32_t i1, uint32_t step, uint32_t seed, uint32_t w_unit) {
    if (i1 > n) return 1;
    const uint32_t wu = WU(w_unit);
    for (uint32_t i = i0; i < i1; i++) {
        int64_t acc = 0;
        for (uint32_t k = row_start[i]; k < row_start[i + 1]; k++) { const uint8_t *r = syn + (uint64_t)perm[k] * 10; uint32_t pre = ld32(r); if (pre >= n) return 2; if (in[pre].flags & 2u) acc += (int64_t)ldi16(r + 8); }
        out[i] = lif_step_one(in[i], acc, i, step, seed, wu);
    }
    return 0;
}
/* post-sorted publication convention: rows contiguous, stream the record range */
EXPORT("porw_lif_step_rows_direct")
int porw_lif_step_rows_direct(const uint8_t *syn, const uint32_t *row_start, const lif_state_t *in, lif_state_t *out,
                              uint32_t n, uint32_t i0, uint32_t i1, uint32_t step, uint32_t seed, uint32_t w_unit) {
    if (i1 > n) return 1;
    const uint32_t wu = WU(w_unit);
    const uint8_t *r = syn + (uint64_t)row_start[i0] * 10;
    for (uint32_t i = i0; i < i1; i++) {
        int64_t acc = 0;
        for (uint32_t k = row_start[i]; k < row_start[i + 1]; k++, r += 10) { uint32_t pre = ld32(r); if (pre >= n) return 2; if (in[pre].flags & 2u) acc += (int64_t)ldi16(r + 8); }
        out[i] = lif_step_one(in[i], acc, i, step, seed, wu);
    }
    return 0;
}

/* inclusive running signed partial sums over CSR positions [k0, k1) for the dispute row */
EXPORT("porw_lif_partial_sums")
int porw_lif_partial_sums(const uint8_t *syn, const uint32_t *perm, const lif_state_t *in, uint32_t n, uint32_t k0, uint32_t k1, int64_t *out) {
    int64_t acc = 0;
    for (uint32_t k = k0; k < k1; k++) { const uint8_t *r = syn + (uint64_t)perm[k] * 10; uint32_t pre = ld32(r); if (pre >= n) return 2; if (in[pre].flags & 2u) acc += (int64_t)ldi16(r + 8); out[k - k0] = acc; }
    return 0;
}

/* state leaves: keccak(LE32 i || v || g || LE16 refr || LE16 flags || count)  (20 bytes) */
EXPORT("porw_lif_state_leaves")
void porw_lif_state_leaves(const lif_state_t *st, uint32_t n, uint32_t first, uint8_t *out) {
    uint8_t buf[20];
    for (uint32_t i = 0; i < n; i++) {
        const lif_state_t *s = st + i;
        st32(buf, first + i); st32(buf + 4, (uint32_t)s->v); st32(buf + 8, (uint32_t)s->g); st16(buf + 12, s->refr); st16(buf + 14, s->flags); st32(buf + 16, s->count);
        porw_keccak256(buf, 20, out + (uint64_t)i * 32);
    }
}
/* spike counts (u32[n]) out of a state array — the run's result vector */
EXPORT("porw_lif_counts")
void porw_lif_counts(const lif_state_t *st, uint32_t n, uint32_t *out) { for (uint32_t i = 0; i < n; i++) out[i] = st[i].count; }
