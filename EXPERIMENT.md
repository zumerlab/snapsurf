# Phase 5 — the decisive experiment

Status: **all three layers RUN. The gate passes.**
Layer 1 (signal quality, model-free) · layer 2 (model in the loop, Claude API) ·
layer 3 (end-to-end act-observe-act loop) — the last of which found and killed a real
product defect that neither of the other two could see.

Date: 2026-07-29 · Environment: Chromium (Playwright), 1280×800, dpr 1 ·
Model: `claude-opus-5`, effort `low`, structured outputs · API spend for the reported
runs: **$1.72**

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
| occlusion — modal covers actionable elements | are those buttons now unclickable? | ✅ | ❌ | 557 | 234 |
| pure noise — CSS-in-JS class churn, identical computed style | did anything change? | ✅ | ❌ | 122 | 291 |
| pure noise — scroll only | did anything change? | ✅ | ✅ | 122 | 30 |
| replaced node — React-style remount, same UI | is this the same UI? | ✅ | ❌ | 122 | 287 |
| replaced node — card swapped at the same slot | edited or replaced? | ✅ | ✅ | 286 | 294 |
| semantically small — disabled → enabled | can I click it now? | ✅ | ✅ | 586 | 117 |
| live noise — a clock ticks | did anything change? | ✅ | ❌ | 122 | 229 |

Where C ties, it ties honestly and the reason is instructive: a scroll produces no
mutation records (C is right by silence), a swapped element genuinely is add+remove in the
DOM, and `disabled` is an attribute. C's failures are all the same shape — it cannot see
*computed* results: identical-computed-style class churn reads as change; a re-render with
new class names reads as a full replacement; a normalized clock tick reads as content; and
occlusion has no markup representation at all.

## Layer 2 — model in the loop, one observation at a time

`packages/agent/experiment/harness.mjs --reps 5`. Playwright drives all three arms over
four corpus-derived apps (remount-heavy SPA, modal flow, canvas dashboard, live-noise
page) and six tasks across five strata; each arm's evidence goes to `claude-opus-5` over
HTTP with the **same neutral prompt** and a server-enforced JSON verdict schema, so a
malformed reply can never be miscounted as a wrong answer. 6 tasks × 5 reps = **30
observations per arm**.

| arm | evidence bytes | "did anything change?" | false pos | false neg | occlusion: identified | …and named them | canvas honesty | input tok / obs | latency | $ / 30 obs |
|---|---|---|---|---|---|---|---|---|---|---|
| A — screenshots | 24 773 | 1.00 | 0 | 0 | 1.00 | 1.00 | 0.00 | 3 206 | 5.6 s | 0.5446 |
| **B — product** | **328** | 0.83 | **0** | 5 | **1.00** | **1.00** | **1.00** | 751 | 3.8 s | **0.1715** |
| C — free path | 274 | 0.83 | **0** | 5 | **0.00** | 0.00 | 0.00 | 748 | 4.0 s | 0.1827 |

Per stratum, scored on the stratum's own question (model in the loop):

| stratum | A | B | C |
|---|---|---|---|
| occlusion | 5/5 | **5/5** | **0/5** |
| replaced node | 10/10 | 10/10 | 10/10 |
| canvas | 0/5 † | **5/5** | **0/5** |
| pure noise | 5/5 | 5/5 | 5/5 |
| semantically small | 5/5 | 5/5 | 5/5 |

**Decision rule** (B must beat C in ≥2 of the three critical strata): B wins **occlusion**
and **canvas**, ties **replaced node** → **the gate passes**, at 1/76 of the screenshot
arm's evidence and 1/3 of its cost per observation.

† **A's canvas 0/5 is a scoring artifact, not a failure, and should not be read as a win
for B.** The canvas question is "is any region opaque to you?" — for pixels the answer is
genuinely *no*, so arm A answering "understandable" is correct behaviour and the metric
penalises it for being right. The canvas stratum is a fair **B vs C** comparison (both are
DOM-based and both are blind to pixel draws by construction, §9); it is not a fair A
comparison at all. B's five points are for *admitting* the blind spot so a caller knows to
rasterize; C stays silent, which is the failure §9 exists to prevent.

The five "false negatives" for both B and C are the same five canvas runs. Counting them
as plain misses would hide the only difference that matters there.

Also worth stating plainly: **arm A scores 1.00 on every axis it can be fairly scored on.**
For these six scenarios, on a clean desktop viewport with a frontier vision model, pixels
answer the question. B's argument against A at this layer is not accuracy — it is 76×
less evidence, 3× lower cost per observation, no vision model required, ids that map back
to live elements, and a machine-readable answer instead of prose to parse.

### An earlier run of this layer, without an API key

Before a key was available, the same evidence was judged by **blind Claude subagents**
(one per scenario × arm, each seeing exactly one arm's evidence, ground truth in a file
the prompt never mentions): 54 judgements, same verdict, same gate result. Scoring rules
are now shared by both paths (`experiment/verdict.mjs`), and re-scoring the stored blind
verdicts through the refactor reproduces the original summary byte-for-byte.

That run earned its keep by finding two defects the model-free layer structurally could
not see — data being *present* and data being *usable* are different properties:

1. **`actionabilityDelta` returned bare node ids.** The judge counted two covered
   elements correctly but could not say *which*, while the screenshot judge answered
   "Guardar, Borrar". Entries now carry `{id, role, name}`.
