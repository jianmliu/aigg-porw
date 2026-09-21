# Proposal: holding the base is the threshold, stake is the selector

Status: **proposed, nothing implemented** — except the measurement that decides it, which is
`web/porw-browser/bench_derive_sketch.mjs` and is reported below. The measurements are from the BSC testnet deployment and the male
MaleCNS v1.0 brains on 2026-09-20 (`aigg-bnb` #80, #86: three live batteries, 126 runs, every counts digest
reproduced offline). The tile-locality result the proposal rests on is measured. The changes to
`InstanceRegistry`, `TaskMarket` and `MEPRegistry` are not written.

## The problem, in two numbers

`TaskMarket._draw` picks executors from `instancesOf[mepId]` — the instances that bonded **for that MEP**. Under
base+delta every derived individual is its own MEP, so the pool a fly is drawn from is whoever bonded for *that
fly*. On the testnet today: **205 MEPs, 100 of them minted flies, and `eligibleVotes` returns 0 for every one.**
Three batteries were run there this week and each needed its own `bond()` first, by the party posting the task.
A redundancy of 2 drawn from a set of 2 is not redundancy; it is two parties who each know who the other is.

Nobody bonds for a hundred flies because nobody can hold them:

| | measured |
|---|---|
| a derived payload, resident in a node | **455 MB RSS** (154,169,344 bytes, 37,639 tiles) |
| the recipe that produces it | **223 bytes** |
| one payload, in recipes | **691,342** |
| applying a recipe to the base | 7.5 s |
| a residency claim over every tile | 0.05 s |
| the task those serve: 42 battery runs | 1.4–1.6 min |

A hundred derived brains is 45 GB of the same wiring with one 2-byte field per record changed.

## The mechanism this proposal is about already exists

Sortition is **already stake-weighted**. `sortitionPick` takes an enrolled instance uniformly, then accepts it with
probability `weightOf(cand) / weightCap[mepId]`, where `weightOf = bonded / UNIT` capped at `MAX_WEIGHT = 16`.
Over repeated draws an instance is chosen in proportion to its stake among the eligible.

And stake is already global: `bonded[instance]` is one number, not one per brain. What is *not* global is the
roster. So a host's stake is real but its reach is whatever list it paid to be appended to, and the interesting
quantity — how much does staking more get me — has no answer that spans a collection.

**Holding the base should be a threshold, not a scarcity.** It costs 455 MB, every serious host can meet it, and
meeting it says the true thing: this host can answer for any brain derived from that base. Who actually gets drawn
should then be decided by what is at risk — stake — which is the one thing the dispute game can take away.

## What is already true and is not being used

FLYDELTA **in-place** (`proposals/flydelta-inplace`, implemented) was adopted so a wrong `model_id` would be
provable. It bought something else, unnoticed: the derived payload has the same layout as its base. Measured on
`malecns-v1.0-min2` against fly #101's payload (the recipe of pilot founder `M000`):

```
base 154,169,344 bytes | fly 154,169,344 bytes | same length: True
neuron ids identical : True
pre  array identical : True
post array identical : True
weights differ       : 14,862,925 of 15,283,237 records
4 KiB tiles: 37,639 total, 37,315 differ (99%)
```

Every record sits at the same byte offset in both and only its 2-byte weight changes. **Tile `f` of a derived
payload is a function of tile `f` of the base and the 223-byte recipe** — of at most its two neighbours as well,
since a 10-byte record can straddle a 4 KiB boundary, but of nothing further away.

That is what a residency claim needs. `node.js: _residency` sketches every resident tile under a challenge it
cannot choose; the sketch of a tile computed from base+recipe **is** the sketch of the assembled tile. Same bytes,
arrived at differently. The verifier cannot tell and does not need to.

## The proposal in three decisions

**1. A node serves a base and derives tiles on demand.** No protocol change: the claim, the claim hash, the tile
fraud proof and `verifyClaim` are untouched, because the bytes committed to are the same bytes. It is a change to
`PorwNode` — hold one base resident, hold recipes, compute a derived tile when a sketch or a fraud proof asks for
it, assemble the payload only when actually drawn (7.5 s, against a 1.4-minute task).

A host that lies about a tile is caught by the proof that catches it today, because the tile it computes from the
recipe is the tile it should have stored.

