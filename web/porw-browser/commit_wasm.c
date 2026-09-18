/*
 * PoRW keccak-scheme commitments for the browser node — WebAssembly.
 *
 * Scheme `aigg:porw:sketch-tile-keccak:v1`: sketch math identical to
 * sketch-tile:v2, every hash keccak256 (EVM-native). Bit-identical to the
 * Rust reference (subspace_proof_of_residency::keccak) and the Solidity
 * verifier; validated against the aigg-spec conformance vector.
 *
 *   weights_leaf   = keccak256(LE64 tile_idx || tile_bytes[4096])
 *   partials_leaf  = keccak256(LE64 tile_idx || LE32 s_tile)
 *   parent         = keccak256(left || right)        (duplicate-last padding)
 *   slot_seed      = first 4 LE bytes of keccak256(challenge32 || device_id32)
 *
 * Freestanding: no libc. keccak-f[1600] on 64-bit lanes (wasm has i64).
 */

#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(name)))
#define TILE_BYTES 4096u
#define RATE 136u

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};
static const uint8_t RHO[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
static const uint8_t PI[24]  = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};

static inline uint64_t rotl64(uint64_t x, unsigned n) { return (x << n) | (x >> (64 - n)); }

static void keccakf(uint64_t st[25]) {
    uint64_t bc[5], t;
    for (int r = 0; r < 24; r++) {
        for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (int i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
        }
        t = st[1];
        for (int i = 0; i < 24; i++) { int j = PI[i]; bc[0] = st[j]; st[j] = rotl64(t, RHO[i]); t = bc[0]; }
        for (int j = 0; j < 25; j += 5) {
            for (int i = 0; i < 5; i++) bc[i] = st[j + i];
            for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        st[0] ^= RC[r];
    }
}

typedef struct { uint64_t st[25]; uint32_t pos; } kctx;

static inline void kinit(kctx *c) { for (int i = 0; i < 25; i++) c->st[i] = 0; c->pos = 0; }

static inline void kbyte(kctx *c, uint8_t b) {
    ((uint8_t *)c->st)[c->pos++] ^= b;      /* wasm is little-endian: lane bytes are in order */
    if (c->pos == RATE) { keccakf(c->st); c->pos = 0; }
}

static void kupdate(kctx *c, const uint8_t *p, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) kbyte(c, p[i]);
}

static void kfinal(kctx *c, uint8_t out[32]) {
    ((uint8_t *)c->st)[c->pos] ^= 0x01;      /* original Keccak padding (not SHA3's 0x06) */
    ((uint8_t *)c->st)[RATE - 1] ^= 0x80;
    keccakf(c->st);
    for (int i = 0; i < 32; i++) out[i] = ((uint8_t *)c->st)[i];
}

static inline void kupdate_le64(kctx *c, uint32_t lo) {
    for (int i = 0; i < 4; i++) kbyte(c, (uint8_t)(lo >> (8 * i)));
    for (int i = 0; i < 4; i++) kbyte(c, 0);
}

EXPORT("porw_keccak256")
void porw_keccak256(const uint8_t *in, uint32_t len, uint8_t *out) {
    kctx c; kinit(&c); kupdate(&c, in, len); kfinal(&c, out);
}

/* weights leaves for n consecutive tiles of buf; leaf i = keccak(LE64(first+i) || tile_i) */
EXPORT("porw_weights_leaves")
void porw_weights_leaves(const uint8_t *buf, uint32_t n_tiles, uint32_t first_tile_idx, uint8_t *out) {
    for (uint32_t i = 0; i < n_tiles; i++) {
        kctx c; kinit(&c);
        kupdate_le64(&c, first_tile_idx + i);
        kupdate(&c, buf + (uint64_t)i * TILE_BYTES, TILE_BYTES);
        kfinal(&c, out + (uint64_t)i * 32);
    }
}

/* partials leaves: leaf i = keccak(LE64 tile_idx_i || LE32 s_tile_i); tile_ids NULL => first+i */
EXPORT("porw_partials_leaves")
void porw_partials_leaves(const uint32_t *tile_ids, const uint32_t *sketches, uint32_t n,
                          uint32_t first_tile_idx, uint8_t *out) {
    for (uint32_t i = 0; i < n; i++) {
        uint32_t t = tile_ids ? tile_ids[i] : first_tile_idx + i;
        kctx c; kinit(&c);
        kupdate_le64(&c, t);
        for (int k = 0; k < 4; k++) kbyte(&c, (uint8_t)(sketches[i] >> (8 * k)));
        kfinal(&c, out + (uint64_t)i * 32);
    }
}

