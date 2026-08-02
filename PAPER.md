# snapDOM Agent: checking whether a web agent's action actually did anything

Draft, rewritten in English · 2026-08-01 · private branch `agent-lab`

## Summary

A program that uses a web page — clicking, typing, navigating — has to answer one
question after every step: *did that work?*

Most tools answer it by looking again. They take another screenshot, or fetch the
accessibility tree again, and let the model compare. That works until the page has a
clock, a spinner or a carousel on it. Then the picture is different even when nothing
happened, and the model can conclude it succeeded when it didn't.

snapDOM Agent adds a second reading to snapDOM. It walks the page after the browser has
applied styles and computed layout, and records what it saw. Before an action you save a
reference point. After the action it walks again and compares the two. It tells you what
changed, in words a program can act on: something was added, removed, its text changed,
its state changed, its style changed, it moved, or it got bigger or smaller. It also
tells you which element, how confident it is that this is the same element as before, and
whether a control that used to be clickable is now covered by something else.

This is not a replacement for screenshots, and it is not a replacement for any existing
browser tool. It is one more source of information, and it is best at one specific job:
telling you that a step did nothing, on a page where the picture changed anyway.

What is measured, with the file that holds each number:

- On 19 hand-written test cases it got all 19 right, with no false alarms on the 8 noise
  cases (`experiment/results/bench-qa.md`).
- On 8 deliberately planted silent failures, checking a stated expectation produced 0
  wrong "it worked" answers. Three other channels produced 6 each out of 8
  (`experiment/results/c-false-green.md`).
- On tasks written by other people it completed 28% of the scoring steps — the same range
  everyone else is in. Our own task suite gave 99%, which means our tasks were easy
  (`experiment/formal/results/d-third-party.md`).

The third result is the important one to read first. This tool does not make an agent
better at finishing tasks. It makes the agent's failures visible.

## 1. The problem

There are three common ways to let a program see a web page, and each leaves a gap.

**A picture answers "what does it look like", not "what changed".** A button can go from
disabled to enabled without changing a single pixel. A clock can change hundreds of
pixels while the application state is identical.

**The accessibility tree describes structure, not appearance or stacking.** It does not
say that a font finished loading and re-flowed the text, and it does not say that a
dialog is now sitting on top of the Buy button.

**Most agents never check at all.** They act and move on. If the click did nothing and
the page had some motion in it anyway, the agent believes it made progress.

That last case has a name in this document: **a wrong success report**. The agent says
the action worked; an independent check of the application says it did not. Published
work outside this project measures this as a large share of all agent failures when
nothing verifies the agent independently, and a small share when something does. Those
numbers come from tool-use and coding benchmarks, not from browser agents, so treat them
as a reason to care, not as evidence about this tool (see `docs/LANDSCAPE.md` §2.3).

## 2. What it does

It is a plugin for snapDOM. It runs inside the page, as ordinary JavaScript. It does not
need Chrome DevTools Protocol and it does not launch a second browser. That is what lets
it work inside a Chrome extension, inside a copilot embedded in someone else's app, or
inside an Electron webview, where the usual tools cannot run.

The loop is:

1. Look at the page and save a reference point.
2. Do something.
3. Look again.
4. Compare, and report the difference.

A typical answer is "the Save button went from disabled to enabled", or "the Buy button
is now covered by the cookie banner". If nothing relevant changed it says so, even if a
clock kept ticking the whole time.

Four things come out of one look:

- a list of the things you can click, with role, name and position;
- an indented outline of the page, shaped for a model to read;
- a reference point with no image and no copy of the page;
- the comparison against an earlier reference point.

The picture is still available when the question is genuinely visual. Pixels and
structure come from the same snapDOM capture, so they describe the same moment.

On large pages the walk is split into slices so the tab does not freeze. If the page
changes while the walk is paused, the result is marked `torn` instead of being presented
as one clean instant.

