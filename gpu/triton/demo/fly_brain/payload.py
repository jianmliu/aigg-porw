"""Content-addressable fruit-fly-brain weight payload for the PoRW demo.

PoRW proves *residency of specific weight bytes*, so the demo needs a real,
content-addressable set of weight bytes to put resident on the GPU. The
fruit-fly connectome is a good target: it is open, small enough to reside
comfortably in one A100's HBM, and its natural parameters (a sparse synaptic
weight matrix plus per-neuron parameters) are exactly a byte buffer.

Two sources, identical downstream PoRW behavior:

- ``from_checkpoint(path)`` — use the exact bytes of a real open checkpoint
  (``.safetensors``, ``.npy``/``.npz``, or a raw weight blob). The model id is
  the weights Merkle root of those bytes; drop in the published FlyWire /
  connectome-constrained model export and the demo proves residency of the
  real model.
- ``synthesize(...)`` — a deterministic connectome-scaled payload built from a
  fixed PRNG seeded by the model name, sized to a published *Drosophila*
  connectome (default: the FlyWire adult-brain scale, ~139k neurons). This is
  a reproducible **stand-in**, clearly labeled as synthetic in the report; it
  is a connectome-shaped byte buffer, not a trained behavioral model.

The buffer is a fixed binary layout, right-padded with zero tiles to a whole
number of 4 KiB tiles so it slots directly into the sketch/commitment path.

Honesty: the sketch and this payload prove byte residency, not that the brain
computes anything. Inference execution is explicitly out of PoRW scope.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TILE_BYTES = 4096

# Published adult-brain connectome scale (FlyWire consortium, 2023-2024):
# ~139,255 proofread neurons and ~54.5M synaptic connections. The neuron count
# is the widely cited figure; the tweet that motivated this demo rounds it to
# "16.67万". We use the published neuron count and cite it, and expose both as
# parameters so the payload can be scaled down for a CPU interpreter smoke run.
FLYWIRE_NEURONS = 139_255
FLYWIRE_SYNAPSES = 54_500_000

# Per-neuron parameter record: type tag (u16) + bias (fp16) + resting/threshold
# pair (fp16 x2) = 8 bytes. Per-synapse record: pre id (u32) + post id (u32) +
# weight (fp16) = 10 bytes. These layouts are the demo's model format; they are
# not a normative model spec.
NEURON_RECORD = 8
SYNAPSE_RECORD = 10
MAGIC = b"FLYBRAINv1\x00\x00"  # 12 bytes


@dataclass(frozen=True)
class Payload:
    """A tiled weight payload ready for the PoRW loop."""

    name: str
    neurons: int
    synapses: int
    source: str  # "synthetic" or "checkpoint:<path>"
    buf: np.ndarray  # uint8, length a multiple of TILE_BYTES

    @property
    def n_tiles(self) -> int:
        return self.buf.size // TILE_BYTES

    @property
    def bytes_total(self) -> int:
        return int(self.buf.size)

    def summary(self) -> dict:
        return {
            "name": self.name,
            "source": self.source,
            "neurons": self.neurons,
            "synapses": self.synapses,
            "n_tiles": self.n_tiles,
            "bytes_total": self.bytes_total,
            "mib_total": round(self.bytes_total / (1 << 20), 3),
        }


def _pad_to_tiles(raw: bytes) -> np.ndarray:
    pad = (-len(raw)) % TILE_BYTES
    buf = raw + b"\x00" * pad
    return np.frombuffer(buf, dtype=np.uint8).copy()


def _header(name: str, neurons: int, synapses: int) -> bytes:
    # MAGIC(12) + neurons(u64) + synapses(u64) + name_len(u16) + name.
    name_b = name.encode("utf-8")
    if len(name_b) > 0xFFFF:
        raise ValueError("model name too long")
    return (
        MAGIC
        + struct.pack("<QQH", neurons, synapses, len(name_b))
        + name_b
    )


def synthesize(
    name: str = "flywire-adult-brain",
    neurons: int = FLYWIRE_NEURONS,
    synapses: int = FLYWIRE_SYNAPSES,
) -> Payload:
    """Deterministic connectome-scaled payload seeded by ``name``.

    Reproducible: the same (name, neurons, synapses) always yields the same
    bytes, hence the same weights Merkle root / model id. This is a synthetic
    stand-in at real connectome scale, not the real FlyWire export.
    """
    if neurons <= 0 or synapses <= 0:
        raise ValueError("neurons and synapses must be positive")
    seed = int.from_bytes(hashlib.blake2b(name.encode(), digest_size=8).digest(), "little")
    rng = np.random.default_rng(seed)

    header = _header(name, neurons, synapses)

    # Per-neuron records: type tag in [0, 128), three fp16-pattern u16 fields.
    neuron_block = np.empty(neurons * (NEURON_RECORD // 2), dtype=np.uint16)
    neuron_block[0::4] = rng.integers(0, 128, size=neurons, dtype=np.uint16)
    neuron_block[1::4] = rng.integers(0, 1 << 16, size=neurons, dtype=np.uint16)
    neuron_block[2::4] = rng.integers(0, 1 << 16, size=neurons, dtype=np.uint16)
    neuron_block[3::4] = rng.integers(0, 1 << 16, size=neurons, dtype=np.uint16)

    # Per-synapse records: pre/post neuron ids and an fp16-pattern weight.
    pre = rng.integers(0, neurons, size=synapses, dtype=np.uint32)
    post = rng.integers(0, neurons, size=synapses, dtype=np.uint32)
    wpat = rng.integers(0, 1 << 16, size=synapses, dtype=np.uint16)
    syn = np.empty(synapses * SYNAPSE_RECORD, dtype=np.uint8)
    syn_pre = syn[0:].reshape(-1, SYNAPSE_RECORD)
    syn_pre[:, 0:4] = pre.view(np.uint8).reshape(-1, 4)
    syn_pre[:, 4:8] = post.view(np.uint8).reshape(-1, 4)
    syn_pre[:, 8:10] = wpat.view(np.uint8).reshape(-1, 2)

    raw = header + neuron_block.tobytes() + syn.tobytes()
    return Payload(name, neurons, synapses, "synthetic", _pad_to_tiles(raw))


@dataclass(frozen=True)
class Connectome:
    """The synapse/neuron arrays decoded back from a synthetic payload."""

    neurons: int
    synapses: int
    pre: np.ndarray  # uint32 [synapses]
    post: np.ndarray  # uint32 [synapses]
    weight: np.ndarray  # float64 [synapses] in [0, 1)


def decode_synapses(payload: Payload) -> Connectome:
    """Re-parse a synthetic payload's header + synapse block from its bytes.

    Reads the resident bytes back into (pre, post, weight) arrays so a CPU
    "inference" over the connectome genuinely touches the resident weights.
    Only valid for ``synthesize``-produced payloads (checkpoints have no known
    layout).
    """
    if payload.source != "synthetic":
        raise ValueError("decode_synapses only supports synthetic payloads")
    raw = payload.buf.tobytes()
    if raw[: len(MAGIC)] != MAGIC:
        raise ValueError("bad payload magic")
    neurons, synapses, name_len = struct.unpack_from("<QQH", raw, len(MAGIC))
    off = len(MAGIC) + struct.calcsize("<QQH") + name_len
    off += neurons * NEURON_RECORD
    syn = np.frombuffer(raw, dtype=np.uint8, count=synapses * SYNAPSE_RECORD, offset=off)
    syn = syn.reshape(synapses, SYNAPSE_RECORD)
    pre = syn[:, 0:4].copy().view(np.uint32).reshape(-1)
    post = syn[:, 4:8].copy().view(np.uint32).reshape(-1)
    wpat = syn[:, 8:10].copy().view(np.uint16).reshape(-1)
    weight = wpat.astype(np.float64) / 65535.0
    return Connectome(neurons, synapses, pre, post, weight)


def from_checkpoint(path: str | Path, name: str | None = None) -> Payload:
    """Use the exact bytes of a real checkpoint as the resident weights.

    The whole file is treated as the weight blob (its own internal format is
    irrelevant to residency). ``.npz`` is concatenated in sorted key order so
    the model id is stable. neurons/synapses are recorded as 0 (unknown) unless
    the caller knows them; they are cosmetic in the report only.
    """
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(p)
    if p.suffix == ".npz":
        with np.load(p) as z:
            raw = b"".join(np.ascontiguousarray(z[k]).tobytes() for k in sorted(z.files))
    elif p.suffix == ".npy":
        raw = np.ascontiguousarray(np.load(p)).tobytes()
    else:
        raw = p.read_bytes()
    return Payload(name or p.name, 0, 0, f"checkpoint:{p.name}", _pad_to_tiles(raw))
