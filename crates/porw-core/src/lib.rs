//! Chain-neutral reference primitives for the research-only
//! `aigg:porw:sketch-tile:v2` scheme.
//!
//! The per-tile `u32` sketch is a linear algebraic consistency check. It is
//! not collision resistant and does not by itself prove byte equality,
//! residency, or inference execution. In particular, odd coefficients do not
//! prevent deterministic two-word MSB cancellation: for odd coefficients
//! `c_p` and `c_q`, `2^31 * (c_p + c_q) = 0 mod 2^32`.
//!
//! BLAKE3 Merkle openings separately authenticate sampled tile bytes against
//! a commitment. What those openings establish depends on deployment-level
//! admission and challenge assumptions. Signature suites, device identity,
//! response deadlines, consensus integration, and all economic consequences
//! are adapters outside this proof-math crate.
//!
//! The implementation remains bit-compatible with the locked cross-language
//! vectors and the separately maintained Python and Triton references.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
#[cfg(feature = "scale")]
use parity_scale_codec::{Decode, Encode};
#[cfg(feature = "scale")]
use scale_info::TypeInfo;

/// Canonical tile size in bytes.
pub const TILE_BYTES: usize = 4096;
/// 32-bit little-endian words per tile.
pub const TILE_WORDS: usize = TILE_BYTES / 4;
/// Coefficient index stride (golden ratio, murmur-style).
pub const GOLDEN32: u32 = 0x9E37_79B9;

/// Canonical scheme identifier of this PoRW verification scheme, as pinned by
/// `ExecutionProfile.porw_scheme_id` and returned by `IPoRWVerifier.schemeId()`
/// in the aigg-spec modular interfaces (aigg-spec
/// `docs/architecture/mep-porw-modular-interfaces.md` §6.4). Version 2 =
/// 4 KiB tiles, per-word slot-fresh odd u32 coefficients (murmur3 fmix32),
/// blake3 tile Merkle commitments, strictly-ascending coverage order.
/// Any change to those semantics is a NEW scheme id, never a reinterpretation.
pub const PORW_SCHEME_ID: &str = "aigg:porw:sketch-tile:v2";

/// 32-byte digest of [`PORW_SCHEME_ID`] for compact on-chain verifier pinning.
pub fn porw_scheme_digest() -> Hash32 {
    *blake3::hash(PORW_SCHEME_ID.as_bytes()).as_bytes()
}

const FMIX_M1: u32 = 0x85EB_CA6B;
const FMIX_M2: u32 = 0xC2B2_AE35;

/// murmur3 32-bit finalizer.
#[inline]
pub fn fmix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(FMIX_M1);
    h ^= h >> 13;
    h = h.wrapping_mul(FMIX_M2);
    h ^= h >> 16;
    h
}

/// Per-tile coefficient seed.
#[inline]
pub fn tile_seed(slot_seed: u32, tile_idx: u64) -> u32 {
    fmix32(fmix32(slot_seed ^ (tile_idx as u32)))
}

/// Per-word coefficient, forced odd.
///
/// Odd multiplication is bijective for one `u32` word, so a single-word MSB
/// delta is nonzero. This does not make the sum collision resistant: applying
/// the MSB delta to two words always cancels because the sum of two odd
/// coefficients is even.
#[inline]
pub fn word_coeff(r_tile: u32, j: u32) -> u32 {
    fmix32(r_tile.wrapping_add(j.wrapping_mul(GOLDEN32))) | 1
}

/// Linear algebraic sketch of one scheme-formatted tile: sum over 32-bit LE words of
/// `coeff(j) * word(j) mod 2^32`. Order/partition independent (modular sum),
/// so matching kernel decompositions agree. This value is not a cryptographic
/// commitment and must not be treated as proof of byte equality or residency.
pub fn sketch_tile(slot_seed: u32, tile_idx: u64, tile: &[u8; TILE_BYTES]) -> u32 {
    let r_tile = tile_seed(slot_seed, tile_idx);
    let mut acc = 0u32;
    for (j, word) in tile.chunks_exact(4).enumerate() {
        let w = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        acc = acc.wrapping_add(word_coeff(r_tile, j as u32).wrapping_mul(w));
    }
    acc
}

/// Per-identity slot seed: first 4 LE bytes of
/// `blake3(global_challenge || device_id)`.
///
/// A deployment adapter defines and authenticates the meaning of `device_id`.
pub fn derive_slot_seed(global_challenge: &[u8; 32], device_id: &[u8; 32]) -> u32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(global_challenge);
    hasher.update(device_id);
    let hash = hasher.finalize();
    let bytes = hash.as_bytes();
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

