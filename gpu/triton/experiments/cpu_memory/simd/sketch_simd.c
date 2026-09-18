/*
 * PoRW scheme-v2 tile sketch — CPU SIMD kernel.
 *
 * Bit-identical to the NumPy reference (porw_sketch/spec.py):
 *
 *   r_tile = fmix32(fmix32(slot_seed ^ tile_idx))
 *   c_j    = fmix32(r_tile + j*GOLDEN32) | 1          (j = 0..1023)
 *   s_tile = sum_j c_j * w_j   mod 2^32               (w_j = LE u32 words)
 *
 * All arithmetic is u32 wrapping, so the AVX2 lanes (8 x u32) compute exactly
 * what the scalar path does. Two code paths in one binary, chosen at runtime:
 * an AVX2 path (the ordinary-computer baseline) and a portable scalar path.
 * Tiles are independent, so the driver splits them across pthreads to pull the
 * whole memory system's bandwidth, which is the point: the sketch should be
 * bounded by DRAM, not by arithmetic.
 *
 * Exported (ctypes):
 *   int  porw_simd_backend(void)          0 = scalar, 1 = avx2
 *   int  porw_sketch_tiles(buf, n_tiles, first_tile_idx, slot_seed, out, threads)
 *   int  porw_sketch_tile_ids(buf, tile_ids, n, slot_seed, out, threads)
 * Return 0 on success, non-zero on bad arguments.
 */

#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

#define TILE_BYTES 4096u
#define TILE_WORDS 1024u
#define GOLDEN32   0x9E3779B9u
#define FMIX_M1    0x85EBCA6Bu
#define FMIX_M2    0xC2B2AE35u

static inline uint32_t fmix32(uint32_t h) {
    h ^= h >> 16; h *= FMIX_M1;
    h ^= h >> 13; h *= FMIX_M2;
    h ^= h >> 16;
    return h;
}

static inline uint32_t r_tile_of(uint32_t slot_seed, uint64_t tile_idx) {
    /* NumPy: fmix32(fmix32((slot_seed & M32) ^ tile_idx)); fmix32 masks to
     * u32 first, so truncating the u64 xor to u32 is equivalent. */
    return fmix32(fmix32((uint32_t)((uint64_t)slot_seed ^ tile_idx)));
}

/* ---------- scalar path ---------- */
static uint32_t sketch_tile_scalar(const uint8_t *tile, uint32_t slot_seed, uint64_t tile_idx) {
    uint32_t r = r_tile_of(slot_seed, tile_idx);
    uint32_t acc = 0;
    uint32_t jg = 0;
    for (uint32_t j = 0; j < TILE_WORDS; j++) {
        uint32_t w;
        memcpy(&w, tile + j * 4, 4);            /* little-endian load */
        uint32_t c = fmix32(r + jg) | 1u;
        acc += c * w;
        jg += GOLDEN32;
    }
    return acc;
}

/* ---------- AVX2 path (function multiversioning: one binary, runtime dispatch) ---------- */
#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>

__attribute__((target("avx2")))
static inline __m256i fmix32_v(__m256i h, __m256i m1, __m256i m2) {
    h = _mm256_xor_si256(h, _mm256_srli_epi32(h, 16));
    h = _mm256_mullo_epi32(h, m1);
    h = _mm256_xor_si256(h, _mm256_srli_epi32(h, 13));
    h = _mm256_mullo_epi32(h, m2);
    h = _mm256_xor_si256(h, _mm256_srli_epi32(h, 16));
    return h;
}

__attribute__((target("avx2")))
static uint32_t sketch_tile_avx2(const uint8_t *tile, uint32_t slot_seed, uint64_t tile_idx) {
    const uint32_t r = r_tile_of(slot_seed, tile_idx);
    const __m256i m1   = _mm256_set1_epi32((int)FMIX_M1);
    const __m256i m2   = _mm256_set1_epi32((int)FMIX_M2);
    const __m256i one  = _mm256_set1_epi32(1);
    const __m256i rv   = _mm256_set1_epi32((int)r);
    const __m256i step = _mm256_set1_epi32((int)(8u * GOLDEN32));
    /* lane j offsets: j*GOLDEN32 for j = 0..7 (wrapping) */
    __m256i jg = _mm256_setr_epi32(
        (int)(0u * GOLDEN32), (int)(1u * GOLDEN32), (int)(2u * GOLDEN32), (int)(3u * GOLDEN32),
        (int)(4u * GOLDEN32), (int)(5u * GOLDEN32), (int)(6u * GOLDEN32), (int)(7u * GOLDEN32));
    __m256i acc = _mm256_setzero_si256();
    for (uint32_t j = 0; j < TILE_WORDS; j += 8) {
        __m256i w = _mm256_loadu_si256((const __m256i *)(tile + j * 4));
        __m256i c = _mm256_or_si256(fmix32_v(_mm256_add_epi32(rv, jg), m1, m2), one);
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(c, w));
        jg = _mm256_add_epi32(jg, step);
    }
    /* horizontal wrapping sum of 8 u32 lanes */
    uint32_t lanes[8];
    _mm256_storeu_si256((__m256i *)lanes, acc);
    uint32_t s = 0;
    for (int i = 0; i < 8; i++) s += lanes[i];
    return s;
}

static int have_avx2(void) {
    __builtin_cpu_init();
    return __builtin_cpu_supports("avx2") ? 1 : 0;
}
#else
static int have_avx2(void) { return 0; }
static uint32_t sketch_tile_avx2(const uint8_t *t, uint32_t s, uint64_t i) { return sketch_tile_scalar(t, s, i); }
#endif

int porw_simd_backend(void) { return have_avx2(); }

typedef uint32_t (*tile_fn)(const uint8_t *, uint32_t, uint64_t);

