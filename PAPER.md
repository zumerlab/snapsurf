# snapDOM Agent: checking whether a web agent's action actually did anything

Historical research draft, rewritten in English · 2026-08-01 · corrected 2026-08-12

> **Current status.** This document preserves internal measurements and the mistakes they
> exposed; it is not a current competitive claim. The earlier readings that SnapDOM had
> established superiority on false greens, cost, or browser-agent effectiveness are
> withdrawn. The `0 versus 6` experiment gave only one arm a case-specific postcondition,
> the token estimates do not define a current tokenizer or billing model, and the tested
> baselines are not a substitute for current Playwright Test or Playwright MCP. The active
> decision and equal-intent protocol are in `docs/VALUE-COMPARISON.md`.

## Summary

A program that uses a web page — clicking, typing, navigating — has to answer one
question after every step: *did that work?*

Some agent loops answer it only by looking again: they take another screenshot or fetch
the accessibility tree and let the model compare. That can fail on a page with a clock,
spinner, or carousel. Mature authored-test tools do more: Playwright Test has retrying
state, URL, value, CSS, screenshot, and ARIA assertions, while Playwright MCP's testing
capability exposes direct verification tools and interactions return a current
accessibility snapshot.

snapDOM Agent adds a second reading to snapDOM. It walks the page after the browser has
applied styles and computed layout, and records what it saw. Before an action you save a
reference point. After the action it walks again and compares the two. It tells you what
changed, in words a program can act on: something was added, removed, its text changed,
its state changed, its style changed, it moved, or it got bigger or smaller. It also
tells you which element, how confident it is that this is the same element as before, and
whether a control that used to be clickable is now covered by something else.

This is not a replacement for screenshots or Playwright. It is a candidate additional
source of information for one specific job: reporting a typed before/after effect and
explicit uncertainty on a page where unrelated content also changed. Whether that layer
adds enough value over current Playwright capabilities is still an open measurement.

What is measured, with the file that holds each number:

- On 19 hand-written test cases it got all 19 right, with no false alarms on the 8 noise
  cases (`experiment/results/bench-qa.md`).
- On 8 deliberately planted silent failures, checking a stated expectation produced 0
  wrong "it worked" answers. Generic change channels produced up to 6 each out of 8
  (`experiment/results/c-false-green.md`). This is evidence for explicit postconditions,
  not evidence that this implementation is more accurate than an equivalent Playwright
  assertion: the generic arms were not given the same intent.
- On tasks written by other people it completed 28% of the scoring steps — the same range
  everyone else is in. Our own task suite gave 99%, which means our tasks were easy
  (`experiment/formal/results/d-third-party.md`).
- Extracting contact details from real company sites, it reads a channel that text
  conversion can destroy — an email is often a `mailto:` in an attribute. One batch
  measured a 30-point difference on email; a later controlled sample did not reproduce
  it and found a site where the typed href names the wrong mailbox (§5.1b). It is a second
  channel, not a demonstrated advantage.

The third result is the important one to read first. This study did not show that the
tool makes an agent better at finishing tasks. Making failures more explicit remains the
product hypothesis, not an established comparative result.

## 1. The problem

There are three common ways to let a program see a web page, and each leaves a gap.

**A picture answers "what does it look like", not "what changed".** A button can go from
disabled to enabled without changing a single pixel. A clock can change hundreds of
pixels while the application state is identical.

**The accessibility tree describes structure, not appearance or stacking.** It does not
say that a font finished loading and re-flowed the text, and it does not say that a
dialog is now sitting on top of the Buy button.

**Some agent loops do not state or check a postcondition.** They act and move on. If the
click did nothing and the page had some motion in it anyway, the loop can mistakenly
infer progress. This is not a description of Playwright Test's assertion surface or of
Playwright MCP when its testing tools are enabled.

That last case has a name in this document: **a wrong success report**. The agent says
the action worked; an independent check of the application says it did not. Published
work outside this project measures this as a large share of all agent failures when
nothing verifies the agent independently, and a small share when something does. Those
numbers come from tool-use and coding benchmarks, not from browser agents, so treat them
as a reason to care, not as evidence about this tool (see `docs/LANDSCAPE.md` §2.3).

## 2. What it does

The core is a plugin for snapDOM and runs inside the page as ordinary JavaScript. That
embedded library does not require Chrome DevTools Protocol or launch a second browser;
the CLI and MCP modes do use Playwright Chromium. The in-page form can fit a Chrome
extension, an embedded copilot, or an Electron webview where launching another browser
or attaching CDP is unavailable.

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
- a reference point with no image or serialized DOM. It still contains readable
  accessible names, structure, masked state, geometry, and fingerprints, so it remains a
  sensitive artifact;
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

