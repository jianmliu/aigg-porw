/*
 * Deterministic integer connectome propagation (SpMV) — WebAssembly.
 *
 * Reads the resident payload's packed synapse records in place (10 bytes:
 * pre u32 LE, post u32 LE, weight u16 LE) — the inference genuinely depends on
 * the resident bytes. Pure unsigned integer fixed-point so every engine and
 * every node computes bit-identical results that others can re-execute:
 *
 *   act      : u32, Q16 in [0, 65536]           (65536 == 1.0)
 *   stimulus : act[i] = 65536 if fmix32(i*GOLDEN32 + seed) % 100 == 0 else 0
 *   step     : acc[post] += w_u16 * act[pre]     (u64, exact)
 *              act'[i]   = min(acc[i] >> 16, 65536)  (weight/65536 scaling, hard clamp)
 *
 * Activations never go negative, so no signed shifts are involved anywhere.
 */
#include <stdint.h>
#define EXPORT(name) __attribute__((export_name(name)))
#define GOLDEN32 0x9E3779B9u
#define ONE_Q16  65536u

static inline uint32_t fmix32(uint32_t h) {
    h ^= h >> 16; h *= 0x85EBCA6Bu; h ^= h >> 13; h *= 0xC2B2AE35u; h ^= h >> 16; return h;
}
static inline uint32_t ld32(const uint8_t *p) { uint32_t v; __builtin_memcpy(&v, p, 4); return v; }
static inline uint16_t ld16(const uint8_t *p) { uint16_t v; __builtin_memcpy(&v, p, 2); return v; }

EXPORT("porw_spmv_stimulus")
void porw_spmv_stimulus(uint32_t *act, uint32_t n, uint32_t seed) {
    for (uint32_t i = 0; i < n; i++) act[i] = (fmix32(i * GOLDEN32 + seed) % 100u == 0u) ? ONE_Q16 : 0u;
}

/* one propagation step; syn = pointer to the first packed synapse record; acc = u64[n] scratch */
EXPORT("porw_spmv_step")
int porw_spmv_step(const uint8_t *syn, uint32_t n_syn, const uint32_t *act_in, uint32_t *act_out,
                   uint64_t *acc, uint32_t n) {
    if (!syn || !act_in || !act_out || !acc) return 1;
    for (uint32_t i = 0; i < n; i++) acc[i] = 0;
    for (uint32_t s = 0; s < n_syn; s++) {
        const uint8_t *r = syn + (uint64_t)s * 10u;
        uint32_t pre = ld32(r), post = ld32(r + 4);
        if (pre >= n || post >= n) return 2;                 /* malformed record: fail closed */
        acc[post] += (uint64_t)ld16(r + 8) * (uint64_t)act_in[pre];
    }
    for (uint32_t i = 0; i < n; i++) { uint64_t v = acc[i] >> 16; act_out[i] = v > ONE_Q16 ? ONE_Q16 : (uint32_t)v; }
    return 0;
}
