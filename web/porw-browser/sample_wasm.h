#ifndef PORW_SAMPLE_WASM_H
#define PORW_SAMPLE_WASM_H
#include <stdint.h>
/* Uniform words packed as (high << 32) | low. */
uint64_t porw_hash64(uint32_t seedLo, uint32_t seedHi, uint32_t pre, uint32_t post);
/* Exact JS Q64 CDF, including forced final tail. Returns table length, or -1
 * for invalid parameters/capacity. c <= 32768, 1 <= R <= 65535, kmax <= 32767.
 * Caller supplies capacity >= kmax + 1; all pointers are caller-owned. */
int porw_nb_table(uint32_t c, uint32_t R, uint32_t MR, uint32_t kmax, uint64_t *out,
                  uint32_t capacity);
/* Strict CDF > uniform inverse, or final index. Requires nonempty table. */
uint32_t porw_sample_from_table(const uint64_t *table, uint32_t length, uint64_t uniform);
/* Packed 10-byte signed records and ascending u32 (c_from, R) pairs.
 * Writes one unsigned count per record. Returns 0, -1 invalid parameters,
 * or -2 allocation failure. Scratch is reclaimed on every return; retained
 * one reusable table and count chains use at most 385 KiB scratch.
 * Inputs/outputs must be allocated before call and must not overlap. */
int porw_sample_records(const uint8_t *records, uint32_t n, uint32_t seedLo, uint32_t seedHi,
                        uint32_t MR, const uint32_t *rows, uint32_t nRows, uint32_t *outCounts);
#endif