// ---------------------------------------------------------------------------
// Tile Merkle commitments (binary blake3 tree, duplicate-last padding)
// ---------------------------------------------------------------------------

/// 32-byte Merkle node/root.
pub type Hash32 = [u8; 32];

/// Leaf for the weights commitment `R_W`: blake3(LE64 tile_idx || tile bytes).
pub fn weights_leaf(tile_idx: u64, tile: &[u8; TILE_BYTES]) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&tile_idx.to_le_bytes());
    hasher.update(tile);
    *hasher.finalize().as_bytes()
}

/// Leaf for the per-slot sketch commitment `partials_root`:
/// blake3(LE64 tile_idx || LE32 s_tile).
pub fn partials_leaf(tile_idx: u64, s_tile: u32) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&tile_idx.to_le_bytes());
    hasher.update(&s_tile.to_le_bytes());
    *hasher.finalize().as_bytes()
}

fn merkle_parent(left: &Hash32, right: &Hash32) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(left);
    hasher.update(right);
    *hasher.finalize().as_bytes()
}

/// Merkle root over leaves (duplicate-last padding at each level).
/// Empty input yields the hash of the empty string.
pub fn merkle_root(leaves: &[Hash32]) -> Hash32 {
    if leaves.is_empty() {
        return *blake3::hash(&[]).as_bytes();
    }
    let mut level: Vec<Hash32> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let right = pair.get(1).unwrap_or(&pair[0]);
            next.push(merkle_parent(&pair[0], right));
        }
        level = next;
    }
    level[0]
}

/// Inclusion proof: sibling hashes from leaf level to root.
pub fn merkle_proof(leaves: &[Hash32], mut index: usize) -> Vec<Hash32> {
    let mut proof = Vec::new();
    let mut level: Vec<Hash32> = leaves.to_vec();
    while level.len() > 1 {
        let sibling = if index % 2 == 0 {
            *level.get(index + 1).unwrap_or(&level[index])
        } else {
            level[index - 1]
        };
        proof.push(sibling);
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let right = pair.get(1).unwrap_or(&pair[0]);
            next.push(merkle_parent(&pair[0], right));
        }
        level = next;
        index /= 2;
    }
    proof
}

/// Verify an inclusion proof produced by [`merkle_proof`].
pub fn merkle_verify(root: &Hash32, leaf: &Hash32, mut index: usize, proof: &[Hash32]) -> bool {
    let mut acc = *leaf;
    for sibling in proof {
        acc = if index % 2 == 0 {
            merkle_parent(&acc, sibling)
        } else {
            merkle_parent(sibling, &acc)
        };
        index /= 2;
    }
    acc == *root
}

// ---------------------------------------------------------------------------
// Tickets and envelope
// ---------------------------------------------------------------------------

/// Number of ticket-sized units represented by the coverage and multiplier.
/// `m_t_millis` is the service multiplier in thousandths of a full coverage
/// sweep. Interpreting this value for eligibility or rewards is deployment
/// policy outside this crate.
pub fn ticket_count(coverage_bytes: u64, m_t_millis: u64, ticket_unit: u64) -> u64 {
    (coverage_bytes.saturating_mul(m_t_millis) / 1000) / ticket_unit.max(1)
}

/// Arithmetic envelope check comparing claimed traffic with an adapter-supplied
/// byte budget. It does not authenticate hardware or enforce an economic bound.
pub fn check_envelope(coverage_bytes: u64, m_t_millis: u64, bandwidth_bytes_per_slot: u64) -> bool {
    // coverage_bytes * m_t_millis / 1000 <= bandwidth_bytes_per_slot
    coverage_bytes.saturating_mul(m_t_millis) <= bandwidth_bytes_per_slot.saturating_mul(1000)
}

/// Derive the `chunk_index`-th 32-byte audit chunk from a
/// solution commitment, via blake3 XOF over
/// (model_id || partials_root || slot_seed). `model_id` is mixed in so a
/// device announcing several models cannot replay one ticket stream across
/// all of them.
pub fn ticket_chunk(
    model_id: &Hash32,
    partials_root: &Hash32,
    slot_seed: u32,
    chunk_index: u64,
) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(model_id);
    hasher.update(partials_root);
    hasher.update(&slot_seed.to_le_bytes());
    let mut reader = hasher.finalize_xof();
    let mut out = [0u8; 32];
    reader.set_position(chunk_index.saturating_mul(32));
    reader.fill(&mut out);
    out
}

