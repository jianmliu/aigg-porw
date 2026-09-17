/*
 * Dispute commitments for the execution fraud proof — WebAssembly.
 *
 * Per-step activation commitments:
 *   act_leaf_s[i] = keccak256(LE32 i || LE32 act_s[i])         -> actRoot[s]
 * CSR (post-sorted) synapse commitments, computed once per model:
 *   perm[k]     = original synapse index of CSR position k (counting sort by post,
 *                 stable in original order)
 *   rowStart[i] = first CSR position of neuron i's incoming synapses (n+1 entries)
 *   csr_leaf[c] = keccak256(LE32 c || records perm[c*CHUNK .. min((c+1)*CHUNK, n_syn)))
 *                 (each record the packed 10 bytes: pre u32, post u32, w u16)
 *   row_leaf[i] = keccak256(LE32 i || LE32 rowStart[i])
 * The CSR order defines the summation order for the dispute's partial sums:
 *   partial[j] = sum_{k=k0}^{k0+j} w_k * act_{s-1}[pre_k]      (u64, exact)
 * u64 addition is exact and commutative, so the scatter-order SpMV used for speed
 * yields bit-identical activations; only the *partial sums* need the CSR order.
 */
#include <stdint.h>
#define EXPORT(name) __attribute__((export_name(name)))

/* keccak from commit_wasm.c */
void porw_keccak256(const uint8_t *in, uint32_t len, uint8_t *out);

static inline uint32_t ld32(const uint8_t *p) { uint32_t v; __builtin_memcpy(&v, p, 4); return v; }
static inline uint16_t ld16(const uint8_t *p) { uint16_t v; __builtin_memcpy(&v, p, 2); return v; }
static inline void st32(uint8_t *p, uint32_t v) { __builtin_memcpy(p, &v, 4); }

/* small helper: keccak(LE32 a || LE32 b) */
static void leaf32x2(uint32_t a, uint32_t b, uint8_t *out) {
    uint8_t buf[8]; st32(buf, a); st32(buf + 4, b); porw_keccak256(buf, 8, out);
}

EXPORT("porw_act_leaves")
void porw_act_leaves(const uint32_t *act, uint32_t n, uint32_t first, uint8_t *out) {
    for (uint32_t i = 0; i < n; i++) leaf32x2(first + i, act[i], out + (uint64_t)i * 32);
}

EXPORT("porw_rowstart_leaves")
void porw_rowstart_leaves(const uint32_t *row_start, uint32_t n_entries, uint32_t first, uint8_t *out) {
    for (uint32_t i = 0; i < n_entries; i++) leaf32x2(first + i, row_start[i], out + (uint64_t)i * 32);
}

/* counting sort by post neuron; row_start has n+1 entries; cursor is n scratch entries */
EXPORT("porw_csr_build")
int porw_csr_build(const uint8_t *syn, uint32_t n_syn, uint32_t n, uint32_t *row_start, uint32_t *perm, uint32_t *cursor) {
    if (!syn || !row_start || !perm || !cursor) return 1;
    for (uint32_t i = 0; i <= n; i++) row_start[i] = 0;
    for (uint32_t s = 0; s < n_syn; s++) { uint32_t post = ld32(syn + (uint64_t)s * 10 + 4); if (post >= n) return 2; row_start[post + 1]++; }
    for (uint32_t i = 1; i <= n; i++) row_start[i] += row_start[i - 1];
    for (uint32_t i = 0; i < n; i++) cursor[i] = row_start[i];
    for (uint32_t s = 0; s < n_syn; s++) { uint32_t post = ld32(syn + (uint64_t)s * 10 + 4); perm[cursor[post]++] = s; }
    return 0;
}

/* chunk leaves over CSR order: leaf c = keccak(LE32 c || records perm[c*chunk .. )) ; chunk*10+4 <= 8192 */
EXPORT("porw_csr_chunk_leaves")
int porw_csr_chunk_leaves(const uint8_t *syn, const uint32_t *perm, uint32_t n_syn, uint32_t chunk,
                          uint32_t first_chunk, uint32_t n_chunks, uint8_t *out) {
    if (chunk == 0 || chunk * 10u + 4u > 8192u) return 1;
    uint8_t buf[8192];
    for (uint32_t c = 0; c < n_chunks; c++) {
        uint32_t cc = first_chunk + c, k0 = cc * chunk, k1 = k0 + chunk; if (k1 > n_syn) k1 = n_syn;
        if (k0 >= n_syn) return 2;
        st32(buf, cc); uint32_t len = 4;
        for (uint32_t k = k0; k < k1; k++) { const uint8_t *r = syn + (uint64_t)perm[k] * 10; for (int b = 0; b < 10; b++) buf[len++] = r[b]; }
        porw_keccak256(buf, len, out + (uint64_t)c * 32);
    }
    return 0;
}

