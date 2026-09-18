# Fruit-fly-brain PoRW end-to-end demo

A demonstration that runs the full Proof of Resident Weights scheme-v2 loop
against a real, content-addressable model payload held resident on the GPU.

It is a **demo target**, not a production service: it exercises the residency
proof math end to end on a recognizable open model. It does not add custody,
staking, rewards, or consensus (those are out of this repository's scope).

## What it does

1. **Payload** ([`payload.py`](payload.py)) — the fruit-fly connectome as a
   content-addressable weight buffer. Either a real checkpoint's exact bytes
   (`--checkpoint`), or a deterministic connectome-scaled stand-in seeded by
   the model name (default: FlyWire adult-brain scale, ~139,255 neurons /
   ~54.5M synapses). The buffer is padded to whole 4 KiB tiles; the weights
   Merkle root is the model id.
2. **Residency + sweep** — the bytes are placed resident on the device and the
   covered tiles are sketched by the GPU sweep kernel, cross-checked
   bit-for-bit against the NumPy reference.
3. **Commit** — weights Merkle root (model id) and coverage-ordered partials
   root.
4. **Audit** — a committed opening (the audited tile is really committed), a
   tile fraud proof (honest commitment → NoFraud, lying commitment over the
   same honest weights → Fraud), and a non-inclusion proof for an uncovered
   tile (sparse / MoE-style coverage).

## What it proves — and what it does not

- **Proves:** the exact model weight bytes were resident on the device and the
  device answered byte-level audits over them under a fresh public challenge.
- **Does not prove:** that the brain computes anything, or that a user
  inference request was executed. Inference execution is out of PoRW scope; the
  sketch is an algebraic consistency check, not a collision-resistant or
  execution proof. See the repository research-limitations notes.

The synthetic payload is a connectome-**scaled** byte buffer, clearly labeled
`source: synthetic` in the report — drop in the published FlyWire export with
`--checkpoint` to prove residency of the real model.

## Pure-CPU end-to-end stack (residency + execution, no GPU)

`pure_cpu_e2e.py` composes both halves of a verifiable-compute claim over the
same content-addressed model, with no GPU in the loop:

- **A. residency** (cryptographic, no TEE): the model bytes mlocked resident in
  DRAM, stream-audited at the measured DRAM bandwidth under a fresh challenge,
  full PoRW proof loop; and
- **B. execution** (CPU TEE): a deterministic connectome propagation run over
  the resident synapse bytes, its transcript bound to the same `model_id` and
  attested by the CPU-TEE adapter (mock stage).

Both halves carry the same `model_id`, so the attestation cannot be about a
different model than the one proven resident.

The point of the CPU track is to lower the hardware bar so an **ordinary,
GPU-less computer** can host, prove, and run the model. The fly brain qualifies
for a structural reason: its propagation is a sparse mat-vec (SpMV) with ~0.06
flop/byte — memory-bound, not GPU-style dense GEMM — and the ~521 MiB model is
~13% of an 8 GiB PC's model budget. The report includes a commodity-PC
feasibility section and the measured SpMV intensity; see
[`WHY-CPU.md`](WHY-CPU.md). Residency never depends on `mlock` (ordinary users
usually cannot mlock a 500 MiB buffer); it is proven by the bandwidth envelope
plus sampled-byte audits.

```sh
cd gpu/triton
# full FlyWire scale
.venv/bin/python -m demo.fly_brain.pure_cpu_e2e --slot-ms 100 --repeats 5
# small run
.venv/bin/python -m demo.fly_brain.pure_cpu_e2e --name smoke --neurons 5000 --synapses 50000
```

## Browser route (zero-install)

The same audit kernel compiled to WebAssembly SIMD128 runs in a browser tab:
a full bit-exact audit of the 521 MiB fly brain takes ~44 ms with 4 Web
Workers in headless Chromium on a 4-core machine — see
[`web/porw-browser/`](../../../../web/porw-browser/README.md) for the PoC,
measurements, and the honest limits of using browser residency for rewards.

## The real brain: FlyWire v783 export + deterministic integer LIF

`flywire_export.py` turns the public FlyWire FAFB v783 release into a PoRW payload
(`FLYBRAINv2`): 139,255 proofread neurons (record = FlyWire root id), 2,700,513
synapse records with ≥ 5 synapses aggregated over neuropils, weight = signed synapse
count (sign from the presynaptic neuron's `top_nt`: GABA/glutamate −, others +; Dale's
law), records sorted by post neuron. 28 MB, deterministic (sha256 and `model_id` in
`spec-cache/conformance/exec/int-lif-v1/`).

```sh
# sources: Zenodo 10676866 (CC-BY-4.0) + flyconnectome/flywire_annotations
curl -L -o proofread_connections_783.feather "https://zenodo.org/api/records/10676866/files/proofread_connections_783.feather/content"
curl -L -o proofread_root_ids_783.npy       "https://zenodo.org/api/records/10676866/files/proofread_root_ids_783.npy/content"
curl -L -o annotations.tsv "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv"
pip install pyarrow
python demo/fly_brain/flywire_export.py --connections proofread_connections_783.feather --root-ids proofread_root_ids_783.npy \
       --annotations annotations.tsv --out flywire-783-min5.bin --name flywire-fafb-v783-min5      # ~16 s
```

The execution kind `aigg:exec:int-lif:v1` (`web/porw-browser/lif_wasm.c`, `lif.js`,
`int_lif.py`, `contracts/evm/src/mesh/LifRowCheck.sol`) is a fixed-point port of the
whole-brain leaky integrate-and-fire model of Shiu et al. 2024 (dt 0.1 ms, τ_m 20 ms,
τ_syn 5 ms, 7 mV threshold, 2.2 ms refractory, 0.275 mV per synapse, 150 Hz drive of a
stimulus set). All integer, so wasm, numpy, JS and Solidity agree bit for bit — checked
for 500 steps on the real export — and a wrong result can be narrowed to one synapse
term on-chain. See `web/porw-browser/README.md` and `contracts/evm/DESIGN-cross-audit.md`
§5c for the commitments, measurements and honest limits.

## Optional: TEE-CPU execution proof

PoRW proves residency, not that a request was executed. `--attest mock` adds a
CPU-TEE (Intel TDX / AMD SEV-SNP) execution-proof layer that binds an execution
transcript over the **same** `model_id` into an attestation `report_data`, so
one proof ties execution to the exact resident model. The mock stage exercises
the seam only (`is_hardware: false`); the staged path to real TDX quotes and
DCAP verification — reusing ai3-inference `packages/verify` — is in
[`ROADMAP-tee-cpu.md`](ROADMAP-tee-cpu.md). A CPU TEE attests CPU inference and
orchestration, not GPU kernels; that boundary is stated in the roadmap.

## Run

```sh
# Native GPU (A100): full FlyWire-scale payload, dense coverage.
gpu/triton/.venv/bin/python -m demo.fly_brain.run_demo --json

# CPU correctness run (no GPU): small payload, interpreter mode, coverage gap
# so the non-inclusion path is exercised.
cd gpu/triton
TRITON_INTERPRET=1 .venv/bin/python -m demo.fly_brain.run_demo \
  --name smoke --neurons 3000 --synapses 30000 --coverage-fraction 0.6

# add the mock TEE-CPU execution-proof layer
TRITON_INTERPRET=1 .venv/bin/python -m demo.fly_brain.run_demo \
  --name smoke --neurons 3000 --synapses 30000 --coverage-fraction 0.6 --attest mock
```

Run from `gpu/triton/` (so the `demo` and `porw_sketch` packages resolve), or
add that directory to `PYTHONPATH`. Exit code is non-zero if any check fails.

## Delta payloads: `flywire_delta.py`

`FLYDELTAv1` (format in `web/porw-browser/delta.js`): an edit list over a released `FLYBRAINv2` payload, bound to the
base's `model_id`. `diff --base a.bin --target b.bin --out b.delta` builds the delta between two exports, `make --ops
ops.json` builds one from `[[pre, post, w], ...]` (w = 0 deletes), `apply` rebuilds the target payload byte for byte
and writes a manifest with the base and result model ids, `info` decodes a delta. `w != 0` sets a record, `w == 0`
deletes it; neurons are unchanged.