static tile_fn pick(void) { return have_avx2() ? sketch_tile_avx2 : sketch_tile_scalar; }

/* ---------- threaded drivers ---------- */
typedef struct {
    const uint8_t *buf;
    const int64_t *tile_ids;   /* NULL => contiguous from first_tile_idx */
    uint64_t first_tile_idx;
    uint64_t begin, end;       /* [begin, end) over output positions */
    uint32_t slot_seed;
    uint32_t *out;
    tile_fn fn;
} job_t;

static void *worker(void *arg) {
    job_t *j = (job_t *)arg;
    if (j->tile_ids) {
        for (uint64_t i = j->begin; i < j->end; i++) {
            uint64_t t = (uint64_t)j->tile_ids[i];
            j->out[i] = j->fn(j->buf + t * TILE_BYTES, j->slot_seed, t);
        }
    } else {
        for (uint64_t i = j->begin; i < j->end; i++) {
            uint64_t t = j->first_tile_idx + i;
            j->out[i] = j->fn(j->buf + i * TILE_BYTES, j->slot_seed, t);
        }
    }
    return NULL;
}

static int run_jobs(const uint8_t *buf, const int64_t *tile_ids, uint64_t first_tile_idx,
                    uint64_t n, uint32_t slot_seed, uint32_t *out, int threads) {
    if (!buf || !out) return 1;
    if (n == 0) return 0;
    if (threads <= 0) {
        long nc = sysconf(_SC_NPROCESSORS_ONLN);
        threads = nc > 0 ? (int)nc : 1;
    }
    if ((uint64_t)threads > n) threads = (int)n;
    if (threads > 256) threads = 256;
    tile_fn fn = pick();

    if (threads == 1) {
        job_t j = { buf, tile_ids, first_tile_idx, 0, n, slot_seed, out, fn };
        worker(&j);
        return 0;
    }
    pthread_t th[256];
    job_t jobs[256];
    uint64_t per = n / (uint64_t)threads, rem = n % (uint64_t)threads, pos = 0;
    for (int k = 0; k < threads; k++) {
        uint64_t len = per + ((uint64_t)k < rem ? 1 : 0);
        jobs[k] = (job_t){ buf, tile_ids, first_tile_idx, pos, pos + len, slot_seed, out, fn };
        pos += len;
        if (pthread_create(&th[k], NULL, worker, &jobs[k]) != 0) {
            /* fall back: run remaining inline */
            for (int m = k; m < threads; m++) {
                if (m > k) {
                    uint64_t l2 = per + ((uint64_t)m < rem ? 1 : 0);
                    jobs[m] = (job_t){ buf, tile_ids, first_tile_idx, pos, pos + l2, slot_seed, out, fn };
                    pos += l2;
                }
                worker(&jobs[m]);
            }
            for (int m = 0; m < k; m++) pthread_join(th[m], NULL);
            return 0;
        }
    }
    for (int k = 0; k < threads; k++) pthread_join(th[k], NULL);
    return 0;
}

int porw_sketch_tiles(const uint8_t *buf, uint64_t n_tiles, uint64_t first_tile_idx,
                      uint32_t slot_seed, uint32_t *out, int threads) {
    return run_jobs(buf, NULL, first_tile_idx, n_tiles, slot_seed, out, threads);
}

int porw_sketch_tile_ids(const uint8_t *buf, const int64_t *tile_ids, uint64_t n,
                         uint32_t slot_seed, uint32_t *out, int threads) {
    if (!tile_ids) return 1;
    return run_jobs(buf, tile_ids, 0, n, slot_seed, out, threads);
}

/* ---------- threaded streaming-read baseline (aggregate DRAM bandwidth) ----------
 * Sums the buffer as u64 words across threads. This is the apples-to-apples
 * memory ceiling for the threaded sketch: a single core cannot pull the whole
 * memory system's bandwidth, so a single-threaded read under-reports it. */
typedef struct { const uint64_t *p; uint64_t begin, end; uint64_t acc; } rjob_t;

static void *rworker(void *a) {
    rjob_t *j = (rjob_t *)a;
    uint64_t s = 0;
    for (uint64_t i = j->begin; i < j->end; i++) s += j->p[i];
    j->acc = s;
    return NULL;
}

int porw_read_sum(const uint8_t *buf, uint64_t n_bytes, int threads, uint64_t *out) {
    if (!buf || !out) return 1;
    uint64_t n = n_bytes / 8;
    if (threads <= 0) {
        long nc = sysconf(_SC_NPROCESSORS_ONLN);
        threads = nc > 0 ? (int)nc : 1;
    }
    if ((uint64_t)threads > n) threads = n ? (int)n : 1;
    if (threads > 256) threads = 256;
    const uint64_t *p = (const uint64_t *)buf;
    pthread_t th[256];
    rjob_t jobs[256];
    uint64_t per = n / (uint64_t)threads, rem = n % (uint64_t)threads, pos = 0;
    int spawned = 0;
    for (int k = 0; k < threads; k++) {
        uint64_t len = per + ((uint64_t)k < rem ? 1 : 0);
        jobs[k] = (rjob_t){ p, pos, pos + len, 0 };
        pos += len;
        if (threads == 1 || pthread_create(&th[k], NULL, rworker, &jobs[k]) != 0) {
            rworker(&jobs[k]);
        } else {
            spawned = k + 1;
        }
    }
    uint64_t total = 0;
    for (int k = 0; k < threads; k++) {
        if (k < spawned) pthread_join(th[k], NULL);
        total += jobs[k].acc;
    }
    /* tail bytes (n_bytes % 8) are ignored: a bandwidth probe, not a checksum */
    *out = total;
    return 0;
}
