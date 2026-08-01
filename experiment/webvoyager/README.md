# WebVoyager-25 — a public benchmark, run with our own perception channels

A reproducible replica of the evaluation published by **lumen** (Om Labs,
[omxyz/lumen](https://github.com/omxyz/lumen), MIT) over the **WebVoyager** benchmark
([MinorJerry/WebVoyager](https://github.com/MinorJerry/WebVoyager), Apache-2.0), with our
channels in place of theirs.

The question is not "who wins". It is **what does the perception channel contribute?**
Every arm shares the loop, the model, the prompt, the action set, the judge and the
metrics. The only variable is **what the model sees each turn**.

## What lumen does (so it is clear what is being replicated)

lumen is a vision-first browser agent: a perception loop over CDP where the model receives
**only screenshots** — no DOM, no selectors — decides an action (click, type, scroll,
goto) and observes the result. On top of the loop it adds four things that are scaffolding
rather than perception: two-level history compression, a per-site knowledge base
(`SiteKB`), an `ActionVerifier` heuristic after each action, and a `ModelVerifier`, a
second model call acting as a gatekeeper before declaring the task finished.

Their suite (`evals/webvoyager/run.ts`) does:

1. Load the 642 tasks from `WebVoyager_data.jsonl`.
2. Adapt stale dates (2023/2024) forward, preserving relative gaps.
3. Take **25 tasks** with per-site stratified sampling and a mulberry32 RNG, **seed 42**.
4. Run each task with `maxSteps = 50`, a 600 s timeout, and **up to 3 attempts**; if the
   judge rejects the result, the reason is fed back into the next attempt's instruction.
5. Judge with **gemini-2.5-flash**: it receives the question, the agent's reasoning and
   actions, and the **last screenshot**, and returns YES or NO with reasons.
6. Report `passRate`, `avgSteps`, `avgTokens`, `avgDurationMs` — **for the attempt that
   was recorded**, not the sum of all three.

Their published numbers (in `baselines/`, their files, not our re-runs): lumen 25/25 ·
browser-use 25/25 · stagehand 19/25.

## What we replicate exactly

| Piece | State |
|---|---|
| Dataset | **identical** — `data/WebVoyager_data.jsonl` is byte-identical to the copy in both repositories |
| Which 25 tasks | **identical** — `dataset.mjs` reproduces their 25 ids in the same order (check it: `node dataset.mjs`) |
| Date adaptation | **faithful port** of their `run.ts`, same instruction text |
| maxSteps / timeout / attempts | **identical** (50 / 600 s / 3 with judge feedback) |
| Judge | **same contract**: same system prompt, same YES/NO schema, same evidence (trace plus final screenshot). gemini-2.5-flash when `GEMINI_API_KEY` is set |
| Report schema | **a superset** of theirs — their fields plus pass@1, tokens in and out, cost, and the traces |

The final screenshot is given to the judge **in every arm**, including the one that never
saw pixels. The evidence used for grading is the same for all of them.

## The arms

| Arm | What the model sees each turn |
|---|---|
| `pixels` | only a JPEG screenshot of the viewport — the vision-first premise, our control |
| `oracle` | first turn: outline plus the map of clickable things; after that, **only the change report** — the product |
| `hybrid` | screenshot plus the change report |
| `snap` | **one** snapDOM capture giving pixels and structure from the *same moment* (the embedded configuration) |

The arms with our reader also get two verbs that cost no model tokens because they run in
the page: `find` (search text across the **whole** page, not just the visible part) and
`read` (read the text around a node). That is exactly the advantage this project claims,
and it is declared here rather than hidden.

## How to run it

```bash
# 1. Free: check the 25 sites, measure the first-turn payload per arm, estimate cost
node packages/agent/experiment/webvoyager/run.mjs --dry --headless

# 2. Verify we run the SAME 25 tasks as lumen
node packages/agent/experiment/webvoyager/dataset.mjs

# 2b. Free: smoke the whole loop with a scripted policy (zero model calls)
node packages/agent/experiment/webvoyager/run.mjs --mock --headless \
  --arms oracle,pixels,hybrid,snap --trials 1 --steps 6 --tasks "GitHub--25" --tag mock

# 3a. FREE: actor and judge on Google AI Studio's free tier
export GEMINI_API_KEY=...            # aistudio.google.com/apikey
node packages/agent/experiment/webvoyager/run.mjs --model gemini-2.5-flash --arms oracle,pixels

# 3b. Paid, to replicate lumen's exact model (needs ANTHROPIC_API_KEY)
node packages/agent/experiment/webvoyager/run.mjs --arms oracle,pixels
node packages/agent/experiment/webvoyager/run.mjs --arms oracle --limit 5 --trials 1   # cheap pilot

# 4. Comparison table (our results/ plus their baselines/)
node packages/agent/experiment/webvoyager/report.mjs --out RESULTS.md
```

Flags: `--arms` `--limit` `--trials` `--steps` `--model` `--tasks id,id` `--headless`
`--timeout` `--tag`. Default model `claude-sonnet-4-6`, the same one they used.

## Running it without spending anything (the Gemini backend)

The provider is chosen by the model id: `gemini-*` goes to Google AI Studio, anything else
to Anthropic. With a free AI Studio key the whole benchmark costs **$0** without changing
the method: same loop, same arms, tokens measured the same way (they come from
`usageMetadata`), same judge.

What to know first:

- **The free tier rate-limits and caps requests per day.** Every call, actor and judge,
  goes through `retry.mjs`: exponential back-off on 429 and 5xx, respecting `retry-after`.
  The run does not fall over, it stretches — plan hours, not minutes, for 25 tasks × 3
  attempts.
- **It changes the actor, which weakens the EXTERNAL comparison.** If our actor is
  `gemini-2.5-flash` and theirs was `claude-sonnet-4-6`, a difference against their rows
  could come from the model rather than from the channel. The **internal** comparison
  (`oracle` against `pixels`, same key, same loop) is unaffected, and it is the one that
  answers the product question.
- **Privacy**: on the free tier Google may use the data sent to improve its models. What
  is sent here is screenshots and outlines of public sites, but it is worth knowing.
- The cost reported in the JSON uses paid-tier list prices (see `../cost.mjs`) as a
  reference for "what this would have cost". On the free tier the real spend is $0.

## Honest readings, before looking at any number

**lumen's 100% is pass@3 with hints from the judge.** Their harness retries up to 3 times
and passes the agent the reason the judge rejected the previous attempt. That is outside
help a production agent does not have. The figure is recoverable from their own files: a
result recorded with `trial > 1` means attempt 1 was rejected. Running `report.mjs` over
their JSON:

| Run | pass@3 (their headline) | pass@1 (derived from their files) |
|---|---|---|
| lumen | 25/25 (100%) | 23/25 (92%) |
| browser-use | 25/25 (100%) | 25/25 (100%) |
| stagehand | 19/25 (76%) | 16/25 (64%) |

That is why our report always publishes **both** columns.

**Their `avgSteps` and `avgTokens` are from the attempt that was recorded**, not the total
cost of solving the task. A task solved on attempt 3 appears with attempt 3's steps and no
mention of the two before it. We keep both: `avgSteps`/`avgTokens` on their criterion, so
it is comparable, and `avgStepsAllTrials`/`avgTokensAllTrials`/`usdAllTrials` for what it
actually cost.

**This is not product against product.** lumen is a complete agent with a site knowledge
base, verifiers and an action cache. Our arms are a minimal loop whose only difference
from each other is the perception channel. Against their rows, our rows measure a
*channel*, not a *product*: if `pixels` lands below lumen, part of that distance is their
scaffolding, not their channel. The **internal** comparison (`oracle` against `pixels`,
same loop) is the only one that isolates the channel, and it is the one that matters here.

**Live sites, not a frozen corpus.** Amazon, Booking and Google Flights change between
runs and can defeat the harness. The `--dry` run on 2026-08-01 gave 25 of 25 sites loading
with no blocks (`results/dry.json`), but that expires. Re-run it before every paid run.

## Verification status (2026-08-01, without spending a cent)

- `dataset.mjs` → our 25 ids and their order match lumen's: **yes**.
- `--dry` over the 25 sites → 25/25 load, 0 blocks or captchas, payload measured per site
  (`results/dry.json`).
- The Gemini path verified against a local stub of the endpoint (`GEMINI_BASE_URL` pointed
  at a test server): well-formed request (images as `inlineData`, schema without
  `additionalProperties`, which Gemini rejects), a 429 retried and absorbed, tokens read
  from `usageMetadata`, judge invoked with the final screenshot, report written. It has
  not been tried against the real endpoint, which may differ from the stub.
- `--mock` over the 4 arms on real sites → all four complete without error. Payload per
  turn on GitHub (text characters / base64 image bytes):

  | Arm | Turn 1 | Turn 2 | Turn 3 |
  |---|---|---|---|
  | `oracle` | 25,363 / 0 | 12,271 / 0 | 3,359 / 0 |
  | `pixels` | 851 / 86,012 | 920 / 62,304 | 966 / 80,104 |
  | `hybrid` | 25,588 / 86,016 | 12,496 / 62,172 | 3,584 / 62,172 |
  | `snap` | 25,588 / 325,848 | 10,304 / 369,644 | 3,584 / 369,644 |

  The expected behaviour is visible: turn 1 pays for the full outline and the following
  turns are just the change report (25K → 3.4K characters), while `pixels` pays for a
  whole image every turn. Note on `snap`: snapDOM's PNG weighs roughly 4× the native JPEG
  screenshot in bytes. Token cost depends on dimensions rather than bytes, but upload time
  does not.

**What is missing**: the paid run. Nobody has measured accuracy with these arms yet; the
only rows with results in `RESULTS.md` are theirs.

## Cost

From the `--dry` run of 2026-08-01 (real payload measured per site, an upper bound
assuming no task ends before 50 steps, 3 attempts, 25 tasks):

| Arm | First-turn payload (median) | Worst case USD |
|---|---|---|
| `pixels` | 1,365 tokens (a 1280×800 image) | $30.5 |
| `oracle` | ~6,200 tokens | $36.5 |
| `hybrid` | ~7,500 tokens | $56.8 |

The bound is deliberately pessimistic for the reader arm: it assumes every step costs a
third of the first turn again, when in practice later turns are only the change report
(measured median in `../results/sweep.json`: tens of tokens). The realistic cost is a
fraction of this, because tasks finish well before 50 steps.

## Files

- `dataset.mjs` — loading, date adaptation, seed-42 sampling, and the self-check that our
  25 ids are theirs.
- `judge.mjs` — their judge (gemini-2.5-flash), with a declared Anthropic fallback.
- `run.mjs` — the loop, the 4 arms, attempts, and an incremental report (saved after every
  task: killing the run does not lose what is done).
- `report.mjs` — comparison table plus a per-task matrix.
- `data/` — vendored WebVoyager dataset (Apache-2.0, see `data/NOTICE`).
- `baselines/` — the JSON files published by lumen for lumen, stagehand and browser-use.
- `results/` — ours (`dry.json` and `webvoyager-<arm>-<model>-<timestamp>.json`).

NOT FOR PUBLICATION — part of the private `packages/agent` workspace.
