# Phase D — Somebody else's benchmark (Mind2Web-Live / WebCanvas)

2026-08-01 · `claude-opus-5`, effort `high` · `experiment/formal/d-third-party.mjs`

Our formal benchmark gives **119/120 (99%)** on tasks we wrote ourselves. This phase runs
tasks we did **not** write, on live sites, judged by criteria we did **not** write: the
subset of `iMeanAI/Mind2Web-Live` whose scoring steps ("key nodes") can be judged entirely
by URL (`url_included_match` / `url_exactly_match`) — 23 of the first 40 tasks, of which 8
were run. The metric is WebCanvas's, not ours.

## The result that matters

| Benchmark | Success |
|---|---:|
| Our formal benchmark (our own tasks) | **99%** (119/120 cells) |
| **Mind2Web-Live, this tool** | **28%** (8 of 29 key nodes) |
| Tasks with ALL their key nodes | 1 of 8 |

**Our tasks were easy.** The 28% lands exactly where the literature puts current agents on
the live web (~30%, *An Illusion of Progress?*, 2025). It is the empirical confirmation of
the warning `docs/LANDSCAPE.md` had already given us, and the reason the 119/120 **must
not be used as evidence of capability** — it measures the channel on reachable tasks, not
what the agent can do.

## Per task (this tool, complete run)

| # | Task | Key nodes | Steps | Tokens |
|---|---|---:|---:|---:|
| 5 | overview of submission of releases | **2/2** | 6 | 15k |
| 0 | nearest Gamestop to 90028 and set as home store | 1/2 | 25 | 126k |
| 1 | compare AeroAPI plans on flightaware | 1/3 | 22 | 90k |
| 3 | status of train S92 on new.mta.info | 1/3 | 6 | 7k |
| 8 | find a person by address on yellowpages | 1/5 | 22 | 133k |
| 10 | cheapest plus-size one-piece swimsuit | 1/8 | 25 | 138k |
| 12 | 2022 Tesla Model 3 on carmax | 1/3 | 19 | 91k |
| 4 | iPhone repair status on apple | 0/3 | 11 | 26k |

The pattern: it reaches the site (the first key node) almost every time, and loses the
middle steps — filters, multi-field forms, flows needing a login or earlier state.

## The comparison arm is INCOMPLETE — I am not drawing a conclusion from it

The API credit ran out halfway through the run. Of the 8 tasks, **only 3 executed**; the
other 5 returned `400 credit balance too low` with 0 steps.

On those 3 comparable tasks, the numbers are:

| # | This tool | Screenshot |
|---|---:|---:|
| 0 | 1/2 | 1/2 |
| 1 | 1/3 | **2/3** |
| 3 | 1/3 | **2/3** |
| total | 3/8 | **5/8** |

**With n=3 tasks this supports no conclusion at all** — but the direction is against us,
not for us, which is exactly why it is written down. The honest statement is: **this phase
provides no evidence that the structural channel improves success on third-party tasks.**
Its measured advantage is in cost and in verification (phases B and C), not in capability.

## Hygiene: another silent failure of my own

The first run of the screenshot arm reported "17% of key nodes" with five runs of 0 steps.
A `catch { break }` was **swallowing the API error**, and the dead runs read as legitimate
agent failures. Fixed: retry with back-off on 429 and 5xx, and the error recorded in every
result. That is the third time in this cycle that a silent failure appeared in my own
harness — the same pattern the tool hunts in pages.

## What it would take to close this phase

- Restore credit and run the screenshot arm completely (8 tasks, about $4).
- Widen to the 23 URL-judgeable tasks with 2 or more repetitions (about $25–30).
- Key nodes of the `element_path` kind stay out of scope: judging them means replicating
  WebCanvas's own DOM harness.

## Reproducing

```bash
export ANTHROPIC_API_KEY=...
node packages/agent/experiment/formal/d-third-party.mjs --arm oracle --tasks 8
```

Raw data: `results/d-third-party-oracle.json`, including the URLs visited and the detail
of every key node.