## 3. How it represents a page

### 3.1 Deciding that two elements are the same element

Comparing two readings of a page is not a matter of comparing positions. A framework can
destroy an element and build an identical one; for the user it is still the same button.
The same framework can also reuse one row on screen to display a different record.

The matcher combines several clues: a `data-testid` attribute, the accessible role, the
accessible name, the path through the document, the position among siblings, the text,
and the surrounding context. It does not report a probability, because a probability is
hard to act on. It reports one of five words: `exact`, `strong`, `ambiguous`, `new` or
`removed`.

When position and text disagree, it does not pick a winner. It reports
`possible-replacement`. On reordered and recycled lists, saying "I am not sure" is worth
more than inventing a text change that never happened.

### 3.2 Three separate fingerprints per element

Every element gets three:

- **content**: tag, role, its own text, its interactive state, and a few visual styles;
- **subtree**: a hash covering the element and everything under it;
- **geometry**: position and size, measured relative to the nearest ancestor that
  positions or scrolls its contents.

Geometry is kept apart on purpose. Moving a button is not the same event as changing its
text, and a child moving does not make the whole tree look changed.

While an animation is running on a property that moves or resizes the box, the geometry
fingerprint is frozen. Otherwise a shimmer or a spinning logo reports motion on every
frame. The freeze is inherited by descendants: on one real site, 162 of 162 false alarms
at rest were children of a single animated strip.

### 3.3 State, privacy, and what it refuses to answer

It detects `disabled`, `checked`, `expanded`, `pressed`, `selected` and `open`.

Field values are hashed so an edit is detected, but only a mask is stored. Passwords,
emails, phone numbers, one-time codes and card fields do not even get the mask. The hash
is not salted, so someone holding a saved reference point could test a *guess* against
it. Treat saved reference points from pages with secret values as sensitive.

You can also give it a list of strings to hide. Any name, label, text or state value
containing one of them leaves as `[redacted]` on every surface. Matching still works,
because identity travels as hashes rather than as readable text. Asking whether a hidden
string exists is refused rather than answered, because answering would confirm it. Every
reading taken with rules active carries a count of how many times each rule matched,
identified by rule number and never by the rule's text — naming the rule in a report sent
to a model would leak the thing you asked to hide. Screenshots are pixels and are not
covered by any of this. Full detail in `docs/PRIVACY.md`.

Canvas elements are reported as visible content with no readable structure. Iframes it
cannot open are reported the same way. It does not pretend to understand things that only
exist as pixels, and every change report carries the list of regions it could not read —
"nothing changed that I can see, and here is what I cannot see."

## 4. How it was evaluated

Three layers, kept separate so the quality of the tool is not confused with the quality
of the model using it.

**Layer 1 — is the reading correct?** No model involved. Each case has a hand-written
correct answer. This measures detection, false alarms and misses, and gives the same
result every run.

**Layer 2 — does it help a model finish a task?** A model solves real tasks through
different channels. This measures the whole system, so the results depend on the model,
the prompt and the sites.

**Layer 3 — does the agent's claim match reality?** An independent check decides what
really happened. It never uses this tool's own output as the truth. It reads the
application state directly, or a public API, or the URL.

That separation is the point: the thing being tested does not get to grade itself.

## 5. Results

Everything in this section was re-run on 2026-08-01 with no API spend, except §5.6, §5.7,
§5.9 and §5.10, which need a paid model and are reported from their stored runs.

### 5.1 Detecting change

19 cases: 11 real changes, 8 that only look like changes. The real ones include edited
text, a button becoming enabled, a replaced element, a reordered list and a change inside
a shadow root. The noise ones include a clock, a scroll, leftover hover styling, a CSS
animation, a CSS-in-JS class rewrite and a canvas repaint.

