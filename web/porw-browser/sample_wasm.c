/* Exact fixed-point implementation of sample.js. 12 little-endian u32 limbs
 * cover all intermediates (at most 328 bits) for serialized parameter bounds.
 * Division is unsigned base-2^32 long division; signed floor rounding in the
 * nonpositive logarithm/exponent path is expressed with positive magnitudes. */
#include "sample_wasm.h"
#define EXPORT(n) __attribute__((export_name(n)))
#define N 12
#define Q60 (UINT64_C(1) << 60)
#define LN2 UINT64_C(799144290325165978)
typedef struct {
    uint32_t v[N];
} Big;
extern void *porw_alloc(uint32_t);
extern uint32_t porw_heap_mark(void);
extern void porw_heap_release(uint32_t);
/* Check in u64 before any wasm32 pointer arithmetic or memory access. */
static int valid_range(const void *p, uint64_t bytes) {
    return (!bytes || p) &&
           (uint64_t)(uintptr_t)p + bytes <= (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
}
static Big small(uint64_t n) {
    Big a = {{0}};
    a.v[0] = (uint32_t)n;
    a.v[1] = n >> 32;
    return a;
}
static int bits(Big a) {
    for (int i = N - 1; i >= 0; i--)
        if (a.v[i])
            return i * 32 + 32 - __builtin_clz(a.v[i]);
    return 0;
}
static int cmp(Big a, Big b) {
    for (int i = N - 1; i >= 0; i--)
        if (a.v[i] != b.v[i])
            return a.v[i] > b.v[i] ? 1 : -1;
    return 0;
}
static Big add(Big a, Big b) {
    uint64_t c = 0;
    for (int i = 0; i < N; i++) {
        c += (uint64_t)a.v[i] + b.v[i];
        a.v[i] = (uint32_t)c;
        c >>= 32;
    }
    return a;
}
static Big sub(Big a, Big b) {
    uint64_t borrow = 0;
    for (int i = 0; i < N; i++) {
        uint64_t d = (uint64_t)b.v[i] + borrow;
        borrow = (uint64_t)a.v[i] < d;
        a.v[i] -= (uint32_t)d;
    }
    return a;
}
static Big shl(Big a, int s) {
    Big b = {{0}};
    if (s >= N * 32)
        return b;
    for (int i = 0; i < N; i++) {
        int j = i + s / 32;
        if (j < N)
            b.v[j] |= a.v[i] << (s % 32);
        if (s % 32 && j + 1 < N)
            b.v[j + 1] |= a.v[i] >> (32 - s % 32);
    }
    return b;
}
static Big shr(Big a, int s) {
    Big b = {{0}};
    if (s >= N * 32)
        return b;
    for (int i = s / 32; i < N; i++) {
        int j = i - s / 32;
        b.v[j] |= a.v[i] >> (s % 32);
        if (s % 32 && j > 0)
            b.v[j - 1] |= a.v[i] << (32 - s % 32);
    }
    return b;
}
static Big mul(Big a, Big b) {
    Big o = {{0}};
    int na = (bits(a) + 31) / 32, nb = (bits(b) + 31) / 32;
    for (int i = 0; i < na; i++) {
        uint64_t carry = 0;
        int j = 0;
        for (; j < nb && i + j < N; j++) {
            uint64_t x = (uint64_t)a.v[i] * b.v[j] + o.v[i + j] + carry;
            o.v[i + j] = (uint32_t)x;
            carry = x >> 32;
        }
        if (i + j < N)
            o.v[i + j] = (uint32_t)carry;
    }
    return o;
}
/* Exact base-2^32 long division (Knuth D). Divisors are positive and at
 * most 71 bits (three limbs); numerator intermediates use at most 11 limbs.
 * Normalization gives a top divisor limb >= 2^31, bounding quotient
 * estimation to two corrections. u has one extra normalization limb. */
static Big divide(Big a, Big b) {
    Big q = {{0}};
    int na = (bits(a) + 31) / 32;
    int nb = (bits(b) + 31) / 32;
    if (na < nb)
        return q;
    /* Factoring powers of two preserves the floored quotient and turns the
     * exp series divisor k*Q60 into a single machine-word division. */
    int zeros = 0;
    while (!b.v[zeros / 32])
        zeros += 32;
    zeros += __builtin_ctz(b.v[zeros / 32]);
    if (zeros) {
        a = shr(a, zeros);
        b = shr(b, zeros);
        na = (bits(a) + 31) / 32;
        nb = (bits(b) + 31) / 32;
        if (na < nb)
            return q;
    }
    if (na <= 2) {
        uint64_t av = (uint64_t)a.v[0] | ((uint64_t)a.v[1] << 32);
        uint64_t bv = (uint64_t)b.v[0] | ((uint64_t)b.v[1] << 32);
        return small(av / bv);
    }
    if (nb == 1) {
        uint64_t rem = 0;
        for (int i = na - 1; i >= 0; i--) {
            uint64_t x = (rem << 32) | a.v[i];
            q.v[i] = (uint32_t)(x / b.v[0]);
            rem = x % b.v[0];
        }
        return q;
    }
    uint32_t u[N + 1] = {0}, v[3] = {0};
    unsigned shift = __builtin_clz(b.v[nb - 1]);
    uint64_t carry = 0;
    for (int i = 0; i < na; i++) {
        uint64_t x = ((uint64_t)a.v[i] << shift) | carry;
        u[i] = (uint32_t)x;
        carry = x >> 32;
    }
    u[na] = (uint32_t)carry;
    carry = 0;
    for (int i = 0; i < nb; i++) {
        uint64_t x = ((uint64_t)b.v[i] << shift) | carry;
        v[i] = (uint32_t)x;
        carry = x >> 32;
    }
    const uint64_t base = UINT64_C(1) << 32;
    for (int j = na - nb; j >= 0; j--) {
        uint64_t top = ((uint64_t)u[j + nb] << 32) | u[j + nb - 1];
        uint64_t guess, rem;
        if (u[j + nb] == v[nb - 1]) {
            guess = base - 1;
            rem = (uint64_t)u[j + nb - 1] + v[nb - 1];
        } else {
            guess = top / v[nb - 1];
            rem = top % v[nb - 1];
        }
        while (rem < base && guess * v[nb - 2] > (rem << 32) + u[j + nb - 2]) {
            guess--;
            rem += v[nb - 1];
        }
        uint64_t borrow = 0;
        for (int i = 0; i < nb; i++) {
            uint64_t product = guess * v[i] + borrow;
            uint32_t old = u[j + i];
            u[j + i] -= (uint32_t)product;
            borrow = (product >> 32) + (old < (uint32_t)product);
        }
        uint32_t old = u[j + nb];
        u[j + nb] -= (uint32_t)borrow;
        if ((uint64_t)old < borrow) {
            guess--;
            uint64_t sum = 0;
            for (int i = 0; i < nb; i++) {
                sum += (uint64_t)u[j + i] + v[i];
                u[j + i] = (uint32_t)sum;
                sum >>= 32;
            }
            u[j + nb] += (uint32_t)sum;
        }
        q.v[j] = (uint32_t)guess;
    }
    return q;
}
static uint64_t low(Big a) { return (uint64_t)a.v[0] | ((uint64_t)a.v[1] << 32); }
/* ln(pn/pd) is nonpositive. Return its negation exactly. */
static Big neg_ln(uint64_t pn, uint64_t pd) {
    Big a = small(pn), b = small(pd);
    int e = bits(a) - bits(b);
    if (cmp(shl(a, e >= 0 ? 60 : 60 - e), shl(b, e >= 0 ? 60 + e : 60)) < 0)
        e--;
    Big y = divide(shl(a, 60 - e), b);
    Big t = divide(shl(sub(y, small(Q60)), 60), add(y, small(Q60)));
    Big t2 = shr(mul(t, t), 60), p = t, acc = t;
    for (int k = 1; k <= 30; k++) {
        p = shr(mul(p, t2), 60);
        acc = add(acc, divide(p, small(2 * k + 1)));
    }
    return sub(mul(small((uint32_t)-e), small(LN2)), shl(acc, 1));
}
static Big probability0(uint32_t R, uint64_t pn, uint64_t pd) {
    Big mag = shr(add(mul(small(R), neg_ln(pn, pd)), small(255)), 8);
    uint64_t n = low(divide(add(mag, small(LN2 - 1)), small(LN2)));
    Big f = sub(mul(small(n), small(LN2)), mag), term = small(Q60), acc = term;
    for (int k = 1; k <= 40; k++) {
        term = divide(mul(term, f), shl(small(k), 60));
        acc = add(acc, term);
    }
    if (n <= 196)
        return shl(acc, 196 - (int)n);
    return shr(acc, (int)n - 196);
}
static uint32_t fmix(uint32_t h) {
    h ^= h >> 16;
    h *= 0x85ebca6b;
    h ^= h >> 13;
    h *= 0xc2b2ae35;
    return h ^ (h >> 16);
}
EXPORT("porw_hash64") uint64_t porw_hash64(uint32_t sl, uint32_t sh, uint32_t a, uint32_t b) {
    uint32_t h = fmix(fmix((a * 0x9e3779b9u + b) ^ sl) ^ sh);
    uint32_t l = fmix((b * 0x9e3779b9u + a) ^ h ^ 0x85ebca6bu);
    return ((uint64_t)h << 32) | l;
}
EXPORT("porw_nb_table")
int porw_nb_table(uint32_t c, uint32_t R, uint32_t MR, uint32_t kmax, uint64_t *out,
                  uint32_t capacity) {
    if (c > 32768 || !R || R > 65535 || kmax > 32767 || !out || capacity < kmax + 1 ||
        !valid_range(out, (uint64_t)capacity * 8))
        return -1;
    uint64_t cm = (uint64_t)c * MR, pn = 256u * R, pd = pn + cm;
    Big p = probability0(R, pn, pd), cum = p, limit = sub(shl(small(1), 256), small(1));
    out[0] = low(shr(cum, 192));
    uint32_t len = 1;
    for (uint32_t k = 0; k < kmax; k++) {
        Big num = mul(small(256u * k + R), small(cm)), den = mul(small(256u * (k + 1)), small(pd));
        p = divide(mul(p, num), den);
        if (!bits(p) && (uint64_t)65536 * (k + 1) > cm)
            break;
        cum = add(cum, p);
        out[len++] = low(shr(cmp(cum, limit) < 0 ? cum : limit, 192));
    }
    out[len - 1] = UINT64_MAX;
    return (int)len;
}
EXPORT("porw_sample_from_table")
uint32_t porw_sample_from_table(const uint64_t *t, uint32_t n, uint64_t u) {
    uint32_t lo = 0, hi = n - 1;
    if (t[hi] <= u)
        return hi;
    while (lo < hi) {
        uint32_t m = (lo + hi) / 2;
        if (t[m] > u)
            hi = m;
        else
            lo = m + 1;
    }
    return lo;
}
static uint32_t ld32(const uint8_t *p) {
    uint32_t n;
    __builtin_memcpy(&n, p, 4);
    return n;
}
static uint32_t count(const uint8_t *p) {
    int16_t n;
    __builtin_memcpy(&n, p + 8, 2);
    return n < 0 ? -(int32_t)n : n;
}
EXPORT("porw_sample_records")
int porw_sample_records(const uint8_t *records, uint32_t n, uint32_t sl, uint32_t sh, uint32_t MR,
                        const uint32_t *rows, uint32_t nr, uint32_t *out) {
    if (!nr || nr > 65535 || !valid_range(rows, (uint64_t)nr * 8) ||
        !valid_range(records, (uint64_t)n * 10) || !valid_range(out, (uint64_t)n * 4))
        return -1;
    /* Output temporarily holds linked indices, so aliasing either input
     * could corrupt a chain or a later record. Reject it before any write. */
    uint64_t output_start = (uintptr_t)out, output_end = output_start + (uint64_t)n * 4;
    uint64_t record_start = (uintptr_t)records, record_end = record_start + (uint64_t)n * 10;
    uint64_t row_start = (uintptr_t)rows, row_end = row_start + (uint64_t)nr * 8;
    if (n && ((output_start < record_end && record_start < output_end) ||
              (output_start < row_end && row_start < output_end)))
        return -1;
    if (rows[0] != 1)
        return -1;
    for (uint32_t i = 0; i < nr; i++)
        if (!rows[i * 2 + 1] || rows[i * 2 + 1] > 65535 || (i && rows[i * 2] <= rows[(i - 1) * 2]))
            return -1;
    uint32_t mark = porw_heap_mark();
    uint32_t *heads = porw_alloc(32769 * sizeof(*heads));
    uint64_t *table = porw_alloc(32768 * sizeof(*table));
    int status = -2;
    if (!heads || !table)
        goto done;
    for (uint32_t c = 0; c <= 32768; c++)
        heads[c] = UINT32_MAX;
    /* Build per-count index chains directly in the caller's output array.
     * Replacing each link with its final sample after reading the next link
     * needs no n-sized temporary array. Each distinct CDF is built once,
     * and total sampler scratch stays below 385 KiB at every input size. */
    for (uint32_t i = 0; i < n; i++) {
        uint32_t c = count(records + (uint64_t)i * 10);
        out[i] = heads[c];
        heads[c] = i;
    }
    uint32_t row = 0;
    for (uint32_t c = 0; c <= 32768; c++) {
        if (heads[c] == UINT32_MAX)
            continue;
        while (row + 1 < nr && rows[(row + 1) * 2] <= c)
            row++;
        uint32_t km = 8 * c + 256;
        if (km > 32767)
            km = 32767;
        int len = porw_nb_table(c, rows[row * 2 + 1], MR, km, table, 32768);
        if (len < 0) {
            status = len;
            goto done;
        }
        uint32_t i = heads[c];
        while (i != UINT32_MAX) {
            uint32_t next = out[i];
            const uint8_t *r = records + (uint64_t)i * 10;
            out[i] = porw_sample_from_table(table, (uint32_t)len,
                                            porw_hash64(sl, sh, ld32(r), ld32(r + 4)));
            i = next;
        }
    }
    status = 0;
done:
    porw_heap_release(mark);
    return status;
}