Raw values from `<input>`, `<textarea>`, and `<select>` are never serialized or returned.
Password, email, telephone, and other sensitive `autocomplete` categories store only
presence and a coarse length bucket, never a digest derived from the value. An edit that
stays within one bucket may therefore be missed, and the observation reports that region
as `unobservable` with `sourceType: "sensitive-input-value"`. Ordinary fields store a
capped bullet mask plus a deterministic value fingerprint for change detection; someone
holding the checkpoint could test guesses against that fingerprint.

Treat every persisted checkpoint as sensitive. It contains structural and state
evidence even when it contains no raw field values, and ordinary filled fields add the
guess-testable fingerprint described above.

You can also give it a list of literal strings to hide. Matching readable fields leave as
`[redacted]`, and asking whether a protected string exists is refused rather than
answered because the answer would confirm it. Daemon and MCP consumers receive only the
policy revision, the number of active rules, and `applied: true`; they do **not** receive
per-rule hit or match counts, which would create a presence oracle. Detailed operator
telemetry, where present, stays out of the consumer response. Screenshots are pixels and
are not covered by semantic redaction. Full detail is in `docs/PRIVACY.md`.

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

### 5.1 Internal change-detection corpus

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

The same 19 cases were also run through the then-current `agent-browser` snapshot diff.
As configured in this internal runner it scored 11/19,
because its element references are renumbered between readings and every reading
therefore looks different. After normalizing those references away it scores 17/19
(`experiment/results/e1-agent-browser.md`). The remaining distance is concentrated in
text noise and in changes with no textual representation — a real gap, but a much smaller
one than the comparison against pixels suggests.

These results describe fixed, self-authored fixtures and historical baseline
implementations. They are useful regression evidence. They are **not** a comparison with
current Playwright Test assertions or Playwright MCP and do not establish product
superiority.

### 5.1b Historical attribute-channel experiment

A historical run of 57 company sites across two batches, extracting business contact
details, suggested that an attribute channel might preserve evidence lost by text
conversion.

| Field being extracted | This tool vs a fetch-and-convert toolchain |
|---|---|
| Phone number | tie |
| Postal address | tie |
| **Email address** | **+30 points** |

The mechanism is structural. A phone number and an address are *text*: they survive being
turned into text, so a converter loses nothing. An email address on a contact page is
often **not** text — it is a `mailto:` in an `href`, and converting the page to text
destroys the typing that made it findable. The same holds for anything living in an
attribute rather than the prose: `tel:` links, canonical URLs, `datetime`, `value`, the
target of a button.

**A later controlled sample did not reproduce that difference, and one site inverts it.**
On six sites with ground truth frozen from raw HTML before either method ran, the two tied
3/3, and on the Free Software Foundation's contact page the `mailto:` href gives
`campaigns@fsf.org` while the visible text says to write to `info@fsf.org` — the typed
channel points at the *wrong* mailbox. On another, seven `mailto:` addresses in the raw
HTML are not anchors at all: they live in a CMS JSON payload, so the rendered DOM has no
`a[href^=mailto:]` and both methods correctly returned nothing.

So the defensible claim is weaker than the first batch suggested: the attribute channel is
a **second** channel, not a superior one. It carries data that text conversion destroys,
and it can also carry a different — sometimes wrong — value than the page tells a human to
use. Read both; do not treat the href as the source of truth.

Two caveats from the same run. Any difference only materialises if the consumer reads the
typed fields rather than the rendered prose — the run that produced these numbers had to
be corrected first, because the fields existed but were not being published where a
programmatic client looks (§8, last bullet). And an empty form field's accessible name is
its placeholder, so `john@company.com` can appear in a digest looking exactly like a real
address; those entries are now flagged rather than left to be mistaken for data.

### 5.2 Historical information-size estimates

Across 36 sites, the comparison after an action had a median size of **19 tokens** on the
sites that were quiet at rest, and 36 tokens counting all 36 sites. A screenshot of the
same viewport is about 1,365 tokens.

Those token figures are retained as historical observations, not a current cost claim.
The run did not freeze a tokenizer and billing model that can support a present-day
comparison. New evaluations report exact UTF-8 bytes, tool calls, model rounds, and
timing boundaries; they convert to tokens or money only when the tokenizer and price are
specified.

The first reading is a different story. On 30 of the 36 sites, the initial outline cost
more than a screenshot would have. A compact summary brought one Wikipedia page from
12.4 KB down to 3.4 KB, and the conclusion still holds: the advantage is in reporting
small changes, not in describing a large page for the first time.

The saved reference point is also not small in absolute terms. The current columnar
checkpoint gate measures roughly **1.9× the size of the serialized DOM** on its synthetic
fixtures (`test/bench.test.js`), with explicit per-node budgets. It is designed to be
cheap to *compare*, not necessarily smaller than DOM serialization. Only the returned
difference is small.

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

