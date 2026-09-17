#!/usr/bin/env bash
# Build the PoRW WASM kernel (SIMD128 + scalar fallback in one module).
# Requires clang with the wasm32 target and wasm-ld (LLVM >= 15).
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
"$CC" --target=wasm32 -O3 -msimd128 -mbulk-memory -nostdlib -std=c11 -Wall -Wextra \
  -Wl,--no-entry -Wl,--export=__heap_base \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=4294967296 \
  -o sketch.wasm sketch_wasm.c commit_wasm.c spmv_wasm.c
ls -l sketch.wasm
