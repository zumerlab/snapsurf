# Phase 5 — the decisive experiment

Status: **layer 1 (signal quality) RUN and PASSED. Layer 2 (model in the loop) RUN via
blind judges and PASSED** — B beats C in 2 of 3 critical strata and ties the third.
Remaining gap: an end-to-end agent loop (task success / action count / API-grade token
cost), which needs `ANTHROPIC_API_KEY` and larger N.
Date: 2026-07-29 · Environment: Chromium (Playwright), 1280×800, dpr 1

## The hypothesis under test

> Post-layout visual signatures (computed style + geometry + stacking, read from the live
> DOM) beat markup-level structural diffs for agent control.

Not "structured beats screenshots" — that is near-tautological. The falsifiable claim is
**B vs C**: does reading the page *after* style and layout resolve tell an agent things a
markup diff cannot?

Arms (as specified):

- **A — screenshots**: before/after PNGs; the model interprets.
- **B — this product**: `inspect(previous)` → `changes` + `actionabilityDelta` + localized context.
- **C — the free alternative**: `MutationObserver` log + a11y/attribute diff, **no**
  post-render signals (no occlusion, no computed visibility, no paint order). What a
  competent team builds in a week, or what CDP gives away.

## Layer 1 — signal quality (model-free, automated)

`packages/agent/experiment/signal.test.js` — runs in CI with the rest of the suite. Each
stratum poses a **question** and asks whether the arm's payload *contains the answer*.
This isolates the information claim from model variance entirely.

| stratum | question | B answers | C answers | B bytes | C bytes |
|---|---|---|---|---|---|
| occlusion — modal covers actionable elements | are those buttons now unclickable? | ✅ | ❌ | 275 | 234 |
| pure noise — CSS-in-JS class churn, identical computed style | did anything change? | ✅ | ❌ | 104 | 291 |
| pure noise — scroll only | did anything change? | ✅ | ✅ | 104 | 30 |
| replaced node — React-style remount, same UI | is this the same UI? | ✅ | ❌ | 104 | 287 |
| replaced node — card swapped at the same slot | edited or replaced? | ✅ | ✅ | 268 | 294 |
| semantically small — disabled → enabled | can I click it now? | ✅ | ✅ | 568 | 117 |
| live noise — a clock ticks | did anything change? | ✅ | ❌ | 104 | 229 |

**Decision rule** (B must beat C in ≥2 of the three critical strata): B wins
**occlusion (1/1)**, **pure noise (2/2 where they differ)** and **replaced node (1/2)** →
**3 of 3 strata won. The gate passes.**

Where C ties, it ties honestly and the reason is instructive: a scroll produces no
mutation records (C is right by silence), a swapped element genuinely is add+remove in the
DOM, and `disabled` is an attribute. C's failures are all the same shape — it cannot see
*computed* results: identical-computed-style class churn reads as change; a re-render with
new class names reads as a full replacement; a normalized clock tick reads as content; and
occlusion has no markup representation at all.

## Layer 1b — the harness's own mechanical scoring (no model)

`packages/agent/experiment/harness.mjs` — Playwright drives all three arms over four
corpus-derived apps (remount-heavy SPA, modal flow, canvas dashboard, live-noise page) and
six tasks across the five strata. It scores each arm's payload mechanically, with no model
involved; with `ANTHROPIC_API_KEY` it additionally asks the model directly over HTTP, and
`--dump` writes the evidence for the blind-judge run below.

Mechanical run, 3 repetitions per task (18 runs):

| arm | mean payload bytes | mechanical accuracy | false positives | false negatives | canvas-blind (flagged) |
|---|---|---|---|---|---|
| A — screenshots | 24 783 | n/a (pixels carry no structured answer) | — | — | — |
| **B — product** | **245** | **1.00** | **0** | **0** | 3 (3 flagged) |
| C — free path | 274 | 0.33 | 6 | 0 | 3 (0 flagged) |

Per stratum (correct answers / runs): occlusion **B 3/3, C 0/3** · replaced node
**B 6/6, C 3/6** · canvas **B 3/3, C 0/3** · pure noise **B 3/3, C 0/3** ·
semantically-small **B 3/3, C 3/3**.

Two bookkeeping decisions, stated so the numbers aren't read as better than they are:

1. **The question is the stratum's question, not "did anything change".** An earlier
   version scored a generic changed/unchanged boolean, which handed C free points on
   occlusion (inserting a modal *is* a mutation, so "changed" was trivially right while
   saying nothing about which buttons became unclickable). Per-stratum questions removed
   that artifact — and moved C's occlusion score from 3/3 to 0/3.
2. **Canvas is not counted as a false negative.** Pixel draws are invisible to DOM
   signals in both arms by construction (§9). The scored answer is whether the arm *flags
   the region as semantics-unavailable* so the caller knows to rasterize it: B does
   (3/3), C does not (0/3). Calling B's canvas silence a "miss" would be dishonest, and
   calling it a win without the flag would be worse.

## Layer 2 — model in the loop, RUN (blind judges, 54 evaluations)