| Method | Right | False alarms (of 8 noise cases) | Missed (of 11 real) |
|---|---:|---:|---:|
| **snapDOM Agent** | **19/19** | **0** | **0** |
| Perceptual pixel difference | 13/19 | 5 | 1 |
| Accessibility tree text diff | 16/19 | 2 | 1 |

The pixel method missed the `disabled` flip, which has no visual difference. The
accessibility tree missed a late font swap that did change the rendered page.

The same 19 cases were also run through `agent-browser`'s snapshot diff, the closest
comparable thing that exists in public. As it comes out of the box it scores 11/19,
because its element references are renumbered between readings and every reading
therefore looks different. After normalizing those references away it scores 17/19
(`experiment/results/e1-agent-browser.md`). The remaining distance is concentrated in
text noise and in changes with no textual representation — a real gap, but a much smaller
one than the comparison against pixels suggests.

### 5.2 How much information it costs

Across 36 sites, the comparison after an action had a median size of **19 tokens** on the
sites that were quiet at rest, and 36 tokens counting all 36 sites. A screenshot of the
same viewport is about 1,365 tokens.

The first reading is a different story. On 30 of the 36 sites, the initial outline cost
more than a screenshot would have. A compact summary brought one Wikipedia page from
12.4 KB down to 3.4 KB, and the conclusion still holds: the advantage is in reporting
small changes, not in describing a large page for the first time.

The saved reference point is also not small in absolute terms. In the synthetic benchmark
it is about **3.3× the size of the serialized DOM** (`test/bench.test.js`). It is
designed to be cheap to *compare*, not cheap to store. Only the difference is small.

### 5.3 Noise on real sites

At rest, 18 of 36 sites produced no changes at all. The other 18 contained real motion —
carousels, tickers, auto-playing content. Known CSS animations are ignored automatically,
including when an animated container drags its children along.

Motion driven by JavaScript, and pages still loading content, can still produce changes
that are real but irrelevant to the task. So "nothing changed" is trustworthy under the
rules described here, but it is not a guarantee on an arbitrary page that has not been
allowed to settle.

### 5.4 Speed

The walk costs roughly the same per element as the page grows: between 14 and 83
microseconds per element, across synthetic pages of 282 to 23,000 elements and real pages
of 3,000 to 11,400. Wikipedia's Buenos Aires article (11,351 elements) took 275 ms.

The walk yields control back to the browser every 40 ms. Measured from inside the walk,
the longest slice was 41 ms in every case, including under a 4× CPU slowdown. Measured
from outside, by a separate timer in the extension, the longest block was 45–69 ms
normally and up to 100 ms under a 4× slowdown — an external probe also counts the work
the browser chose to run in between, so it is the more pessimistic and more honest
number.

One case is much worse than the rest: the same Wikipedia article, under a 4× slowdown,
with something mutating the page once per second, took 3.5 seconds of walk time, against
0.8 s without the mutation. The tab stays responsive because the slices still hold, but
the total is four times higher. On very large documents the practical answer is to read
one region instead of the whole page.

### 5.5 Working without CDP

A real Manifest V3 extension worked on 3 of 3 sites under their real Content Security
Policy, including GitHub. Its contract test passes 27 of 27 checks, covering the shape of
the reply, the main-thread budget under a 4× slowdown, occlusion, correctly reporting no
change, soft navigation in a single-page app, and five privacy checks
(`companion/gate.mjs`).

This is the situation the project exists for. Inside an extension or an embedded app,
Playwright and CDP are not available, while a script in the extension's isolated world
can read the page.

### 5.6 A small pilot with a model

Ten tasks, four ways of seeing the page, same model, one run each. Useful for spotting
patterns, not for claiming an advantage.

| Channel | Finished | Median steps |
|---|---:|---:|
| Native screenshot | 9/10 | 3.4 |
| This tool only | 8/10 | 3.3 |
| Native screenshot + this tool | **10/10** | 3.1 |
| snapDOM picture + this tool | **10/10** | **2.9** |

