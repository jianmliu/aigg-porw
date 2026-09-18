# Proposal: in-place derivation for procedural brains, so a wrong `model_id` is provable

Status: decisions 1–4 are **implemented** in `web/porw-browser/delta.js` and `demo/fly_brain/flywire_delta.py` (layout byte,
name rule, founders as zero-parent crosses, record-local rule `inheritRecord` / `recompute_record`); the on-chain verifier
and the registration bond are not. Measured after implementing: an in-place individual and its compact twin give the same
`execDigest` (zero weights are inert), at 2.3× the execution time; a founder on the ≥ 2 base with mean ratio 0.92 expresses
2,689,164 records against the real fly's 2,700,513. One correction to decision 3: a zero-parent founder has the `v2`
individual's *distribution*, not its draws (the cross uses its own seed domains). It has to be decided before the
first derived individual is registered, because it fixes the payload layout and therefore every derived `model_id`.

## The problem

A procedural delta (`FLYDELTAv2` individual, `FLYDELTAv3` child) is a recipe; the MEP is registered on the `model_id`
of the payload the recipe produces. Today that payload is *compact*: records whose resampled count falls below
`min_syn` are dropped and the rest re-packed. So tile `t` of a child depends on how many records survived before it,
which depends on the whole brain. A registrant who declares a wrong `model_id` gets a MEP nobody can reproduce —
self-punishing, but not provable: there is no small statement "this tile is wrong" that a contract could check.

## The proposal in four decisions

**1. Records stay where the base put them.** An in-place payload has the base's header (except the name), the base's
root ids, and the base's records in the base's order; a record's weight is `sign · g` when the resampled count
`g ≥ min_syn` and `0` otherwise. Nothing is dropped or re-sorted. Then, for every record index `j`,

    child.record[j].w = G(base.record[j], parentA.record[j], parentB.record[j], recipe)

and the byte offset of record `j` is the same in every brain of the lineage. The int-lif kernel is indifferent to zero
weights. Only in-place edits compose with this layout: a `v1` delta on an in-place brain may set existing records
(including to zero) and nothing else; procedural deltas in in-place mode carry no explicit ops.

**2. The name has the base's length.** The header holds a variable-length name, and one extra byte would shift every
record in the file. In in-place mode the name must be exactly as long as the base's; canonical value: the first
`len` characters of the hex delta id.

**3. It is a layout flag, not a new version.** `FLYDELTAv3` has a reserved byte after `granularity`; `0` = compact
(today), `1` = in-place. Founders need no separate format: a founder is a `v3` cross whose parents are both the zero id
(the base) with `mut_rate_q32 = 0xFFFFFFFF`, defined as "every record mutates", i.e. a fresh draw everywhere — exactly
what `v2` computes. Same recipe, two materializations, two different `model_id`s.

**4. Sample from a ≥ 2-synapse base with mean ratio 0.92.** An in-place payload is as large as its base, and an
individual can only express connections its base lists, so the base threshold `T` trades size against coverage.
Measured on both releases (the sampler is keyed by record identity, so an individual of the ≥ T base is exactly the
≥ 1 individual restricted to records with base count ≥ T; three seeds, expressed = resampled count ≥ 5):

| base `T` | female payload | covers expressed records / synapses | male payload | covers records / synapses | zero-weight records in a payload |
|---|---|---|---|---|---|
| 1 | 152 MB | 100% / 100% | 257 MB | 100% / 100% | 80% / 74% |
| **2** | **77 MB** | **94.9% / 97.7%** | **154 MB** | **96.8% / 98.8%** | 62% / 58% |
| 3 | 50 MB | 85.1% / 92.9% | 107 MB | 88.8% / 95.4% | 47% / 44% |
| 4 | 37 MB | 74.7% / 87.6% | 80 MB | 79.8% / 91.3% | 36% / 33% |
| 5 | 28 MB | 65.0% / 82.0% | 64 MB | 70.9% / 86.9% | 27% / 25% |

