# ADR 0002 — A slot position that contradicts the text does not win the match

Status: accepted
Date: 2026-07-29
Corpus evidence: `corpus/virtualized-scroll`, `corpus/list-reordered`, `corpus/node-replaced`

## Context

§2 orders the identity signals strongest-first: `data-testid` → `role+accessibleName`
(unique) → `tag+semanticPath+siblingOrdinal` → `textFingerprint` → … But Phase 2's
acceptance criteria demand the opposite in one specific case: for a reordered list, "ids
follow content, not position".

Both are right, and the conflict only appears when the two signals **disagree**:

- Virtualized list: row elements are removed from the top and appended at the bottom.
  Every surviving row's slot ordinal shifts. Matching by ordinal pairs *different* logical
  rows (slot 3 before ≠ slot 3 after) and produces a wall of phantom content changes;
  matching by own-text pairs them correctly and the diff collapses to the truth:
  six rows added, six removed, survivors silent.
- Reordered list: same story, no additions at all.

## Decision

`semanticPath + siblingOrdinal` carries its full weight **only when the own-text
fingerprints do not contradict it** (both match, or both are empty). When the texts
disagree, the positional signal is demoted well below a text match (25 → 8), so a
same-text candidate elsewhere wins over a same-slot candidate with different text.

Anonymous nodes that match on position alone, with contradicting text and no
`data-testid`/authored name, are reported as
`{kind: "possible-replacement", match: "ambiguous", beforeId, afterId, beforeName, name}`
— never as a confident `content` change. Position alone cannot distinguish "survived and
was rewritten" from "was replaced"; the honest output says so and hands the consumer both
ids and both names.

## Consequences

- The prompt's ordering is preserved for the common case (signals agree).
- Recycled/reordered rows keep their identity by content, which is what an agent needs.
- Giving rows a `data-testid` (or an authored name) upgrades matches to `exact`/`strong`
  and the same mutation then reports plain `content` — better signals earn a more
  confident answer, which is the intended gradient.
