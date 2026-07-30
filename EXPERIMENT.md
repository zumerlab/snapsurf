# Phase 5 — the decisive experiment

Status: **layer 1 (signal quality) RUN and PASSED. Layer 2 (model in the loop) BUILT and
BLOCKED on `ANTHROPIC_API_KEY`.**
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

## Layer 2 — model in the loop (built, blocked)

`packages/agent/experiment/harness.mjs` — Playwright drives all three arms over four
corpus-derived apps (remount-heavy SPA, modal flow, canvas dashboard, live-noise page)
and six tasks across the five strata. With a key it asks the same model the same question
per arm and records task accuracy, input tokens, latency and cost. Without one it runs in
**dry mode**: every arm still executes, every mechanical metric is recorded, and the
model-dependent metrics are reported as blocked rather than estimated.

Dry run, 3 repetitions per task (18 runs):

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

## What is still missing before this is a launch benchmark

- **Model-dependent metrics** (task success, action count, invalid clicks, screenshot
  fallback rate, run-to-run stability, cost): require `ANTHROPIC_API_KEY`. Run
  `node packages/agent/experiment/harness.mjs --reps 5`.
- **N and breadth**: 6 tasks × 3 reps in dry mode. The spec asks for 5–8 tasks × ≥5 reps
  with the model, which is what the gated run does.
- **Cross-environment**: single engine, single viewport — by design (§10 claims
  same-environment repeatability only).

## Honest reading so far

The *information* claim is supported and the reason is structural, not incidental: C's
misses are all cases where the answer only exists after style and layout resolve, and no
amount of engineering inside the markup layer produces them. B also costs ~100× fewer
payload bytes than screenshots (245 B vs ~25 KB) and slightly fewer than C's mutation log
while answering strictly more questions.

What this does **not** yet show is that the extra information converts into agent task
success — that is exactly what layer 2 measures, and it is unrun. Until it runs, the
correct claim is "B provides signals C structurally cannot", not "B makes agents better".
