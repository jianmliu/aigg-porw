"""TEE-CPU execution-proof adapter seam for the PoRW demo (mock stage).

PoRW proves *residency*: the exact model weight bytes were on the device and
answered byte-level audits. It deliberately does not prove that a user request
was *executed*. A CPU TEE (Intel TDX / AMD SEV-SNP) can attest that a measured
image executed a request — the missing execution half — so this adapter binds
the two into one proof.

Composition. The execution transcript digest binds the PoRW residency root
(``model_id`` = weights Merkle root) together with the request and response, and
that digest is what the TEE places in the attestation's ``report_data``. One
verified quote then certifies: *this measured image executed this request and
this response over this content-addressed model.* The residency proof and the
execution proof share the model id, so they cannot be about different models.

Trust boundary. A CPU TEE covers CPU-side inference and orchestration. It does
**not** cover GPU kernels: for GPU inference a CPU-only quote attests the
driver/orchestration, not the matmuls — that needs GPU confidential computing
(H100 CC), a separate adapter. This module is honest about which it is.

Stage. This is the **mock** stage: a byte-layout-faithful stand-in and an
accept-any verifier, so the demo can exercise the seam end to end. It is not a
hardware attestation and is labeled ``verified_by: mock`` in the report.
Production reuses ai3-inference ``packages/verify`` (real Intel TDX v4 quotes:
``report_data`` at offset 568, RTMR3 image measurement at offset 520,
``attestationRef = keccak256(quote)``, verified by the dcap-qvl DCAP adapter).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from blake3 import blake3

# Intel TDX v4 quote layout (mirrors ai3-inference packages/verify): the mock
# quote is padded to a realistic length and carries report_data / RTMR3 at the
# real offsets so a production adapter is a drop-in at the same seam.
TDX_QUOTE_LEN = 1024
TDX_REPORT_DATA_OFFSET = 568  # 64-byte report_data
TDX_RTMR3_OFFSET = 520  # 48-byte image measurement (dstack compose hash)
REPORT_DATA_LEN = 64
RTMR3_LEN = 48


@dataclass(frozen=True)
class ExecutionTranscript:
    """The request/response bound to a specific resident model."""

    model_id: bytes  # PoRW weights Merkle root (content address)
    challenge: bytes  # the same public PoRW challenge (freshness)
    request_digest: bytes  # blake3 of the canonical request
    response_digest: bytes  # blake3 of the canonical response

    def digest(self) -> bytes:
        """32-byte transcript digest; goes into the TEE report_data."""
        h = blake3()
        h.update(b"aigg:porw:exec-transcript:v1")
        for part in (self.model_id, self.challenge, self.request_digest, self.response_digest):
            h.update(len(part).to_bytes(4, "little"))
            h.update(part)
        return h.digest()


@dataclass(frozen=True)
class ExecutionProof:
    verified_by: str  # "mock" now; "tdx-dcap" / "snp" in production
    image_measurement: str  # hex RTMR3 (which image executed)
    report_data: str  # hex, 64 bytes (binds the transcript digest)
    quote_len: int
    verified: bool
    is_hardware: bool = False
    notes: str = ""

    def summary(self) -> dict:
        return {
            "verified_by": self.verified_by,
            "is_hardware": self.is_hardware,
            "image_measurement": self.image_measurement,
            "report_data": self.report_data,
            "quote_len": self.quote_len,
            "verified": self.verified,
            "notes": self.notes,
        }


class AttestationAdapter(Protocol):
    """A TEE execution-proof adapter. Real adapters wrap a hardware quote and a
    cryptographic QuoteVerifier; the mock stands in for the seam."""

    def attest(self, transcript: ExecutionTranscript) -> tuple[ExecutionProof, bytes]:
        """Produce (proof, quote_bytes) for a transcript executed in the TEE."""
        ...

    def verify(self, proof: ExecutionProof, quote: bytes, transcript: ExecutionTranscript) -> bool:
        """Check the quote is valid and its report_data binds this transcript."""
        ...


def _mock_quote(report_data: bytes, rtmr3: bytes) -> bytes:
    if len(report_data) != REPORT_DATA_LEN or len(rtmr3) != RTMR3_LEN:
        raise ValueError("report_data must be 64 bytes and rtmr3 48 bytes")
    quote = bytearray(TDX_QUOTE_LEN)
    quote[TDX_RTMR3_OFFSET : TDX_RTMR3_OFFSET + RTMR3_LEN] = rtmr3
    quote[TDX_REPORT_DATA_OFFSET : TDX_REPORT_DATA_OFFSET + REPORT_DATA_LEN] = report_data
    return bytes(quote)


def _report_data_from_transcript(transcript: ExecutionTranscript) -> bytes:
    # report_data is 64 bytes; the 32-byte transcript digest is left-aligned and
    # zero-padded, matching how dstack binds a 32-byte value into report_data.
    return transcript.digest() + b"\x00" * (REPORT_DATA_LEN - 32)


class MockCpuTeeAdapter:
    """A byte-layout-faithful CPU-TEE stand-in with an accept-any verifier.

    NOT a hardware attestation: it proves nothing about a real TEE. It exists so
    the demo can exercise the residency + execution composition at the exact
    seam a production TDX/SNP adapter will occupy.
    """

    verified_by = "mock"

    def __init__(self, image_measurement: bytes | None = None):
        self._rtmr3 = image_measurement or blake3(b"mock-fly-brain-inference-image").digest(length=RTMR3_LEN)

    def attest(self, transcript: ExecutionTranscript) -> tuple[ExecutionProof, bytes]:
        report_data = _report_data_from_transcript(transcript)
        quote = _mock_quote(report_data, self._rtmr3)
        proof = ExecutionProof(
            verified_by=self.verified_by,
            image_measurement="0x" + self._rtmr3.hex(),
            report_data="0x" + report_data.hex(),
            quote_len=len(quote),
            verified=True,
            is_hardware=False,
            notes="mock CPU-TEE stand-in; not a hardware attestation",
        )
        return proof, quote

    def verify(self, proof: ExecutionProof, quote: bytes, transcript: ExecutionTranscript) -> bool:
        # Mock QuoteVerifier: accept any well-formed quote (production replaces
        # this with a real DCAP verification). Still enforce the binding: the
        # quote's report_data must equal this transcript's expected value.
        if len(quote) != TDX_QUOTE_LEN:
            return False
        expected = _report_data_from_transcript(transcript)
        actual = quote[TDX_REPORT_DATA_OFFSET : TDX_REPORT_DATA_OFFSET + REPORT_DATA_LEN]
        rtmr3 = quote[TDX_RTMR3_OFFSET : TDX_RTMR3_OFFSET + RTMR3_LEN]
        return actual == expected and ("0x" + rtmr3.hex()) == proof.image_measurement