// ---------------------------------------------------------------------------
// Cross-audit scheduling (epoch replica cross-verification)
// ---------------------------------------------------------------------------
//
// These helpers assume the deployment supplies a participant set whose members
// can access the same committed bytes. They do not establish that access,
// residency, or participant identity. A deployment must also define beacon
// unpredictability, admission, communications, deadlines, and any consequence
// of a failed audit.

/// Domain separator for all cross-audit derivations.
const AUDIT_DOMAIN: &[u8] = b"porw-cross-audit-v1";

/// Per-epoch audit beacon: blake3(domain || entropy || LE64 epoch).
///
/// Security properties of `entropy`, including when it becomes knowable, are
/// requirements of the deployment adapter.
pub fn audit_beacon(epoch: u64, entropy: &Hash32) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(AUDIT_DOMAIN);
    hasher.update(entropy);
    hasher.update(&epoch.to_le_bytes());
    *hasher.finalize().as_bytes()
}

/// Rank hash ordering auditor candidates for one (model, target) pair.
fn audit_rank(beacon: &Hash32, model_id: &Hash32, target: &Hash32, auditor: &Hash32) -> Hash32 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(AUDIT_DOMAIN);
    hasher.update(beacon);
    hasher.update(model_id);
    hasher.update(target);
    hasher.update(auditor);
    *hasher.finalize().as_bytes()
}

/// The up-to-`k` replica devices assigned to audit `target` this epoch:
/// the `k` lowest rank hashes among the model's replica set, excluding the
/// target itself. Deterministic for all observers; an empty result means the
/// model has no peer entries. The deployment decides how to handle that case.
pub fn select_auditors(
    beacon: &Hash32,
    model_id: &Hash32,
    target: &Hash32,
    replicas: &[Hash32],
    k: usize,
) -> Vec<Hash32> {
    let mut ranked: Vec<(Hash32, Hash32)> = replicas
        .iter()
        .filter(|device| *device != target)
        .map(|device| (audit_rank(beacon, model_id, target, device), *device))
        .collect();
    ranked.sort_unstable();
    ranked.truncate(k);
    ranked.into_iter().map(|(_, device)| device).collect()
}

/// The `t` distinct canonical tile indices auditor `auditor` samples from
/// `target`'s commitments this epoch, drawn from a blake3 XOF stream over
/// (beacon, model, target, auditor). If `t >= n_tiles` every tile is audited.
///
/// The sample is over the model's full tile space; the auditor checks the
/// intersection with the tiles the target actually committed (uncommitted
/// tiles have nothing to compare against). Modulo bias over u64 draws is
/// negligible for any real `n_tiles`.
pub fn audit_tile_sample(
    beacon: &Hash32,
    model_id: &Hash32,
    target: &Hash32,
    auditor: &Hash32,
    n_tiles: u64,
    t: usize,
) -> Vec<u64> {
    if n_tiles == 0 {
        return Vec::new();
    }
    if t as u64 >= n_tiles {
        return (0..n_tiles).collect();
    }
    let mut hasher = blake3::Hasher::new();
    hasher.update(AUDIT_DOMAIN);
    hasher.update(b"tiles");
    hasher.update(beacon);
    hasher.update(model_id);
    hasher.update(target);
    hasher.update(auditor);
    let mut reader = hasher.finalize_xof();
    let mut picked = Vec::with_capacity(t);
    let mut buf = [0u8; 8];
    // t < n_tiles, so t distinct draws always exist; duplicates are simply
    // redrawn from the stream.
    while picked.len() < t {
        reader.fill(&mut buf);
        let idx = u64::from_le_bytes(buf) % n_tiles;
        if !picked.contains(&idx) {
            picked.push(idx);
        }
    }
    picked
}

// ---------------------------------------------------------------------------
// Solution and fraud proof types
// ---------------------------------------------------------------------------

/// Scheme solution data. Authentication and acceptance are adapter concerns.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "scale", derive(Encode, Decode, TypeInfo))]
pub struct PorwSolution {
    /// Adapter-defined participant identity bytes.
    pub device_id: [u8; 32],
    /// Adapter-supplied model commitment root (`R_W`) this solution references.
    pub model_id: [u8; 32],
    /// Folded sketch over the coverage set (fast consistency check).
    pub sketch: u32,
    /// Merkle root of per-tile sketch values — anchor for tile-granular
    /// fraud proofs.
    pub partials_root: [u8; 32],
    /// Covered bytes (size of the coverage set) this slot.
    pub coverage_bytes: u64,
    /// Service multiplier in thousandths of a full coverage sweep.
    pub m_t_millis: u64,
    /// Adapter-selected ticket chunk index.
    pub chunk_index: u64,
    /// Adapter-defined 64-byte signature over [`PorwSolution::signing_payload`].
    /// The signature suite and identity binding are not verified by this crate.
    pub signature: [u8; 64],
}

