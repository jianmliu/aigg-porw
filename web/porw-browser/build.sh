#!/usr/bin/env bash
# Build the PoRW WASM kernels. Two modules from the same sources:
#   sketch.wasm        — own memory (Node tests, single-thread pages)
#   porw-shared.wasm   — imported SHARED memory (Web Workers over one resident copy;
#                        each worker instance sets its own __stack_pointer)
# Requires clang with the wasm32 target and wasm-ld (LLVM >= 15).
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
SRC="sketch_wasm.c commit_wasm.c spmv_wasm.c dispute_wasm.c"
COMMON="--target=wasm32 -O3 -msimd128 -mbulk-memory -nostdlib -std=c11 -Wall -Wextra -Wl,--no-entry -Wl,--export=__heap_base -Wl,--max-memory=4294967296"
"$CC" $COMMON -Wl,--initial-memory=1048576 -o sketch.wasm $SRC
"$CC" $COMMON -matomics -Wl,--import-memory -Wl,--shared-memory -Wl,--export=__stack_pointer \
  -Wl,--initial-memory=16777216 -Wl,-z,stack-size=262144 -o porw-shared.wasm $SRC
ls -l sketch.wasm porw-shared.wasm
