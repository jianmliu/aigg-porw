#include "sample_wasm.h"
#include <stdint.h>
#define EXPORT(n) __attribute__((export_name(n)))
static uint32_t rd32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}
static int32_t weight(const uint8_t *p) {
  return (int16_t)((uint32_t)p[8] | ((uint32_t)p[9] << 8));
}
static int cmp(const uint8_t *a, const uint8_t *b) {
  uint32_t ap = rd32(a + 4), bp = rd32(b + 4);
  if (ap != bp)
    return ap < bp ? -1 : 1;
  ap = rd32(a);
  bp = rd32(b);
  return ap == bp ? 0 : ap < bp ? -1 : 1;
}
EXPORT("porw_delta_validate")
int32_t porw_delta_validate(const uint8_t *r, uint32_t n, uint32_t neurons) {
  for (uint32_t i = 0; i < n; i++) {
    if (rd32(r + 10 * i) >= neurons || rd32(r + 10 * i + 4) >= neurons)
      return -2;
    if (i && cmp(r + 10 * (i - 1), r + 10 * i) >= 0)
      return -1;
  }
  return 0;
}
EXPORT("porw_delta_merge")
int32_t porw_delta_merge(const uint8_t *r, uint32_t n, const uint32_t *counts,
                         uint32_t min, const uint8_t *ops, uint32_t m,
                         uint32_t strict, uint8_t *out) {
  uint32_t i = 0, j = 0, total = 0;
  while (i < n || j < m) {
    const uint8_t *a = r + 10 * i, *b = ops + 10 * j;
    int c = i == n ? 1 : j == m ? -1 : cmp(a, b);
    const uint8_t *src;
    int32_t w;
    if (c < 0) {
      src = a;
      w = weight(a);
      if (counts) {
        uint32_t v = counts[i];
        i++;
        if (v < min)
          continue;
        w = w < 0 ? -(int32_t)v : (int32_t)v;
      } else
        i++;
    } else {
      if (c > 0 && strict && weight(b) == 0)
        return -1;
      src = b;
      w = weight(b);
      j++;
      if (c == 0)
        i++;
      if (!w)
        continue;
    }
    if (out) {
      for (uint32_t x = 0; x < 8; x++)
        out[10 * total + x] = src[x];
      out[10 * total + 8] = (uint8_t)w;
      out[10 * total + 9] = (uint8_t)((uint32_t)w >> 8);
    }
    total++;
  }
  return (int32_t)total;
}
EXPORT("porw_delta_cross")
void porw_delta_cross(const uint8_t *r, uint32_t n, const uint32_t *a,
                      const uint32_t *b, const uint32_t *draw, uint32_t lo,
                      uint32_t hi, uint32_t gran, uint32_t mut, uint32_t *out) {
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t *rec = r + 10 * i;
    uint32_t pre = rd32(rec), post = rd32(rec + 4);
    int32_t w = weight(rec);
    uint32_t base = w < 0 ? (uint32_t)-w : (uint32_t)w;
    uint32_t pick = (uint32_t)(porw_hash64(lo ^ 0x5049434bu, hi ^ 0x5049434bu,
                                           gran == 2 ? 0xffffffffu : pre,
                                           gran == 1 ? 0xffffffffu : post) >>
                               32);
    uint32_t v = pick >> 31 ? (b ? b[i] : base) : (a ? a[i] : base);
    if ((uint32_t)(porw_hash64(lo ^ 0x4d555421u, hi ^ 0x4d555421u, pre, post) >>
                   32) < mut)
      v = draw[i];
    out[i] = v;
  }
}