static inline void parent(const uint8_t *l, const uint8_t *r, uint8_t *out) {
    kctx c; kinit(&c); kupdate(&c, l, 32); kupdate(&c, r, 32); kfinal(&c, out);
}

static inline void copy32(uint8_t *d, const uint8_t *s) { for (int i = 0; i < 32; i++) d[i] = s[i]; }

/* Merkle root over n leaves (32 B each), duplicate-last padding. scratch: n*32 bytes. */
EXPORT("porw_merkle_root")
void porw_merkle_root(const uint8_t *leaves, uint32_t n, uint8_t *scratch, uint8_t *out) {
    if (n == 0) { porw_keccak256(leaves, 0, out); return; }
    for (uint64_t i = 0; i < (uint64_t)n * 32; i++) scratch[i] = leaves[i];
    uint32_t w = n;
    while (w > 1) {
        uint32_t nw = (w + 1) / 2;
        for (uint32_t i = 0; i < nw; i++) {
            const uint8_t *l = scratch + (uint64_t)(2 * i) * 32;
            const uint8_t *r = (2 * i + 1 < w) ? scratch + (uint64_t)(2 * i + 1) * 32 : l;
            uint8_t tmp[32]; parent(l, r, tmp);
            copy32(scratch + (uint64_t)i * 32, tmp);
        }
        w = nw;
    }
    copy32(out, scratch);
}

/* Merkle proof for leaf `index`: sibling hashes bottom-up into out_proof (32 B each). Returns depth. */
EXPORT("porw_merkle_proof")
uint32_t porw_merkle_proof(const uint8_t *leaves, uint32_t n, uint32_t index, uint8_t *scratch,
                           uint8_t *out_proof, uint32_t max_depth) {
    if (n == 0 || index >= n) return 0xFFFFFFFFu;
    for (uint64_t i = 0; i < (uint64_t)n * 32; i++) scratch[i] = leaves[i];
    uint32_t w = n, depth = 0;
    while (w > 1) {
        if (depth >= max_depth) return 0xFFFFFFFEu;
        uint32_t sib = (index & 1u) ? index - 1 : index + 1;
        if (sib >= w) sib = index;                     /* duplicate-last */
        copy32(out_proof + (uint64_t)depth * 32, scratch + (uint64_t)sib * 32);
        depth++;
        uint32_t nw = (w + 1) / 2;
        for (uint32_t i = 0; i < nw; i++) {
            const uint8_t *l = scratch + (uint64_t)(2 * i) * 32;
            const uint8_t *r = (2 * i + 1 < w) ? scratch + (uint64_t)(2 * i + 1) * 32 : l;
            uint8_t tmp[32]; parent(l, r, tmp);
            copy32(scratch + (uint64_t)i * 32, tmp);
        }
        w = nw; index >>= 1;
    }
    return depth;
}

/* slot_seed = LE u32 of the first 4 bytes of keccak256(challenge32 || device32) */
EXPORT("porw_slot_seed")
uint32_t porw_slot_seed(const uint8_t *challenge, const uint8_t *device_id) {
    kctx c; kinit(&c); kupdate(&c, challenge, 32); kupdate(&c, device_id, 32);
    uint8_t d[32]; kfinal(&c, d);
    return (uint32_t)d[0] | ((uint32_t)d[1] << 8) | ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 24);
}

/* ---------- cached Merkle tree: build once, O(log n) proofs ----------
 * Layout: level 0 (n leaves), level 1 (ceil(n/2)), ..., root; 32 B per node.
 * A node answering many audits must not rebuild the tree per proof. */
EXPORT("porw_merkle_tree_nodes")
uint32_t porw_merkle_tree_nodes(uint32_t n) {
    uint32_t total = 0, w = n ? n : 1;
    for (;;) { total += w; if (w == 1) break; w = (w + 1) / 2; }
    return total;
}

