"""Public PoRW v2 API.

Verification results are ephemeral diagnostics returned by a local
``verify_tile_fraud`` call. They are never caller-supplied credentials or
cryptographic attestations and must not cross process, storage, or network
boundaries.
"""

from .commitments import (
    CommittedOpening,
    InteriorNonInclusionWitness,
    NeighborWitness,
    partials_leaf,
    verify_committed_opening,
    verify_interior_non_inclusion,
    weights_leaf,
)
from .merkle import merkle_parent, verify_counted_merkle
from .scheme import (
    FMIX_M1,
    FMIX_M2,
    GOLDEN32,
    M32,
    SCHEME_ID,
    TILE_BYTES,
    TILE_WORDS,
    WORD_BYTES,
    fmix32,
    sketch_tiles,
    tile_coeffs,
)
from .verification import (
    FraudOutcome,
    PorwContext,
    PorwVerificationResult,
    TileFraudProof,
    verify_tile_fraud,
)

__all__ = [
    "FMIX_M1",
    "FMIX_M2",
    "GOLDEN32",
    "M32",
    "SCHEME_ID",
    "TILE_BYTES",
    "TILE_WORDS",
    "WORD_BYTES",
    "CommittedOpening",
    "FraudOutcome",
    "InteriorNonInclusionWitness",
    "NeighborWitness",
    "PorwContext",
    "PorwVerificationResult",
    "TileFraudProof",
    "fmix32",
    "merkle_parent",
    "partials_leaf",
    "sketch_tiles",
    "tile_coeffs",
    "verify_committed_opening",
    "verify_counted_merkle",
    "verify_interior_non_inclusion",
    "verify_tile_fraud",
    "weights_leaf",
]
