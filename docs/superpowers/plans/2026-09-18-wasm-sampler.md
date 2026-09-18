# WASM Sampler Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the bounded C sampler and delta application tasks. Root integrates node loading and reviews the complete change.

**Goal:** Execute deterministic delta sampling and application in WASM without resident full-payload JS copies.

**Architecture:** C exact sampler and record kernels; JS metadata orchestration and pointer handles; PorwNode adopts resident output. Existing JS/Python remain reference oracles.

**Tech Stack:** C11 wasm32, JavaScript modules, Node tests, Python reference.

## 1. Exact sampler
- [x] Add failing test_sample_wasm.mjs assertions for missing exports and exact JS/Python CDF/hash matches.
- [x] Implement sample_wasm.c and header with fixed-width multiword integer operations and exact rounding.
- [x] Export porw_nb_table(c,R,MR,kmax,outPtr,capacity) returning length or negative error; hash test export; porw_sample_records(recordsPtr,n,seedLo,seedHi,MR,rowsPtr,nRows,outCountsPtr) using packed 10-byte records and u32 pair rows.
- [x] Include source in build.sh, build both kernels, prove tests pass including extremes and count-group workspace reuse.

## 2. Resident delta application
- [x] Add failing test_delta_wasm.mjs comparing all versions with JS bytes and malformed ancestor handling.
- [x] Implement delta_wasm.js and delta_wasm.c: resident base handles, pointer genotypes, v3 crossover and mutation, sorted record/explicit-op merge and final payload written into WASM.
- [x] Bound and reclaim temporary memory. Never retain a view across allocation. Validate base identity/shape/order and ancestor hashes.
- [x] Cover v1 strict delete, v2/v3 lenient delete, threshold/signs, all inheritance granularities and grandchild resolution.

## 3. Node integration and validation
- [x] Refactor node.js to adopt resident payloads; route loadDelta through WASM, preserving metadata and opts.
- [x] Verify model_id/synapseRoot/mep_id/execution against direct payload loading, repeated base reuse, memory growth, scratch cleanup and shared kernel.
- [x] Add benchmark and document ownership/lifetime/memory accounting. Run full npm tests and bounded benchmark.
- [x] Independent code review, fixes, final clean commit and report measurements. No deployment or merge required by this request.