Using it alone lost information on one visual task. Combined with a picture it solved all
ten. That supports using both: structure to locate things and to verify, pixels for
appearance and for anything the tool admits it cannot read.

### 5.7 Our own task benchmark

Four arms, ten tasks, three repetitions. Tasks included extracting data, deep navigation,
search, a form, and one action that deliberately changes nothing. Fifteen actions maximum
per task.

| Arm | Passed per repetition | Wrong success reports | Median actions | p50 time | p95 time |
|---|---|---:|---:|---:|---:|
| Claude + this tool | 10/10 · 10/10 · 10/10 | 0 | 5 | 7.0 s | 29 s |
| Codex + this tool | 10/10 · 10/10 · 10/10 | 0 | 6 | 8.0 s | 25 s |
| Claude + its native extension | 10/10 · 10/10 · 10/10 | 0 | 3 | 22 s | 84 s |
| Codex + its native tools | 10/10 · 9/10 · 10/10 | 0 | 2 | 4.4 s | 61 s |

An independent judge approved 119 of 120 runs. The one that did not finish was a site
returning HTTP 403 to everything, and the agent said it had not finished, so it was not a
wrong success report.

**A 99% pass rate means the tasks were easy.** It does not mean the channel is better.
§5.9 is the measurement that shows this.

The timings are not a clean comparison. The four arms count different things: one script
execution that performs several operations counts as one action, while the extension
tended to do one operation per turn, and the runners include different amounts of
thinking time. Read the table as a description of four interfaces as they were actually
used.

### 5.8 Catching failures that look like successes

Eight actions were planted in a test page so that each one *appears* to work: a button
whose handler does nothing, a form rejected without a message, a click swallowed by an
invisible overlay, a notification that disappears before you look, a row inserted out of
view, a state change with no visual difference, a double submit, and a single-page
navigation that changes the URL without loading the content. The page also runs a clock,
a spinner and a ticker, which is what makes visual checks unreliable in the first place.
An independent function reads the real state and decides what actually happened.

| Channel | Right | **Wrong success reports** |
|---|---:|---:|
| **Stating the expected outcome and checking it** | **8/8** | **0** |
| Just asking "did anything change?" | 4–6/8 | 2–4 |
| `agent-browser` snapshot diff | 2/8 | 6 |
| Screenshot comparison | 2/8 | 6 |

The second row is a range because it is not stable between runs — it depends on what the
page's own noise happens to do at that moment. That instability is the finding. "Did
anything change?" is the wrong question on a live page. Stating what you expected and
checking that specific thing was stable at 8/8 across both runs.

This is why the useful unit is a stated expectation, not a raw difference.

### 5.9 Tasks written by other people

Eight tasks from Mind2Web-Live, on live sites, scored by someone else's criteria (the
"key nodes" of WebCanvas).

| Benchmark | Result |
|---|---:|
| Our own task suite (§5.7) | 99% |
| **Mind2Web-Live, this tool** | **28%** (8 of 29 key nodes) |
| Tasks completed end to end | 1 of 8 |

28% is where published work puts current web agents on live sites. The pattern in the
data: it reaches the right page almost every time, then loses the middle steps — filters,
multi-field forms, flows that need a login or earlier state.

The comparison arm ran out of API credit after 3 of the 8 tasks. On those 3, the
screenshot arm scored 5 of 8 key nodes against this tool's 3 of 8. Three tasks support no
conclusion whatsoever, but the direction is against the tool and is recorded for that
reason.

The honest statement: **this phase gives no evidence that reading structure instead of
pixels helps an agent finish more tasks.** The measured advantages are cost (§5.2) and
catching wrong success reports (§5.8).

### 5.10 Does a model choose it when nothing tells it to?

With both toolsets available, no instruction to prefer either, and six longer tasks, the
model chose this tool for 63 of 81 steps that used a channel at all (78%). It still used
pictures to orient itself. That supports offering both, not replacing one with the other
(`experiment/formal/results/b-preference.md`).