A historical Manifest V3 run worked on 3 of 3 sites under their then-current Content
Security Policy, including GitHub. The checked-in contract gate covers reply shape,
main-thread budget under slowdown, occlusion, correctly reporting no change, soft
navigation, and privacy behavior (`companion/gate.mjs`). Run the gate for its current
case total rather than copying an old count.

This is one deployment shape the project targets. An extension content reader can run in
an isolated world without attaching Playwright or CDP to that component. That is a
deployment distinction, not evidence that it verifies effects better than a
Playwright-controlled browser.

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

This experiment does **not** establish superiority over Playwright Test. The
stated-expectation arm received per-case postconditions; the comparison arms answered the
weaker question "did anything change?". A fair comparison must give Playwright the same
postcondition through its retrying assertions (and, where needed, custom predicates).
The preregistered comparison and first descriptive focal are recorded in
`docs/VALUE-COMPARISON.md`.

### 5.8a Current local MCP-to-MCP probe

A later hermetic runner compared current Playwright MCP 0.0.79 with `--caps=testing`
against SnapDOM MCP 0.1.0 on four deterministic local postconditions. Each ran as a
correct effect and a near miss, three times, through three separately reported arms:
Playwright out-of-box tools, SnapDOM's direct assertion, and Playwright's arbitrary
`browser_evaluate` escape hatch. There was no model. The expected verdict came from a
frozen server-side manifest activated by an action ping; it did not observe the DOM.

All three arms matched that manifest in 24/24 trials: 72/72 route trials total, with no
false green, false negative, or `UNKNOWN`. These are repeated authored fixtures, not 72
independent cases and not an estimate of general accuracy.

| Arm (same 24 trials) | Median verify rounds | Median full-flow rounds | Median verify effective B | Median full-flow effective B | Median verify ms | Median full-flow ms |
|---|---:|---:|---:|---:|---:|---:|
| Playwright out of box | 1.5 | 3.5 | 558.5 | 2,557.5 | 5.6 | 195.1 |
| SnapDOM direct assertion | 1 | 3 | 2,660 | 5,288 | 17.0 | 556.9 |
| Playwright custom evaluation | 1 | 3 | 1,206 | 3,330.5 | 55.5 | 252.0 |

SnapDOM's observed value was a uniform one-call declarative vocabulary for transition,
side-effect, coverage, and no-op checks with typed evidence. It was not a general cost
win: Playwright out-of-box was much smaller in the pooled medians and used no extra
verification call for semantic no-op. The covered-modal near miss was the opposite
endpoint: SnapDOM's direct assertion took one round and 19.8 ms, while Playwright's
built-in non-mutating hover actionability probe took two rounds and 1,214.4 ms; custom
hit testing took one authored-JavaScript round and 54.7 ms. Branch short-circuiting is
reported per case rather than hidden: Playwright's two-conjunct checkbox and add routes
used two verification calls on success and one when the first near-miss conjunct failed.

Full flow includes setup/navigation, action, verification, and linked-artifact reads; it
excludes npm/browser installation, MCP startup, and expected-truth polling. Timings are
descriptive local medians, not a causal performance estimate. The schema cost was 14,418
B for SnapDOM and 22,271 B for Playwright including the initialized notification, but a
client loading SnapDOM alongside Playwright pays both. The raw wires, per-case table,
cleanup record, and exact protocol are in `experiment/results/mcp-value.json`,
`experiment/results/mcp-value.md`, and `experiment/mcp-value.mjs`.

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
pixels helps an agent finish more tasks.** The historical size observations (§5.2) and
false-green fixture (§5.8) motivate further testing, but neither is a current
equal-intent advantage claim.

### 5.10 Does a model choose it when nothing tells it to?

With both toolsets available, no instruction to prefer either, and six longer tasks, the
model chose this tool for 63 of 81 steps that used a channel at all (78%). It still used
pictures to orient itself. That supports offering both, not replacing one with the other
(`experiment/formal/results/b-preference.md`).

### 5.11 It runs inside other tools

A historical reader build bundled to 45 KB and was injected into `agent-browser`
through that tool's own `eval` command. Its flow worked and the change report came back
on top of it (`experiment/results/e5-coexistence.md`). That dated size is not the current
companion bundle size; the durable result is architectural coexistence, not 45 KB.

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

As in §5.2, those token totals are historical because the tokenizer and billing model
were not frozen for a current comparison. They must not be reused as present-day model
cost claims.

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

1. On the self-authored corpus, the implementation produced the frozen expected answers
   and distinguished the tested semantic effects from the tested noise cases. That makes
   the corpus useful as a regression suite, not as independent competitive evidence.