/* inclusive running partial sums over CSR positions [k0, k1): out[j] = sum_{k<=k0+j} w_k*act[pre_k] */
EXPORT("porw_csr_partial_sums")
int porw_csr_partial_sums(const uint8_t *syn, const uint32_t *perm, const uint32_t *act_in, uint32_t n,
                          uint32_t k0, uint32_t k1, uint64_t *out) {
    uint64_t acc = 0;
    for (uint32_t k = k0; k < k1; k++) {
        const uint8_t *r = syn + (uint64_t)perm[k] * 10; uint32_t pre = ld32(r); if (pre >= n) return 2;
        acc += (uint64_t)ld16(r + 8) * (uint64_t)act_in[pre]; out[k - k0] = acc;
    }
    return 0;
}

/* CSR-ordered full step (reference for the dispute semantics): act_out[i] = min(row_sum(i) >> 16, 65536) */
EXPORT("porw_spmv_step_csr")
int porw_spmv_step_csr(const uint8_t *syn, const uint32_t *perm, const uint32_t *row_start, const uint32_t *act_in,
                       uint32_t *act_out, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) {
        uint64_t acc = 0;
        for (uint32_t k = row_start[i]; k < row_start[i + 1]; k++) {
            const uint8_t *r = syn + (uint64_t)perm[k] * 10; uint32_t pre = ld32(r); if (pre >= n) return 2;
            acc += (uint64_t)ld16(r + 8) * (uint64_t)act_in[pre];
        }
        uint64_t v = acc >> 16; act_out[i] = v > 65536u ? 65536u : (uint32_t)v;
    }
    return 0;
}

/* neuron-range variant for parallel workers: rows [i0, i1) */
EXPORT("porw_spmv_step_csr_range")
int porw_spmv_step_csr_range(const uint8_t *syn, const uint32_t *perm, const uint32_t *row_start, const uint32_t *act_in,
                             uint32_t *act_out, uint32_t n, uint32_t i0, uint32_t i1) {
    if (i1 > n) return 1;
    for (uint32_t i = i0; i < i1; i++) {
        uint64_t acc = 0;
        for (uint32_t k = row_start[i]; k < row_start[i + 1]; k++) {
            const uint8_t *r = syn + (uint64_t)perm[k] * 10; uint32_t pre = ld32(r); if (pre >= n) return 2;
            acc += (uint64_t)ld16(r + 8) * (uint64_t)act_in[pre];
        }
        uint64_t v = acc >> 16; act_out[i] = v > 65536u ? 65536u : (uint32_t)v;
    }
    return 0;
}

/* Publication convention: synapse records already sorted by post (perm == identity). Then rows are
 * contiguous and a worker streams its record range sequentially — no random gathers. */
EXPORT("porw_csr_is_identity")
int porw_csr_is_identity(const uint32_t *perm, uint32_t n_syn) { for (uint32_t k = 0; k < n_syn; k++) if (perm[k] != k) return 0; return 1; }

EXPORT("porw_spmv_step_rows_direct")
int porw_spmv_step_rows_direct(const uint8_t *syn, const uint32_t *row_start, const uint32_t *act_in, uint32_t *act_out,
                               uint32_t n, uint32_t i0, uint32_t i1) {
    if (i1 > n) return 1;
    const uint8_t *r = syn + (uint64_t)row_start[i0] * 10;
    for (uint32_t i = i0; i < i1; i++) {
        uint64_t acc = 0;
        for (uint32_t k = row_start[i]; k < row_start[i + 1]; k++, r += 10) { uint32_t pre = ld32(r); if (pre >= n) return 2; acc += (uint64_t)ld16(r + 8) * (uint64_t)act_in[pre]; }
        uint64_t v = acc >> 16; act_out[i] = v > 65536u ? 65536u : (uint32_t)v;
    }
    return 0;
}