2. **A no-change report said nothing about regions it cannot observe.** On a canvas
   redraw the payload was `changed: false` with no mention of the canvas, so the judge
   concluded "nothing happened". Reports now ship an `unobservable` list.

## Layer 3 — end-to-end agent loop (act → observe → act)

`packages/agent/experiment/loop.mjs --reps 10`. This is the layer the spec actually asks
for, and the two layers above cannot substitute for it: they measure *comprehension per
observation*, not whether an agent finishes the job.

**Task**: "Save the document." The goal button sits at the bottom of the page and is
physically covered by a raised cookie bar. A second dismissable bar sits at the top and
covers nothing. So the decisive fact is **geometric and has no markup representation**,
and an arm that cannot see occlusion has to *guess which bar to clear* — a 50/50 that
costs an action when it loses. Actions are delivered as real coordinate clicks
(`mouse.click` at the element's centre), never Playwright's actionability-checked
`element.click()`: an agent aiming at a covered button really does hit whatever is on
top, and that miss is the metric. Max 4 actions per run, 10 runs per arm.

| arm | task success | actions to success | optimal runs (2 actions) | invalid clicks | input tok / step | $ / 10 runs |
|---|---|---|---|---|---|---|
| A — screenshots | 1.00 | 2.3 | 7/10 | 0 | 7 134 | 0.403 |
| **B — product** | **1.00** | **2.0** | **10/10** | **0** | **2 771** | **0.1715** |
| C — free path | 0.90 | 3.67 | 0/10 | **8** | 2 800 | 0.2429 |

B finishes in the optimal two actions in every single run, at 2.4× less cost than the
screenshot arm. C is the honest baseline behaving exactly as the hypothesis predicts:
never optimal, 8 clicks that landed on something other than the element it aimed at, and
one run in ten that never saved at all within the action budget.

### The defect this layer found — and it was fixed here

The first run of this loop said something uncomfortable: **arm A beat arm B**, 2.0 actions
against 3.0, 10 runs out of 10, with no variance. B was clearing *both* overlays and
always starting with the wrong one.

The cause was precise. `covered` was a boolean: B told the agent that something was in the
way, never *what*. With two candidate overlays the only safe plan is to clear all of them.
The bounding boxes were in the payload, so the answer was derivable by arithmetic — and
expecting the caller to do that arithmetic is the wrong side of §"expose classes, not
floats". `elementFromPoint` already returns the occluding element; collapsing it to a
boolean was throwing the answer away.

Covered nodes now carry `coveredBy: {id?, role, name?, label?}`, surfaced in the context
outline, the Set-of-Mark entries and `actionabilityDelta.becameCovered`. Resolved after
the walk and after every hash, so another node's geometry can never reach this node's
identity (§1); not serialized into the checkpoint, because it is an observation, not
identity. Cost: one `textContent` read per covered interactive node. ADR:
`docs/adr/0003-name-the-occluder.md`. Corpus contract: `actionability.coveredByIncludes`
on the `modal-overlay` and `nested-modal-stack` fixtures — and writing that contract
immediately corrected a wrong assumption of mine, since in a stacked-dialog case the
occluder is the *Confirm button*, not the dialog, which is the more useful answer.

Same fixture, same model, same prompts, after the fix: **3.0 → 2.0 actions, 0/10 → 10/10
optimal.** All 36 `packages/agent` tests stay green, and every number in this document
was re-measured on the fixed code so no table mixes code versions.

## What is still missing before this is a launch benchmark

- **Breadth of the loop**: one task, one app, one model, N=10. The single-observation
  layer covers five strata; the loop covers occlusion only. Multi-page flows, forms,
  virtualized lists and a second model are untested.
- **Run-to-run variance is real at small N**: at N=5, arm C scored 1.00 task success in
  one run and 0.40 in the next with identical code. The N=10 table above is the reported
  one; treat single-digit-N differences in any of these tables as noise.
- **Cross-environment**: single engine, single viewport — by design (§10 claims
  same-environment repeatability only).
- **No cost-at-scale model**: per-observation and per-run costs are measured, but not the
  token cost of a long session where B's checkpoints accumulate.

## Honest reading

1. **Does B carry information C cannot?** Yes, and structurally. Occlusion has no markup
   representation and an empty mutation log cannot be distinguished from "nothing
   happened" without post-render knowledge. All three layers agree; the loop turns it into
   8 invalid clicks and a failed run.
2. **Can a model use it?** Yes. 30 API-grade observations per arm: zero false positives,
   occlusion identified *and named* 5/5, the canvas blind spot declared 5/5, at 328 bytes
   of evidence against ~25 KB of screenshots.
3. **Does it make an agent complete more tasks?** On this task, with this model: it
   completes them in **fewer actions than pixels** (2.0 vs 2.3, always optimal) at 2.4×
   lower cost, and more reliably than the free path (1.00 vs 0.90 success, 0 vs 8 invalid
   clicks). That is one task, so the defensible claim is narrow: *where the deciding fact
   is post-layout, B is the cheapest arm that gets it right, and the only arm that gets it
   right without a vision model.* Not "B makes agents smarter".

The methodological point is the one worth keeping: each layer found something the layer
below it could not. Model-free scoring proved the data is there; blind judges proved a
model can read it, and found two defects; the action loop proved a model can *act* on it,
and found a third that both earlier layers scored 1.00 on.