**2. Enrolment is per base, so stake reaches the whole collection.** `bondFor` writes `inMep[mepId][instance]` and
pushes to `instancesOf[mepId]` per MEP: a hundred storage writes per host, repeated for every fly minted later.
Instead let an instance enrol for a base and let a derived MEP's roster be its base's, so a stake bought once is
weight in every draw of every brain derived from it — including flies that do not exist yet.

This needs something the registry lacks: **`MEPRegistry` stores no link from a derived MEP to its base.** The delta
names its base in its own bytes (`base_model_id`), but the chain never sees the delta. A registration path that
records it — `registerDerived(m, baseMepId, …)` writing `baseOf[id]` — is a prerequisite, and `FlyCollection` is
its natural caller.

`weightCap` must move with the roster. It is the denominator of the acceptance test and only grows; a per-MEP cap
left behind a per-base roster silently changes acceptance rates.

**3. Eligibility and claims follow enrolment.** `isEligible` asks `lastValidEpochPlus1(inst, mepId)`: one claim
leaf per (instance, MEP) per epoch and one `materialize` transaction each. A host serving a hundred flies posts a
hundred. Against the base: one claim, one leaf, one materialize, covering everything derived from it.

## What it buys

- **The draw for any fly comes from everyone holding the base**, in proportion to stake. Collusion stops being a
  matter of finding one counterparty and becomes a matter of holding a share of the staked weight — which is the
  thing the protocol can already price, cap (`MAX_WEIGHT = 16`) and confiscate.
- **Staking more has a meaning that spans a collection.** Today it buys weight in the lists you paid to join.
- **Enrolment stops scaling with the collection.** A fly minted tomorrow is served by every existing host with no
  transaction from any of them — which the relayer's whitelist already assumes and the registry does not support.
- **The per-epoch chain work stops multiplying by the number of brains.** Not hypothetical: the testnet relayer went
  from 3 MEPs to 205 when a founder collection launched and exhausted a public RPC and then a paid one the same
  day. Sketching is not the cost (0.05 s per brain); the per-MEP bookkeeping is.

## What it costs, and what it does not fix

- **7.5 s of assembly** between being drawn and answering, on a task of 1.4 minutes. Cacheable per brain actually
  asked about.
- **A host can claim brains it has never assembled.** It can, and this is the point rather than a leak: residency
  is the threshold, not the scarcity. It was never what makes a result trustworthy — the dispute game is, and a
  wrong result is bisected to a single signed synapse term and the bond taken (`e2e_batch`, end to end on anvil).
  What the claim asserts is *ability to answer*, and "I hold the base and this recipe" is exactly that. The claim
  becomes cheaper to make **truthfully**; it does not become cheaper to make falsely, because the fraud proof is
  unchanged.
- **It does not fix redundancy 1.** A larger pool makes a draw of 2 meaningful; it does not choose 2. The requester
  still picks `redundancy`, and the three live runs used 1 because there was nobody else to draw.
- **It concentrates a failure.** One base serving a whole collection means a host with a corrupt base is wrong
  about every fly at once, and a `MAX_WEIGHT` share of the staked weight is a share of every draw rather than of
  one list. Both are already true of the female base; this makes them the normal case.
- **Deltas of deltas are unmeasured.** A child needs its parents' recipes, not only the base; the rule stays
  tile-local (`recompute_record` reads the record's own count and its parents'), but the working set is a chain of
  recipes. Cheap in bytes, not measured here.

## The number that decides it, measured — and the bar was wrong

`web/porw-browser/bench_derive_sketch.mjs`, on `malecns-v1.0-min2` and fly #101's 223-byte recipe:

| | |
|---|---|
| full residency claim on a resident payload (sketch + commit + sign) | **0.05 s** |
| derive every one of the 15,283,237 records, WASM `porw_sample_records` | **0.91 s** |
| **derived on demand: derive + claim** | **0.96 s — 19.7×** |
| the same derivation in JS (`applyProcedural`) | 4.21 s |

The bar this proposal set for itself — "within a small factor" — is **not met**. Twenty times is not a small
factor, and it was never going to be: a claim sketches 37,639 tiles, a derivation touches 15,283,237 records.
Those are different quantities of work and no implementation closes that.

The bar was the wrong one. Nothing has to be as cheap as holding a payload; it has to **fit an epoch**, against an
alternative that does not exist:

|  brains a host serves | derived on demand, per epoch | held resident |
|---|---|---|
| 1 | 1 s | 455 MB |
| 10 | 10 s | 4.4 GB |
| **100** | **1.6 min** of a ~10-minute epoch | 45 GB |
| 1000 | 16 min | 445 GB |