### 5.11 It runs inside other tools

The whole reader bundles to 45 KB and can be injected into `agent-browser` through that
tool's own `eval` command. Its flow keeps working, and the change report comes back on
top of it (`experiment/results/e5-coexistence.md`). Distribution is this project's
weakest point, so being able to run inside an existing tool matters more than competing
with it.

### 5.12 Do all the entry points agree?

There are five ways to use this (see the README). Eight cases from the corpus, plus one
occlusion case and one single-page navigation, were run through four of them. All four
gave the same answer every time, with the same change kinds and the same names, and none
contradicted the hand-written truth (`experiment/parity.mjs`).

Two caveats. The command-line tool and the MCP server are not independent — the second is
a thin translation of the first. And the corpus is the one the tool was developed
against, so this shows the entry points are consistent, not that they are correct on
pages nobody has seen.

### 5.13 Pointing at the right place

A separate experiment asked a narrower question on real pages: *give me the (x, y) you
would click for this goal.* A hit is the point landing inside the intended element. Three
regions, 6 goals, 2 repetitions, 12 answers per channel (`REGION.md`).

| Channel | Evidence | Hits | Confidently wrong |
|---|---|---:|---:|
| Full-resolution image | 17–406 KB | 8/12 | 4 |
| Image at quarter scale | 3–53 KB | 1/12 | 8 |
| **The list of clickable things** | **0.6–10.6 KB** | **12/12** | 2 |
| Quarter-scale image plus the list | 3.6–63 KB | 12/12 | 2 |

Two things worth keeping from it. Shrinking the image to save tokens destroys the task —
67% down to 8% — and it fails *confidently*, which is the failure an agent acts on. And
the list is the only channel that gives exact coordinates instead of an estimate.

**The uncomfortable number in that experiment**: the list cost 2,095 tokens against 781
for the full image. Images are charged by area, so a large screenshot can be cheaper in
tokens than the JSON describing it, even while being 25–38× larger in bytes. The honest
claim there is precision, not cost.

## 6. When the model using it makes a mistake

Models misuse tools. They write a broken specification, reuse an identifier from an old
reading, search for text that does not exist, or ask for a comparison without having
established a reference point first.

The rule here is that confusion must never come back green. An unknown field in a
specification, an empty specification and a missing reference point are all hard failures
with a stated reason. A target that is ambiguous or missing does not produce a
confirmation. Before acting, the tool repeats the role and name of the element it
resolved, so the caller can see what it is about to touch. If the target is off screen or
covered, it refuses and explains. In the misuse rounds that were run, no wrong success
report appeared, and recovery usually took one or two extra calls.

One risk remains: an old identifier from a previous reading could, in principle, match a
different element. Repeating role and name reduces that risk. It is not a guarantee.

## 7. What can be concluded

1. On a controlled set of cases, this tells application changes apart from visual noise
   better than the two baselines tested, and better out of the box than the closest
   comparable public tool.
2. Pictures and structure together are more complete than either alone. Pixels explain
   appearance. Structure explains identity, state, and whether you can click.
3. The most useful thing it does is confirm or deny that an action had an effect. Knowing
   that a click did nothing stops an agent from building on a false assumption.

What cannot be concluded: that it makes agents finish more tasks. §5.9 measured that
directly, on tasks written elsewhere, and found no such evidence.

## 8. Reasons to distrust these numbers

- The 19-case corpus and the 10-task suite were written by the same people who built the
  tool. The expected answers are published per case and the baselines are standard
  implementations, but this is not the same as an independent benchmark.
- The pilot in §5.6 is one run per cell.
- §5.7 is 10 tasks and 3 repetitions, and its 99% is explained by the tasks being easy.
- §5.9 is 8 tasks, one run, with the comparison arm incomplete.
- Live sites are not stable. Content, blocks, A/B tests and bot defenses change between
  runs.