2. The implementation can return typed before/after changes, coverage evidence, and
   explicit `torn` or `unobservable` uncertainty in one response. That is a real product
   surface. The local MCP probe established a narrower ergonomic distinction—one uniform
   declarative verification call across four effects—but not an accuracy, byte, latency,
   diagnostic, or agent-success advantage over Playwright.
3. Pixels and semantics answer different questions. A verifier may need both, especially
   for appearance, canvas, and unreadable frame content.

What cannot be concluded: that SnapDOM is more accurate, faster, cheaper, or more
effective than current Playwright Test or Playwright MCP, or that it makes agents finish
more tasks. A broader claim still requires the powered, equal-intent, independently
judged protocol in `docs/VALUE-COMPARISON.md`; the four-case local probe is not that
confirmatory run.

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
- **A capability that is not read is not a capability.** The typed fields that produce the
  historical §5.1b difference existed for a long time before they were published where a
  programmatic consumer looks, and the first production report of them concluded the tool
  could not read a page at all. Measured effects depend on the consumer being able to
  reach them.
- **The tests did not cover every way the tool ships.** On 2026-08-01 the globally
  installed copy was found broken: three of its verbs threw an error inside the page,
  because the bundle was defined twice and the two copies drifted apart. Every test ran
  against the repository tree, so nothing caught it. The duplication is gone and the
  repository now includes a task-owned installed-copy smoke check; the real user-level
  `~/.claude` copy remains an explicit machine-state test. The lesson stands — a passing
  suite covers only the paths it was pointed at.

## 9. What would improve this most

- Finish §5.9: run the comparison arm completely and widen the task set.
- Run a public benchmark end to end. The WebVoyager harness in `experiment/webvoyager/`
  has a dry-run path, but no current accuracy result is claimed here.
- Report cost per task *completed and verified*, rather than pass rate alone.
- Test the matcher against a public grounding benchmark. It works on our corpus; its
  behaviour on the long tail of professional interfaces is unknown.

## Appendix A. Reproducing this

Data lives in `experiment/results/` and `experiment/formal/results/`. Run these commands
from this repository root. The runners print their current totals; this table deliberately
does not copy pass counts that can become stale.

| What | Repository-root command | Contract |
|---|---|---|
| Core plus daemon/MCP regressions | `npm test` | exits nonzero on a failed check |
| Lint and bundle freshness | `npm run test:lint && npm run test:bundles` | exits nonzero on lint or generated-bundle drift |
| Isolated offline regression set | `npm run test:regression` | uses task-owned isolated runtime state |
| Adversarial experiment | `npm run test:adversarial` | runs through the isolated wrapper |
| Companion boundary | `node companion/gate.mjs` | exercises the fixed-id hostile-page fixture |
| Package artifact | `npm run test:pack` | checks the generated package, not only the checkout |
| Cold install | `npm run test:cold` | copies **git-tracked files only** into empty task-owned locations |
| Change corpus (§5.1) | `node experiment/bench-qa.mjs` | evaluates the checked-in fixture truth |
| Historical baseline (§5.1) | `node experiment/e1-agent-browser.mjs` | descriptive historical runner; not current Playwright |
| Entry-point parity (§5.12) | `node experiment/parity.mjs` | reports disagreements rather than assuming parity |
| Daemon verbs | `node experiment/abis-verbs.mjs [--daemon <path>]` | optional path checks a specified daemon copy |
| Historical false-green fixture (§5.8) | `node experiment/c-false-green.mjs` | internal asymmetric experiment, not a Playwright comparison |
| Current MCP protocol (§5.8a) | `node experiment/mcp-value.mjs --dry` | prints pinned cases, routes, metrics, and isolation contract without launching a browser |
| Current MCP local run (§5.8a) | `MCP_VALUE_REPETITIONS=3 MCP_VALUE_REQUIRE_ALL_CORRECT=1 MCP_VALUE_OUTPUT=work/mcp-value.json node experiment/mcp-value.mjs --run` | resolves Chromium for Testing through the pinned MCP package into temporary task state, runs only localhost fixtures, and refuses publication on verdict or cleanup failure |
| Current focal protocol, no network | `node experiment/value-focal.mjs --dry` | prints the protocol and isolation contract; no benchmark result |

Some historical runners require network access, an external tool installation, or a paid
model even though they require no browser profile. Their stored observations must not be
silently replaced with a new run. In particular, the schema-2 focal requires the explicit
`--network` flag and does not reproduce the historical schema-1 measurements.
The MCP local run also needs network access to acquire the pinned package and browser;
its measured fixture traffic remains localhost-only and it does not use a personal
browser profile.

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
