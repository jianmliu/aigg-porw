/*
 * PoRW scheme-v2 tile sketch — WebAssembly kernel (SIMD128 + scalar fallback).
 *
 * Bit-identical to the NumPy reference and the native C kernel
 * (experiments/cpu_memory/simd/sketch_simd.c):
 *
 *   r_tile = fmix32(fmix32(slot_seed ^ tile_idx))
 *   c_j    = fmix32(r_tile + j*GOLDEN32) | 1          (j = 0..1023)
 *   s_tile = sum_j c_j * w_j   mod 2^32               (w_j = LE u32 words)
 *
 * All arithmetic is u32 wrapping, so the 4 x u32 SIMD128 lanes compute exactly
 * what the scalar path does. Threads are Web Workers on the JS side: each
 * worker owns a slice of the weights and sketches it with the right starting
 * tile index, so no shared memory is needed.
 *
 * Built freestanding (-nostdlib); a bump allocator over __heap_base grows the
 * wasm memory on demand. Also exports a deterministic buffer filler so the
 * browser can materialize a large test payload without a 500 MiB download:
 *   word[i] = fmix32(i*GOLDEN32 + seed)   — reproduced exactly on the Python side.
 */

#include <stdint.h>

#define TILE_BYTES 4096u
#define TILE_WORDS 1024u
#define GOLDEN32   0x9E3779B9u
#define FMIX_M1    0x85EBCA6Bu
#define FMIX_M2    0xC2B2AE35u

#define EXPORT(name) __attribute__((export_name(name)))

static inline uint32_t fmix32(uint32_t h) {
    h ^= h >> 16; h *= FMIX_M1;
    h ^= h >> 13; h *= FMIX_M2;
    h ^= h >> 16;
    return h;
}

static inline uint32_t r_tile_of(uint32_t slot_seed, uint32_t tile_idx) {
    return fmix32(fmix32(slot_seed ^ tile_idx));
}

static inline uint32_t load_u32(const uint8_t *p) {
    uint32_t w;
    __builtin_memcpy(&w, p, 4);   /* inlines to an unaligned i32 load */
    return w;
}

/* ---------- scalar ---------- */
__attribute__((unused)) static uint32_t sketch_tile_scalar(const uint8_t *tile, uint32_t slot_seed, uint32_t tile_idx) {
    uint32_t r = r_tile_of(slot_seed, tile_idx), acc = 0, jg = 0;
    for (uint32_t j = 0; j < TILE_WORDS; j++) {
        uint32_t c = fmix32(r + jg) | 1u;
        acc += c * load_u32(tile + j * 4);
        jg += GOLDEN32;
    }
    return acc;
}

/* ---------- SIMD128 ---------- */
#ifdef __wasm_simd128__
#include <wasm_simd128.h>

static inline v128_t fmix32_v(v128_t h) {
    h = wasm_v128_xor(h, wasm_u32x4_shr(h, 16));
    h = wasm_i32x4_mul(h, wasm_i32x4_splat((int32_t)FMIX_M1));
    h = wasm_v128_xor(h, wasm_u32x4_shr(h, 13));
    h = wasm_i32x4_mul(h, wasm_i32x4_splat((int32_t)FMIX_M2));
    h = wasm_v128_xor(h, wasm_u32x4_shr(h, 16));
    return h;
}

static uint32_t sketch_tile_simd(const uint8_t *tile, uint32_t slot_seed, uint32_t tile_idx) {
    const uint32_t r = r_tile_of(slot_seed, tile_idx);
    const v128_t rv   = wasm_i32x4_splat((int32_t)r);
    const v128_t one  = wasm_i32x4_splat(1);
    const v128_t step = wasm_i32x4_splat((int32_t)(4u * GOLDEN32));
    v128_t jg  = wasm_i32x4_make(0, (int32_t)GOLDEN32, (int32_t)(2u * GOLDEN32), (int32_t)(3u * GOLDEN32));
    v128_t acc = wasm_i32x4_splat(0);
    for (uint32_t j = 0; j < TILE_WORDS; j += 4) {
        v128_t w = wasm_v128_load(tile + j * 4);
        v128_t c = wasm_v128_or(fmix32_v(wasm_i32x4_add(rv, jg)), one);
        acc = wasm_i32x4_add(acc, wasm_i32x4_mul(c, w));
        jg = wasm_i32x4_add(jg, step);
    }
    return (uint32_t)wasm_i32x4_extract_lane(acc, 0) + (uint32_t)wasm_i32x4_extract_lane(acc, 1)
         + (uint32_t)wasm_i32x4_extract_lane(acc, 2) + (uint32_t)wasm_i32x4_extract_lane(acc, 3);
}
#define TILE_FN sketch_tile_simd
#define BACKEND 1
#else
#define TILE_FN sketch_tile_scalar
#define BACKEND 0
#endif

EXPORT("porw_simd_backend") int porw_simd_backend(void) { return BACKEND; }

/* Sketch n_tiles consecutive tiles of buf; coefficient index = first_tile_idx + i. */
EXPORT("porw_sketch_tiles")
int porw_sketch_tiles(const uint8_t *buf, uint32_t n_tiles, uint32_t first_tile_idx,
                      uint32_t slot_seed, uint32_t *out) {
    if (!buf || !out) return 1;
    for (uint32_t i = 0; i < n_tiles; i++)
        out[i] = TILE_FN(buf + (uint64_t)i * TILE_BYTES, slot_seed, first_tile_idx + i);
    return 0;
}

/* Deterministic test payload: word[i] = fmix32(i*GOLDEN32 + seed), i = word_offset.. */
EXPORT("porw_fill_pattern")
void porw_fill_pattern(uint8_t *buf, uint32_t n_words, uint32_t word_offset, uint32_t seed) {
    for (uint32_t i = 0; i < n_words; i++) {
        uint32_t w = fmix32((word_offset + i) * GOLDEN32 + seed);
        __builtin_memcpy(buf + (uint64_t)i * 4, &w, 4);
    }
}

/* ---------- bump allocator over the wasm heap ---------- */
extern unsigned char __heap_base;
static uintptr_t heap_top = 0;

EXPORT("porw_alloc")
void *porw_alloc(uint32_t n) {
    if (heap_top == 0) heap_top = (uintptr_t)&__heap_base;
    uint64_t p = ((uint64_t)heap_top + 15u) & ~(uint64_t)15u;
    uint64_t end = p + n;
    /* The heap mark is wasm32 too: never let alignment or addition wrap it. */
    if (end >= ((uint64_t)1 << 32)) return 0;
    uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
    if (end > have) {
        uintptr_t need = (uintptr_t)((end - have + 65535u) / 65536u);
        if (__builtin_wasm_memory_grow(0, need) == (uintptr_t)-1) return 0;
    }
    heap_top = (uintptr_t)end;
    return (void *)(uintptr_t)p;
}

EXPORT("porw_reset_heap") void porw_reset_heap(void) { heap_top = (uintptr_t)&__heap_base; }
/* mark/release: reclaim scratch allocated after a mark; the resident model below it is untouched */
EXPORT("porw_heap_mark") uint32_t porw_heap_mark(void) { if (heap_top == 0) heap_top = (uintptr_t)&__heap_base; return (uint32_t)heap_top; }
EXPORT("porw_heap_release") void porw_heap_release(uint32_t mark) { heap_top = mark; }