- The four arms in §5.7 do not measure identical spans of time.
- The full text of a large page can cost more than an image. Use the compact summary, the
  search, and per-region readings.
- JavaScript-driven motion and pages still loading can produce real but irrelevant
  changes.
- Canvas and unreadable iframes need a picture or a specific integration.
- Repeatability is only claimed within one environment. No claim is made across browsers
  or engines.
- **The tests did not cover every way the tool ships.** On 2026-08-01 the globally
  installed copy was found broken: three of its verbs threw an error inside the page,
  because the bundle was defined twice and the two copies drifted apart. Every test ran
  against the repository tree, so nothing caught it. The duplication is gone and the
  tests now also run against the installed copy, but the lesson stands — a passing test
  suite only covers the paths it was pointed at.

## 9. What would improve this most

- Finish §5.9: run the comparison arm completely and widen the task set.
- Run a public benchmark end to end. The WebVoyager harness in `experiment/webvoyager/`
  is ready and verified without spending anything — 25 of 25 sites load, all four
  channels complete the loop — but no accuracy number of our own exists on it yet.
- Report cost per task *completed and verified*, rather than pass rate alone.
- Test the matcher against a public grounding benchmark. It works on our corpus; its
  behaviour on the long tail of professional interfaces is unknown.

## Appendix A. Reproducing this

Data lives in `experiment/results/` and `experiment/formal/results/`. Everything below
runs without an API key.

| What | Command from the repository root | Expected |
|---|---|---|
| Unit tests | `npx vitest run packages/agent/test --browser.headless` | 50 pass |
| Reading quality, no model | `npx vitest run packages/agent/experiment/signal.test.js --browser.headless` | 8 pass |
| Change detection (§5.1) | `node packages/agent/experiment/bench-qa.mjs` | 19/19, 0 false alarms |
| Comparable tool (§5.1) | `node packages/agent/experiment/e1-agent-browser.mjs` | 11/19 as-is, 17/19 normalized |
| Entry points agree (§5.12) | `node packages/agent/experiment/parity.mjs` | 0 disagreements |
| Extension contract (§5.5) | `node packages/agent/companion/gate.mjs` | 27/27 |
| Every verb, both installs | `node packages/agent/experiment/abis-verbs.mjs [--daemon <path>]` | 19/19 |
| Speed (§5.4) | `node packages/agent/experiment/scaling.mjs` | cost per element roughly flat |
| Real-site noise (§5.3) | `node packages/agent/experiment/sweep.mjs` | 18 of 36 quiet |
| Wrong success reports (§5.8) | `node packages/agent/experiment/c-false-green.mjs` | 8/8 and 0 for the stated-expectation arm |
| Verification demo | `node packages/agent/demo-qa/run-demo.mjs` | real change detected, no-op reported as no change |
| Public benchmark, dry run | `node packages/agent/experiment/webvoyager/run.mjs --dry --headless` | 25/25 sites load |

Paid: `experiment/formal/` (§5.7, §5.10), `experiment/formal/d-third-party.mjs` (§5.9),
and a real run of `experiment/webvoyager/run.mjs`.

## Appendix B. Where things are

- `src/` — the reader, identity matching, comparison, queries, privacy, and the plugin.
- `test/` — unit tests for the API, the corpus, performance and privacy.
- `corpus/` — pages, mutations and hand-written correct answers.
- `experiment/` — every runner, scoring script and comparison.
- `docs/adr/` — decisions, including the ones later proved wrong.
- `docs/PRIVACY.md` — exactly what text leaves the page.
- `docs/LANDSCAPE.md` — the surrounding field, including where this project is behind.
- `FIELD.md`, `EXPERIMENT.md`, `REGION.md` — full notes from the field passes and the
  experiments.
- `TESTPLAN.md` — what is tested, what is not, and what result would prove us wrong.
