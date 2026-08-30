"""Compatibility namespace for the packaged PoRW v2 reference scheme.

The canonical Python implementation lives in :mod:`aigg_porw.scheme`. Keep
this module only so existing Triton callers can migrate without changing the
scheme arithmetic or maintaining a second implementation.
"""

from aigg_porw.scheme import (
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

__all__ = [
    "FMIX_M1",
    "FMIX_M2",
    "GOLDEN32",
    "M32",
    "SCHEME_ID",
    "TILE_BYTES",
    "TILE_WORDS",
    "WORD_BYTES",
    "fmix32",
    "sketch_tiles",
    "tile_coeffs",
]