EXPORT("porw_merkle_tree_build")
uint32_t porw_merkle_tree_build(const uint8_t *leaves, uint32_t n, uint8_t *tree) {
    if (n == 0) { porw_keccak256(leaves, 0, tree); return 1; }
    for (uint64_t i = 0; i < (uint64_t)n * 32; i++) tree[i] = leaves[i];
    uint32_t w = n, off = 0, levels = 1;
    while (w > 1) {
        uint32_t nw = (w + 1) / 2, noff = off + w;
        for (uint32_t i = 0; i < nw; i++) {
            const uint8_t *l = tree + (uint64_t)(off + 2 * i) * 32;
            const uint8_t *r = (2 * i + 1 < w) ? tree + (uint64_t)(off + 2 * i + 1) * 32 : l;
            parent(l, r, tree + (uint64_t)(noff + i) * 32);
        }
        off = noff; w = nw; levels++;
    }
    return levels;
}

EXPORT("porw_merkle_tree_proof")
uint32_t porw_merkle_tree_proof(const uint8_t *tree, uint32_t n, uint32_t index, uint8_t *out, uint32_t max_depth) {
    if (n == 0 || index >= n) return 0xFFFFFFFFu;
    uint32_t w = n, off = 0, depth = 0;
    while (w > 1) {
        if (depth >= max_depth) return 0xFFFFFFFEu;
        uint32_t sib = (index & 1u) ? index - 1 : index + 1;
        if (sib >= w) sib = index;
        copy32(out + (uint64_t)depth * 32, tree + (uint64_t)(off + sib) * 32);
        depth++; off += w; w = (w + 1) / 2; index >>= 1;
    }
    return depth;
}

/* ---------- parallel tree build: aligned blocks of 2^m leaves ----------
 * Non-last blocks are full, so their subtrees are exactly the global tree's nodes; the
 * duplicate-last rule only ever fires inside the last block. Workers build levels 0..m of
 * their blocks in place; the main thread finishes levels m+1..root. */
static inline uint32_t level_width(uint32_t n, uint32_t l) { uint32_t w = n; for (uint32_t i = 0; i < l; i++) w = (w + 1) / 2; return w; }
static inline uint32_t level_offset(uint32_t n, uint32_t l) { uint32_t off = 0, w = n; for (uint32_t i = 0; i < l; i++) { off += w; w = (w + 1) / 2; } return off; }

EXPORT("porw_merkle_tree_build_blocks")
int porw_merkle_tree_build_blocks(const uint8_t *leaves, uint32_t n, uint8_t *tree, uint32_t m,
                                  uint32_t first_block, uint32_t n_blocks) {
    if (n == 0 || m > 31) return 1;
    uint32_t block = 1u << m;
    for (uint32_t b = first_block; b < first_block + n_blocks; b++) {
        uint32_t first = b * block; if (first >= n) return 2;
        uint32_t end = first + block; if (end > n) end = n;
        for (uint64_t i = (uint64_t)first * 32; i < (uint64_t)end * 32; i++) tree[i] = leaves[i];
        for (uint32_t l = 1; l <= m; l++) {
            uint32_t wl = level_width(n, l), wprev = level_width(n, l - 1);
            uint32_t offl = level_offset(n, l), offprev = level_offset(n, l - 1);
            uint32_t i0 = first >> l, i1 = (end + (1u << l) - 1) >> l; if (i1 > wl) i1 = wl;
            for (uint32_t i = i0; i < i1; i++) {
                const uint8_t *L = tree + (uint64_t)(offprev + 2 * i) * 32;
                const uint8_t *R = (2 * i + 1 < wprev) ? tree + (uint64_t)(offprev + 2 * i + 1) * 32 : L;
                parent(L, R, tree + (uint64_t)(offl + i) * 32);
            }
        }
    }
    return 0;
}

EXPORT("porw_merkle_tree_build_upper")
int porw_merkle_tree_build_upper(uint8_t *tree, uint32_t n, uint32_t from_level) {
    if (n == 0) return 1;
    uint32_t w = level_width(n, from_level), off = level_offset(n, from_level);
    while (w > 1) {
        uint32_t nw = (w + 1) / 2, noff = off + w;
        for (uint32_t i = 0; i < nw; i++) {
            const uint8_t *L = tree + (uint64_t)(off + 2 * i) * 32;
            const uint8_t *R = (2 * i + 1 < w) ? tree + (uint64_t)(off + 2 * i + 1) * 32 : L;
            parent(L, R, tree + (uint64_t)(noff + i) * 32);
        }
        off = noff; w = nw;
    }
    return 0;
}