impl PorwSolution {
    /// Scheme-defined authentication payload: every field except the signature,
    /// plus `global_challenge`. An adapter chooses and verifies the signature
    /// suite and decides how challenges map to protocol periods.
    pub fn signing_payload(&self, global_challenge: &Hash32) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 * 4 + 8 * 3 + 4);
        out.extend_from_slice(global_challenge);
        out.extend_from_slice(&self.device_id);
        out.extend_from_slice(&self.model_id);
        out.extend_from_slice(&self.sketch.to_le_bytes());
        out.extend_from_slice(&self.partials_root);
        out.extend_from_slice(&self.coverage_bytes.to_le_bytes());
        out.extend_from_slice(&self.m_t_millis.to_le_bytes());
        out.extend_from_slice(&self.chunk_index.to_le_bytes());
        out
    }
}

/// Tile-granular fraud proof against a committed solution: shows that the
/// per-tile sketch value committed under `partials_root` disagrees with the
/// value recomputed from bytes authenticated under `R_W`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "scale", derive(Encode, Decode, TypeInfo))]
pub struct TileFraudProof {
    /// The disputed tile.
    pub tile_idx: u64,
    /// Claimed per-tile sketch value from the submitted commitment.
    pub claimed_s_tile: u32,
    /// Position of the disputed leaf in the submitted partials tree. The
    /// partials tree is built in coverage order, so for a non-contiguous
    /// (MoE) coverage set the leaf position differs from `tile_idx`. Purely
    /// an opening hint: the leaf hash itself binds `tile_idx`, so a wrong
    /// position simply fails to verify — it can never mis-attribute a value
    /// to a different tile.
    pub partials_index: u64,
    /// Inclusion proof of `(tile_idx, claimed_s_tile)` under `partials_root`.
    pub partials_proof: Vec<[u8; 32]>,
    /// Tile bytes whose BLAKE3 Merkle opening is supplied below.
    pub tile_bytes: Vec<u8>,
    /// Inclusion proof of `(tile_idx, tile_bytes)` under the model's `R_W`.
    pub weights_proof: Vec<[u8; 32]>,
}

/// Outcome of verifying a [`TileFraudProof`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FraudVerdict {
    /// Proof is valid and demonstrates a committed mismatch: the claimed value
    /// and tile bytes both authenticate, and the recomputed sketch disagrees.
    Fraud,
    /// Proof is valid but the recomputed sketch agrees — no fraud shown.
    NoFraud,
    /// Proof is malformed (bad lengths or Merkle paths do not verify).
    Invalid,
}

/// Verify a tile fraud proof against a solution's commitments.
///
/// The verifier derives the per-identity slot seed from `global_challenge` and
/// the solution's adapter-defined `device_id`.
pub fn verify_tile_fraud_proof(
    solution: &PorwSolution,
    global_challenge: &[u8; 32],
    model_root: &Hash32,
    proof: &TileFraudProof,
) -> FraudVerdict {
    if proof.tile_bytes.len() != TILE_BYTES {
        return FraudVerdict::Invalid;
    }
    // 1. The claimed per-tile value must be committed under partials_root.
    // The leaf position is the coverage-order index the reporter supplies;
    // the leaf hash binds tile_idx, so the position cannot lie about which
    // tile the value was committed for.
    let claimed_leaf = partials_leaf(proof.tile_idx, proof.claimed_s_tile);
    if !merkle_verify(
        &solution.partials_root,
        &claimed_leaf,
        proof.partials_index as usize,
        &proof.partials_proof,
    ) {
        return FraudVerdict::Invalid;
    }
    // 2. The tile bytes must authenticate against the supplied R_W root.
    let tile: &[u8; TILE_BYTES] = proof
        .tile_bytes
        .as_slice()
        .try_into()
        .expect("length checked above; qed");
    let weights_leaf_hash = weights_leaf(proof.tile_idx, tile);
    if !merkle_verify(
        model_root,
        &weights_leaf_hash,
        proof.tile_idx as usize,
        &proof.weights_proof,
    ) {
        return FraudVerdict::Invalid;
    }
    // 3. Recompute the true sketch and compare.
    let slot_seed = derive_slot_seed(global_challenge, &solution.device_id);
    let true_s_tile = sketch_tile(slot_seed, proof.tile_idx, tile);
    if true_s_tile == proof.claimed_s_tile {
        FraudVerdict::NoFraud
    } else {
        FraudVerdict::Fraud
    }
}