So at the size the collection actually is, a host pays about a sixth of an epoch to claim every fly, instead of
needing 45 GB to claim any of them. The ceiling is somewhere under a thousand brains per host, on this hardware.

### Capacity becomes the host's own decision, not a protocol parameter

This falls out of decision 1 and is the part worth keeping. **A claim cannot tell a held tile from a derived
tile** — same bytes, same sketch — so how much a host holds resident stops being anything the protocol knows or
needs to know. A host with 64 GB keeps many derived payloads warm, claims them at 0.05 s each and answers the
moment it is drawn. A host with 2 GB keeps the base and derives, and answers 7.5 s later. Both make the same
claim, and both claims are true.

That leaves three dials, and they are independent, which is the healthy part:

| | set by | decides |
|---|---|---|
| RAM | the host's own hardware | how many brains it can answer *fast* |
| stake | the host's own money | how often it is *drawn* |
| the sample size `k` | the protocol | what a claim *costs* |

A host that stakes for more weight than its RAM can serve is drawn more often than it can answer, and pays for it
in missed tasks. That is a real regulator and it needs no rule — but the cost of a missed draw is borne partly by
the requester, whose deadline passes, which is open point 3 arriving from a second direction.

### A claim over a sample, measured

The ceiling above is the cost of sketching *every* tile. A claim over a challenge-selected subset costs a
fraction and the tile fraud proof is unchanged, since it adjudicates one tile. Measured on the same brain:

| `k` tiles | fraction | derive | 100 brains per epoch | a host with 99% of it passes with |
|---|---|---|---|---|
| 256 | 0.7% | 6 ms | 0.6 s | 7.6 × 10⁻² |
| **1024** | **2.7%** | **26 ms** | **2.6 s** | **3.4 × 10⁻⁵** |
| 4096 | 10.9% | 102 ms | 10.3 s | 1.3 × 10⁻¹⁸ |
| 37,639 | 100% | 939 ms | 1.6 min | — |

`k = 1024` removes the ceiling: the per-epoch cost stops being the reason a host cannot serve a collection.

**An implementation note that cost a benchmark to find.** The first version of `bench_sampled_claim.mjs` called the
sampler once per tile and reported 666 ms for 256 tiles. That was the call overhead, not the work: **1.5 ms per
call**, so 37,639 calls spend 57 s of overhead on 0.93 s of derivation. The sample must be sorted and derived as
contiguous runs. A tile-at-a-time implementation is sixty times slower than the thing it is optimising.

**And the honest limit of what any of this proves.** The base is public — on Greenfield and on a CDN mirror, 154 MB
fetched in 8.4 s. A host that stores nothing can wait for the challenge, fetch what it needs and claim. Sampling
makes that cheaper; it does not create the hole. Under this proposal that is not a contradiction, because
residency is the threshold and not the scarcity: what separates a host that stores from one that re-fetches is
bandwidth against RAM, and what separates an honest executor from a liar is the bond. If residency were ever meant
to be load-bearing, a public base already removed the load.

Two things about the main number are worth separating from physics. **4.5× of today's cost is a missing
implementation**: `applyDeltaWasm` refuses layout 1 (*"in-place layout is not implemented in the WASM path"*), so
an in-place individual — which is every brain in the collection — derives in JS at 4.21 s. The inner loop
`porw_sample_records` is layout-independent and already exists; only the writeback is missing. And **the ceiling
moves only one way**: by not sketching every tile, measured above.

## Open points

1. **Where `baseOf` comes from.** A field written at registration makes the base a *claim by the registrant*
   rather than a fact about the bytes. Naming the wrong base yields a roster that cannot serve the brain —
   self-punishing, and visible the first time a task is drawn — but worth deciding rather than defaulting into.
2. **Whether a host may enrol for a base and refuse particular derivatives.** A host that will not serve one fly
   has no way to say so here, and being drawn for a task it refuses costs it the task, not the network. A per
   instance opt-out list is the obvious answer and is more storage than the thing being opted out of.
3. **What the threshold should cost.** If holding the base is the entry condition, a host that lies about holding
   it is drawn and fails to answer. Today nothing distinguishes that from being offline. A missed draw is already
   uncompensated; whether it should also be slashable is the question this proposal makes worth asking.
4. **The sample size.** Measured above; `k` is a protocol parameter and the table is the trade. It changes the
   claim and `verifyClaim`, which decisions 1–3 deliberately do not, so it belongs in its own proposal.
