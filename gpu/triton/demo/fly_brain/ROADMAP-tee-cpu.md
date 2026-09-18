# Roadmap: TEE-CPU execution-proof adapter for the PoRW demo

> **Status (browser route):** this TEE roadmap is **paused** while the
> zero-install browser route is explored (`web/porw-browser/`). Browsers expose
> no hardware attestation, so the browser node's execution proof comes from
> determinism + redundancy + cross-audit + fraud proofs instead. The seam and
> stages below remain the plan for a native (installed) client.

PoRW proves **residency** — the exact model weight bytes were on the device and
answered byte-level audits under a fresh challenge. It deliberately does not
prove **execution** — that a user request was actually run against those
weights. This roadmap adds an optional CPU-TEE execution-proof adapter that
supplies the execution half and binds it to the same residency proof.

This is a **demo-scope** roadmap: it lives beside the fly-brain demo and covers
the adapter seam and its staged hardening. It does not add custody, staking,
rewards, or consensus (out of this repository's scope), and it does not change
any PoRW scheme id.

## What each layer proves

| Layer | Question answered | Trust root |
|---|---|---|
| PoRW residency | *Are these exact model bytes resident and audit-answerable now?* | cryptographic (sampled-byte openings + fraud proof + fresh challenge) — **no TEE** |
| TEE-CPU execution | *Did this measured image execute this request/response?* | hardware (Intel TDX / AMD SEV-SNP quote) |

They compose through one shared value: the execution transcript digest binds
the **PoRW residency root** (`model_id` = weights Merkle root) together with the
request and response, and that digest is placed in the TEE quote's
`report_data`. One verified quote then certifies *this measured image executed
this request and response over this content-addressed model.* Because both
proofs carry the same `model_id`, they cannot be about different models.

## Trust boundary (the honest limit)

A CPU TEE seals CPU memory and execution. It covers:

- CPU-side inference (small / quantized / CPU-only models), and
- orchestration: request handling, the PoRW prover loop, response assembly.

It does **not** cover GPU kernels. For GPU inference, a CPU-only quote attests
the driver and orchestration, not the matmuls — those need GPU confidential
computing (H100 CC), a separate adapter with its own quote. The report always
labels which surface was attested (`is_hardware`, `image_measurement`), so a
CPU quote is never mistaken for a GPU-execution proof.

## Alignment with the ecosystem

- **aigg-spec** already reserves this seam: proposal §8.4 lists "alternative ZK,
  TEE-vendor, or approved attestation adapters" behind `IPoRWVerifier`. The
  execution adapter sits alongside PoRW, not inside a scheme id (the signature/
  attestation suite is a deployment choice outside the scheme id, per the scheme
  registry).
- **ai3-inference `packages/verify`** already implements the production TDX
  path this adapter targets: real Intel TDX v4 quotes with `report_data` at
  offset 568 and the RTMR3 image measurement at offset 520, `attestationRef =
  keccak256(quote)`, verified by the dcap-qvl DCAP adapter (isomorphic wasm) or
  an `httpQuoteVerifier` fallback, with an image→tier allowlist. The demo's
  `attest.py` mirrors those exact offsets so the production adapter is a drop-in
  at the same seam.

## Stages

**S0 — seam + mock (done, in `attest.py`).** `AttestationAdapter` protocol
(`attest` / `verify`), an `ExecutionTranscript` that binds `model_id ‖ challenge
‖ request ‖ response`, and `MockCpuTeeAdapter`: a byte-layout-faithful stand-in
with an accept-any verifier. The demo's `--attest mock` runs residency +
execution end to end and asserts the binding (a proof cannot be rebound to
another model). Labeled `verified_by: mock`, `is_hardware: false`.

**S1 — real TDX quote generation.** Replace the mock quote with a real dstack /
TDX-guest quote whose `report_data` carries the transcript digest. Run the
prover + a small CPU inference of the fly-brain model inside a TDX guest;
produce the quote at request time.

**S2 — real DCAP verification.** Replace the accept-any verifier with a real
`QuoteVerifier`: reuse ai3-inference's `dcapQvlQuoteVerifier` (Intel cert chain
+ collateral) rather than reimplementing DCAP. Enforce the image measurement
(RTMR3) against an allowlist of approved fly-brain inference images, reusing the
image→tier allowlist pattern.

**S3 — SEV-SNP adapter.** Add an AMD SEV-SNP adapter behind the same protocol
(attestation report instead of a TDX quote; `report_data` binding identical), so
the demo is vendor-plural.

**S4 — anchor.** Optionally publish `keccak256(quote)` (the `attestationRef`) and
the transcript digest alongside the PoRW claim, so a verifier can later fetch
and re-verify the quote. This is where the demo meets the on-chain path; it
reuses the receipt/attestation references ai3-inference already defines.

## Non-goals

- Not a replacement for PoRW residency (that needs no TEE and stays the default).
- Not GPU-kernel attestation (that is the separate H100-CC adapter).
- Not a claim that a mock proof means anything about real hardware — S0 is a
  seam exercise only.