// ---------------------------------------------------------------------------
// Opening-availability responses (data-availability challenges)
// ---------------------------------------------------------------------------
//
// This module checks two response forms against `partials_root`:
//
// - the tile WAS committed → its opening (which the auditor then cross-checks,
//   and can turn into a `TileFraudProof` if the value is wrong); or
// - the tile was NOT committed → a non-inclusion proof: the pair of adjacent
//   committed leaves that bracket the challenged tile index.
//
// Non-inclusion is checkable because the scheme requires coverage sets in
// STRICTLY ASCENDING tile order and the caller supplies the committed leaf
// count. Challenge publication, response deadlines, and consequences remain
// deployment-adapter responsibilities.

/// One committed leaf presented as evidence: its tile index, committed sketch
/// value, position in the partials tree, and inclusion proof.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "scale", derive(Encode, Decode, TypeInfo))]
pub struct LeafWitness {
    /// Canonical tile index bound into the leaf hash.
    pub tile_idx: u64,
    /// Committed per-tile sketch value.
    pub s_tile: u32,
    /// Leaf position in the partials tree (coverage order).
    pub index: u64,
    /// Merkle inclusion proof under `partials_root`.
    pub proof: Vec<Hash32>,
}

impl LeafWitness {
    fn verify(&self, partials_root: &Hash32, n_leaves: u64) -> bool {
        self.index < n_leaves
            && merkle_verify(
                partials_root,
                &partials_leaf(self.tile_idx, self.s_tile),
                self.index as usize,
                &self.proof,
            )
    }
}

/// A response to an opening challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "scale", derive(Encode, Decode, TypeInfo))]
pub enum OpeningResponse {
    /// The challenged tile was committed: here is its opening.
    Committed(LeafWitness),
    /// The challenged tile was not committed: the adjacent committed leaves
    /// bracketing it (coverage is strictly ascending). `left`/`right` may be
    /// absent only at the respective boundary of the tree.
    NotCommitted {
        /// Greatest committed leaf below the challenged tile (`None` iff the
        /// challenged tile precedes the whole coverage set).
        left: Option<LeafWitness>,
        /// Smallest committed leaf above the challenged tile (`None` iff the
        /// challenged tile follows the whole coverage set).
        right: Option<LeafWitness>,
    },
}

/// Verify an [`OpeningResponse`] against a solution's commitments.
///
/// `n_leaves` is supplied by the caller, typically derived as
/// `coverage_bytes / TILE_BYTES` from an adapter-authenticated solution.
/// Returns the opened value for a committed tile (`Some(s_tile)`), `None` for
/// valid non-commitment, and `Err(())` when the response does not verify.
#[expect(
    clippy::result_unit_err,
    reason = "the locked v2 API uses Err(()) for every invalid response"
)]
pub fn verify_opening_response(
    partials_root: &Hash32,
    n_leaves: u64,
    challenged_tile: u64,
    response: &OpeningResponse,
) -> Result<Option<u32>, ()> {
    match response {
        OpeningResponse::Committed(leaf) => {
            if leaf.tile_idx == challenged_tile && leaf.verify(partials_root, n_leaves) {
                Ok(Some(leaf.s_tile))
            } else {
                Err(())
            }
        }
        OpeningResponse::NotCommitted { left, right } => {
            match (left, right) {
                // Bracketed by two adjacent committed leaves.
                (Some(l), Some(r)) => {
                    let adjacent = l.index + 1 == r.index;
                    let brackets = l.tile_idx < challenged_tile && challenged_tile < r.tile_idx;
                    if adjacent
                        && brackets
                        && l.verify(partials_root, n_leaves)
                        && r.verify(partials_root, n_leaves)
                    {
                        Ok(None)
                    } else {
                        Err(())
                    }
                }
                // Beyond the last committed leaf.
                (Some(l), None) => {
                    if l.index + 1 == n_leaves
                        && l.tile_idx < challenged_tile
                        && l.verify(partials_root, n_leaves)
                    {
                        Ok(None)
                    } else {
                        Err(())
                    }
                }
                // Before the first committed leaf.
                (None, Some(r)) => {
                    if r.index == 0
                        && challenged_tile < r.tile_idx
                        && r.verify(partials_root, n_leaves)
                    {
                        Ok(None)
                    } else {
                        Err(())
                    }
                }
                // An empty coverage set never authors a solution (zero
                // tickets), so "no leaves at all" is not a valid answer.
                (None, None) => Err(()),
            }
        }
    }
}

#[cfg(test)]
mod tests;
