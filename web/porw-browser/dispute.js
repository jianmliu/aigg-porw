// Execution dispute — the verifier/contract logic, noble only. Narrows a disagreement between two
// executors (same MEP, same stimulus) to ONE synapse term and checks it against the commitments:
//   step  : first s with actRoot_A[s] != actRoot_B[s]        (both agree on actRoot[s-1], or step 0 = stimulus)
//   neuron: descend both parties' act trees for step s* to the first differing leaf i*
//   row   : each party's claimed act_s*[i*] must equal min(lastPartialSum >> 16, clamp)   (row check)
//   term  : first CSR position k* where the parties' partial sums diverge; verify the synapse record
//           (csrRoot chunk proof), the row bounds (rowRoot proofs), the input act_{s*-1}[pre] (a shared
//           opening against the AGREED previous-step root, or the stimulus rule), recompute w*act and
//           require partialAfter == partialBefore + term for each party.
import * as V from "./verify.js";
import { treeWidths } from "./porw.js";

export function firstDifferingStep(rootsA, rootsB) { for (let s = 0; s < rootsA.length; s++) if (!V.eq(rootsA[s], rootsB[s])) return s + 1; return null; }

/** nodeA/nodeB(level, idx) -> 32 B; returns the first leaf index whose subtree differs */
export function bisectLeaf(nodeA, nodeB, n) {
  const w = treeWidths(n); let level = w.length - 1, idx = 0; const rounds = [];
  if (V.eq(nodeA(level, 0), nodeB(level, 0))) return { leaf: null, rounds };
  while (level > 0) {
    const l = 2 * idx, r = 2 * idx + 1; const lw = w[level - 1];
    const left = !V.eq(nodeA(level - 1, l), nodeB(level - 1, l));
    rounds.push({ level: level - 1, idx: left ? l : r });
    if (left) idx = l; else if (r < lw) idx = r; else idx = l; // duplicate-last: right child == left
    level--;
  }
  return { leaf: idx, rounds };
}

export function firstDivergentTerm(sumsA, sumsB) { for (let j = 0; j < sumsA.length; j++) if (sumsA[j] !== sumsB[j]) return j; return -1; }

/** Adjudicate at neuron i*, step s*. Returns { loser: "A"|"B"|null, reason, checks } */
export function adjudicate({ n, nChunks, chunk, csrRoot, rowRoot, synapseRoot, prevActRoot, stimulusSeed, step, i,
                             rowStart, rowEnd, chunkOpen, preOpen, partyA, partyB }) {
  const checks = {};
  checks.synapseRoot = V.eq(V.synapseRootOf(csrRoot, rowRoot), synapseRoot);
  checks.rowBounds = V.merkleVerifyCounted(rowRoot, V.rowStartLeaf(i, rowStart.value), i, n + 1, rowStart.proof)
                  && V.merkleVerifyCounted(rowRoot, V.rowStartLeaf(i + 1, rowEnd.value), i + 1, n + 1, rowEnd.proof);
  if (!checks.synapseRoot || !checks.rowBounds) return { loser: null, reason: "bad commitments/openings", checks };
  const k0 = rowStart.value, k1 = rowEnd.value, len = k1 - k0;
  const rowCheck = (p) => len === 0 ? p.claimedAct === 0 : p.sums.length === len && V.rowActivation(p.sums[len - 1]) === p.claimedAct;
  checks.rowA = rowCheck(partyA); checks.rowB = rowCheck(partyB);
  if (checks.rowA !== checks.rowB) return { loser: checks.rowA ? "B" : "A", reason: "claimed activation inconsistent with own partial sums", checks };
  if (!checks.rowA) return { loser: null, reason: "both rows inconsistent", checks };
  const j = firstDivergentTerm(partyA.sums, partyB.sums);
  if (j < 0) return { loser: null, reason: "partial sums identical (activation cannot differ)", checks };
  const kStar = k0 + j; checks.kStar = kStar;
  // synapse record at k* from the opened CSR chunk
  const c = Math.floor(kStar / chunk); checks.chunkIdx = c === chunkOpen.c;
  checks.chunkProof = V.merkleVerifyCounted(csrRoot, V.csrChunkLeaf(chunkOpen.c, chunkOpen.records), chunkOpen.c, nChunks, chunkOpen.proof);
  if (!checks.chunkIdx || !checks.chunkProof) return { loser: null, reason: "bad chunk opening", checks };
  const rec = V.record(chunkOpen.records.subarray((kStar - chunkOpen.k0) * 10, (kStar - chunkOpen.k0) * 10 + 10));
  checks.recordPost = rec.post === i;
  // input activation act_{s-1}[pre]
  let actPre;
  if (step - 1 === 0) actPre = V.stimulusAct(rec.pre, stimulusSeed);
  else { const o = preOpen; checks.preProof = o.i === rec.pre && V.merkleVerifyCounted(prevActRoot, V.actLeaf(o.i, o.act), o.i, n, o.proof); if (!checks.preProof) return { loser: null, reason: "bad input activation opening", checks }; actPre = o.act; }
  const term = BigInt(rec.w) * BigInt(actPre); checks.term = term.toString();
  const okA = partyA.sums[j] === (j ? partyA.sums[j - 1] : 0n) + term, okB = partyB.sums[j] === (j ? partyB.sums[j - 1] : 0n) + term;
  checks.termA = okA; checks.termB = okB;
  if (okA === okB) return { loser: null, reason: okA ? "both terms consistent (divergence earlier?)" : "both terms wrong", checks };
  return { loser: okA ? "B" : "A", reason: `term at CSR position ${kStar} (${rec.pre}->${i}, w=${rec.w}, act_pre=${actPre})`, checks };
}