Where an individual's expressed connections come from (female): base count 1 → 2.1% expressed, 5.1% of the expressed
records but 2.3% of the synapses; count 2 → 11%, 9.8%, 4.8%; count 3 → 23%; count 4 → 36%; count ≥ 5 → 74%, 65% of
the records and 82% of the synapses. Dropping the count-1 records halves the payload and loses 2.3% of the synapses;
dropping count 2 as well loses another 4.8%. `T = 2` is the knee.

Density against the real animal matters for dynamics, and the threshold alone does not set it. Sampling around the
published counts with mean ratio 1 treats one noisy draw as the mean, so individuals come out denser than the fly they
derive from (female, `T = 2`: 107% of its records, 113% of its synapses). The left/right data already say what the
ratio should be: the mirror connection of a connection with count `c` has mean 0.92 `c` (regression to the mean). With
`mean_ratio = 0.90–0.95` at `T = 2` an individual has 98–103% of the real fly's ≥ 5 records and 99–106% of its synapses
(female 0.90: 97.6% / 98.8%; male 0.95: 99.0% / 102.3%). Proposed default: `T = 2`, `mean_ratio_q16 = 60293` (0.92).

## What becomes provable

A registration declares `(recipe, model_id)`. The claim "this `model_id` is not what the recipe produces" reduces to one
of two local statements, each checkable from a few 4 KB tiles with Merkle proofs against already-registered roots:

- **Wrong record.** The challenger opens the tile(s) holding record `j` in the child (against the declared `model_id`),
  in the base, and in each parent (against their registered `model_id`s), and the contract recomputes `G`: one hash for
  the pick, one for the mutation decision, and — only if the record mutates — the negative-binomial draw. The sampler
  was specified in Q256 fixed point with floor divisions, which is the EVM's word size (`mulDiv` for the 512-bit
  products), so the on-chain rule is the same integer procedure, not an approximation of it. Records are 10 bytes and
  tiles 4096, so a record can straddle two tiles; the proof then carries both.
- **Wrong static tile.** Header (outside the name bytes), root ids and padding must equal the base's tile: the child's
  leaf for such a tile must equal a function of the base's leaf, shown with the two openings.

The proof is local in space (one record) and in depth (it reads the parents' *committed* tiles; it never recurses into
grandparents, whose correctness was challengeable when the parents were registered). Estimated cost, to be measured
once written: calldata for up to four tiles plus proofs ≈ 0.3 M gas; the fixed-point `ln`/`exp` ≈ 70 iterations of
256-bit arithmetic; the CDF walk ≈ one `mulDiv` pair per unit of the drawn count — tens of thousands of gas for typical
counts, a few million for the largest (2,405). A registration then needs what a claim has: a bond and a challenge
window, which is where the breeding fee can sit while it is at risk.

## What it costs

- **Size.** 77 MB (female) and 154 MB (male) per resident individual instead of 20–28 MB, 58–62% of it zeros. A node
  holding the base can rebuild an individual in about a second, so it need not keep more than the ones it is executing
  resident; hosting many individuals is then bounded by the base, which argues for base-inherited eligibility.
- **Execution.** The kernel walks every record; 2.6× more records than the compact payload (female). A node may execute
  from a compacted copy, but execution disputes are adjudicated against `synapseRoot`, which is over the in-place
  records, so the row and term openings must index the in-place payload. Skipping zero weights in the kernel loop is the
  cheap mitigation.
- **Two ids per recipe.** Compact and in-place materializations of one recipe have different `model_id`s. A collection
  should pick one; this proposal says in-place for anything registered on-chain, compact for local research.

## Open points

1. Whether zero-weight records should be excluded from `synapses` in the MEP profile (they are records of the payload;
   the proposal keeps them, so `mep_id` stays a pure function of the bytes).
2. The male base's excitability under `int-lif:v1` (one pinned weight unit calibrated on FlyWire counts) is a separate
   issue, but a base published for a collection should settle it first, since the base's `model_id` anchors the lineage.
3. The slashing source for a wrong registration: a registration bond sized to the fraud proof's worst-case gas.

Measurements: flyaudio `analysis/individual/candidate_threshold.py`, `results/individual/candidate_threshold.json`.
