# PoRW in the browser — zero-install fly-brain residency audit (PoC)

The scheme-v2 tile sketch compiled to **WebAssembly SIMD128**, run in a web
page with Web Workers, so an ordinary computer can hold the fruit-fly-brain
model resident and answer a full PoRW audit **without installing anything**.
This is the audit half of a browser-based node; it is a proof of concept for
the "ordinary computer" goal, measured in headless Chromium.

## Files

- `sketch_wasm.c` — the kernel: SIMD128 (4 × u32 lanes) with a scalar fallback
  in one module; freestanding, bump allocator over the wasm heap; also a
  deterministic payload filler so a 500 MiB test buffer needs no download.
  Bit-identical to the NumPy reference and the native C/AVX2 kernel.
- `porw.js` / `worker.js` / `index.html` — glue: each worker owns a contiguous
  slice of the weights and audits it with the right starting tile index, so
  **no SharedArrayBuffer or cross-origin isolation** is required.
- `run_browser.mjs` — Playwright driver: serves the page over local HTTP,
  runs headless Chromium, writes a JSON report.
- `crosscheck.py` — recomputes the same payload with the native kernel and
  compares every sketch value (hard failure on any mismatch).
- `build.sh` — `clang --target=wasm32 -O3 -msimd128 …` (LLVM ≥ 15 with wasm-ld).

## Build and run

```sh
cd web/porw-browser
./build.sh                                  # -> sketch.wasm
npm install                                 # playwright (browsers: see below)
PW_CHROMIUM=/path/to/chrome node run_browser.mjs --mib 521 --workers 4 --repeats 3
../../gpu/triton/.venv/bin/python crosscheck.py result.json
```

`PW_CHROMIUM` points Playwright at an existing Chromium binary (e.g. a
pre-installed `/opt/pw-browsers/chromium-*/chrome-linux/chrome`); omit it to use
Playwright's own download. URL parameters: `mib`, `workers`, `repeats`, `seed`,
`slot`, `single=0` to skip the main-thread run.

## Measured (4-core Xeon, no GPU, Chromium 141) — see `benchmarks/browser/`

| configuration | full audit of 521 MiB (133,376 tiles) | rate |
|---|---|---|
| main thread, 1 kernel | 127.6 ms | 3.99 GiB/s |
| 2 Web Workers | 75.2 ms | 6.77 GiB/s |
| **4 Web Workers** | **43.6 ms** | 11.67 GiB/s |

All sketch arrays are bit-identical to the native AVX2 kernel. A full,
verifiable audit of the fly brain fits a 100 ms slot in a browser tab on a
4-core machine with headroom; one thread needs ~130 ms.

## What a browser node can and cannot do

Can (all measured or straightforward):

- **residency** — 521 MiB in wasm memory, fetched by content address
  (`model_id` = weights Merkle root) from DSN/IPFS/Greenfield and verified;
- **audit** — this kernel; BLAKE3/keccak commitments via wasm;
- **inference** — the connectome propagation is a memory-bound SpMV, fine in
  wasm/WebGPU; it must be **integer/fixed-point** so every browser engine
  produces bit-identical results that other nodes can re-execute;
- **identity and signing** — the wallet's secp256k1 key signs PoRW solutions,
  which is exactly the EVM `ecrecover` signature suite already adopted; the
  signing key is the reward key.

Cannot:

- **TEE** — browsers expose no hardware attestation. The execution-proof half
  therefore comes from **determinism + redundancy + cross-audit + fraud proofs**
  (the beacon-selected auditor machinery), not from a CPU TEE.

## Honest limits for using this as a *mining* basis

1. **Residency of a 521 MiB model is not scarce** — every laptop has that RAM.
   In-browser PoRW is a sound liveness/eligibility proof (the node really
   holds the model and can answer), not a proof of cost.
2. **The DRAM residency envelope is weak against SSDs.** GPU PoRW is strong
   because HBM (~2 TB/s) vs SSD (~5 GB/s) is a ~400× gap; DRAM (~10–40 GB/s)
   vs NVMe is only ~5×, and browser challenges cross a network whose jitter
   forces slots of hundreds of ms — long enough for an NVMe to stream 521 MiB.
   Do not reward browser residency by itself.
3. Therefore the rewardable resource should be **verified useful compute**:
   deterministic inference units, executed redundantly by beacon-selected
   nodes, cross-verified, with re-execution fraud proofs; residency gates
   eligibility; participation is **stake-gated** (opening a thousand tabs is
   free, so Sybil resistance must come from a bond).

## Status

PoC: audit kernel + measurement + bit-exact cross-check. Not yet: wasm
commitments/openings in the page, integer SpMV inference, wallet signing,
challenge transport, contract wiring. The TEE-CPU roadmap (`demo/fly_brain/
ROADMAP-tee-cpu.md`) is paused for this route and kept for a native client.