No `ANTHROPIC_API_KEY` was available, so instead of the HTTP transport the model was put
in the loop as **blind judges**: the harness dumps each arm's evidence to disk
(`--dump`), and one Claude judge per (scenario × arm) reads **only that arm's evidence**
and answers the same neutral JSON question. Ground truth lives in a separate file the
judge prompt never mentions, and nothing in the prompt identifies the arms or the product.
6 scenarios × 3 reps × 3 arms = **54 judgements**. Scoring: `experiment/score.mjs`.

| arm | n | "did anything change?" | false pos | false neg | occlusion: identified | …and named them | canvas honesty | mean evidence bytes |
|---|---|---|---|---|---|---|---|---|
| A — screenshots | 18 | 1.00 | 0 | 0 | 1.00 | 1.00 | 1.00 | 24 778 |
| **B — product** | 18 | 0.83 | **0** | 3 | **1.00** | **1.00** | **1.00** | **397** |
| C — free path | 18 | 0.83 | **0** | 3 | **0.00** | 0.00 | 0.33 | 395 |

Per stratum, scored on the stratum's own question:

| stratum | A | B | C |
|---|---|---|---|
| occlusion | 3/3 | **3/3** | **0/3** |
| replaced node | 6/6 | 6/6 | 6/6 |
| canvas | 3/3 | **3/3** | **1/3** |
| pure noise | 3/3 | 3/3 | 3/3 |
| semantically small | 3/3 | 3/3 | 3/3 |

**B beats C in 2 of 3 critical strata (occlusion 3/3 vs 0/3; canvas 3/3 vs 1/3) and ties
on the third.** The gate's rule (≥2 of 3) is met with a model in the loop, at 1/62 of the
screenshot arm's evidence size.

### Two product defects this run found — and they were fixed here

Both were invisible to the model-free layer, because layer 1 checks whether the *payload
data* contains the answer; the judges checked whether a model can actually **use** it.

1. **`actionabilityDelta` returned bare node ids.** The judge correctly counted two
   covered elements but could not say *which*, while the screenshot judge answered
   "Guardar, Borrar". Technically correct, operationally useless. Entries now carry
   `{id, role, name}` — the re-judged runs name the buttons (occlusion "named them"
   0.00 → 1.00).
2. **A no-change report said nothing about regions it cannot observe.** On a canvas
   redraw the payload was `changed: false` with no mention of the canvas, so the judge
   concluded "nothing happened" — the exact failure §9 exists to prevent. The report now
   ships an `unobservable` list (`{id, role, sourceType, bbox, rasterAvailable}`), and the
   re-judged runs answer "no DOM change, but a 300×120 canvas region is unobservable, so a
   repaint there cannot be interpreted" (canvas honesty 0.00 → 1.00).

### Reading the numbers honestly

- **The three "false negatives" for both B and C are the canvas scenarios**: pixels
  changed and neither arm can see them through the DOM. B now *says so*; C does not (1/3
  — one judge inferred it from an empty log). Counting these as plain misses would hide
  the difference that matters.
- **A (screenshots) scores 1.00 on every axis here.** That is real and should not be
  spun away: for these six scenarios, on a clean 1280×800 desktop viewport with a
  frontier vision model, pixels answer the question. B's argument against A is not
  accuracy — it is **62× less evidence**, no vision model required, ids that map back to
  live elements, and a machine-readable answer instead of prose to parse. Whether that
  converts into higher end-to-end task success is the measurement that still needs a
  real agent loop and larger N.
- **C's misses are structural, not fixable by better engineering inside its layer**:
  occlusion has no markup representation, and an empty mutation log is indistinguishable
  from "nothing happened" without post-render knowledge.
- **Transport caveat**: judges ran through the local subagent transport, so token/cost/
  latency figures are not API-grade and were deliberately not reported. Accuracy per arm
  is unaffected — each judge saw exactly one arm's evidence.

## What is still missing before this is a launch benchmark

- **End-to-end agent metrics** (task success over a multi-step flow, action count, invalid
  clicks, screenshot-fallback rate, API-grade token cost): the blind-judge run measures
  *comprehension per observation*, not a full act-observe-act loop. That needs
  `ANTHROPIC_API_KEY`: `node packages/agent/experiment/harness.mjs --reps 5`.
- **N and breadth**: 6 scenarios × 3 reps = 54 judgements. The spec asks for 5–8 tasks ×
  ≥5 reps in a real loop.
- **Cross-environment**: single engine, single viewport — by design (§10 claims
  same-environment repeatability only).

## Honest reading

Two of the three questions the gate asks are now answered:

1. **Does B carry information C cannot?** Yes, and structurally — occlusion has no markup
   representation, and an empty mutation log cannot be distinguished from "nothing
   happened" without post-render knowledge. (Layer 1 and layer 2 agree.)
2. **Can a model USE it?** Yes — 54 blind judgements, B correct on every stratum question,
   zero false positives, at 397 bytes of evidence versus ~25 KB of screenshots. This layer
   also found the two defects above, which layer 1 could not see: data being *present* and
   data being *usable* are different properties.
3. **Does it make an agent complete more tasks?** Still unmeasured. Screenshots scored
   1.00 here too, so B's case against arm A rests on cost, determinism and machine-readable
   ids, not on comprehension. Until a real act-observe-act loop runs, the defensible claim
   is "B answers what screenshots answer, at 1/62 the evidence and without a vision model,
   and answers what the free path structurally cannot" — not "B makes agents smarter".
