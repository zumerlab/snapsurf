# Value comparison: SnapDOM and current Playwright

Status: decision memo, not a product claim
Evidence cutoff: 2026-08-12 UTC

## Decision

Treat SnapDOM as an experimental verification and evidence layer, not as a replacement
for Playwright.

For authored tests, Playwright Test is the default. It already has auto-retrying locator
assertions, ARIA snapshots, visual comparisons, and actionability checks. SnapDOM is worth
adding only if a paired evaluation shows that its before/after change vocabulary or its
explicit uncertainty produces a material accuracy, diagnostic, or MCP-efficiency gain.

For agentic use, a first local deterministic comparison now covers SnapDOM MCP against
Playwright MCP with the testing capability enabled. It establishes the direct expression
and protocol cost of four authored effects, not agent performance. Playwright MCP already
provides direct verification tools and returns a new accessibility snapshot after page
interactions. A comparison that treats it as a screenshot-only agent, or denies it those
tools, is not current or fair.

The evidence presently supports four narrow statements:

1. SnapDOM can express typed before/after constraints in one assertion request.
2. One historical focal and five aligned schema-2 repetitions showed that both
   Playwright Test and SnapDOM can verify the six selected successful effects under the
   authored predicates.
3. SnapDOM automatically returns more structured success evidence, but that evidence is
   not automatically cheaper or more accurate.
4. In a 72-trial local MCP probe, all routes matched the frozen expected-truth manifest.
   SnapDOM used one uniform declarative verification round; Playwright used zero to two
   out-of-box rounds depending on the effect, or one arbitrary-evaluation round.

It does **not** show a general accuracy, latency, byte, or model-round advantage. In the
local probe, Playwright was usually smaller; the endpoint-specific round and latency
winner differed between modal coverage and no-op.

## Current capability baseline

This table describes direct, documented product surfaces. It does not claim that a
capability is impossible to implement with custom Playwright code.

| Concern | Playwright Test API | Playwright MCP | SnapDOM |
|---|---|---|---|
| Targeted current-state checks | Broad auto-retrying locator and page assertions, including text, count, value, checked, enabled, URL, CSS, JS properties, screenshots, and ARIA snapshots | With `--caps=testing`: direct checks for visible elements, visible text, visible lists, and values | `exists`, URL checks, readable state and typed diff matchers |
| Before/after effect | No built-in typed semantic diff; compose preconditions and postconditions, compare snapshots, or write a helper | Actions return a fresh accessibility snapshot; the model/client compares snapshots, or calls a direct verify tool | Baseline plus `changed`, `mustInclude`, `mustNotInclude`, `only`, and `maxChanges` |
| Identity and change kinds | Locators provide target identity; transition classification is authored by the test | Snapshot refs identify interactive elements within the current page state, but the documented response is not a typed cross-snapshot diff | Node identity and diff matching plus added, removed, state, text, moved, resized, visibility, and coverage changes |
| Negative checks under incomplete observation | Exact locators and custom code can be used; completeness is the test author's responsibility | Direct verify tools cover a narrower current-state surface; otherwise the client judges the snapshot or evaluates code | Negative diff checks fail closed with an uncertainty marker when the observation is torn or reports unobservable regions |
| Occlusion/actionability | Actions check visibility, stability, event reception, and enabled state; `trial` actions and custom hit testing can probe actionability | Interactions inherit Playwright actionability; no documented `notCovered` verification tool | `notCovered`, `becameVisible`, and `becameCovered` are assertion fields |
| Success evidence | Assertions are normally quiet on success; ARIA, screenshot, trace, or custom evidence is explicit | Interaction results include structured accessibility snapshots; verify tools return a direct result | Success and failure envelopes include checks and bounded diff evidence |
| Failure evidence | Rich assertion errors and optional trace/screenshot/ARIA evidence | Verify failure plus the current snapshot; additional evidence can require another tool call | Structured failed checks, relevant changes, and uncertainty in the same envelope |
| Action surface | Mature locators and actionability are the strongest of these three surfaces | Snapshot refs and Playwright actions; vision is available for inaccessible controls | Semantic find/observation IDs plus coordinate fallback; dogfood exposed and regression-tested ranking, unnamed-control, scoped-ID, and stale-target bugs |
| Expected default | Best choice for deterministic authored tests | Current baseline for Playwright-based browser agents | Optional layer whose incremental value still has to clear the gates below |

Official Playwright references: [Test assertions][pw-assertions],
[actionability][pw-actionability], [ARIA snapshots][pw-aria],
[visual comparisons][pw-visual], [MCP testing and assertions][pwmcp-assertions], and
[MCP accessibility snapshots][pwmcp-snapshots].

## Local MCP-to-MCP probe: what was observed

The current [runner][mcp-value-runner], [raw result][mcp-value-result], and [generated
report][mcp-value-report] compare Playwright MCP 0.0.79 (server-reported Playwright
1.63.0-alpha-2026-08-05) with SnapDOM MCP 0.1.0. There is no model. Four local effects
run as both the intended result and a deterministic near miss, three times per route:
target versus neighboring checkbox, exact requested versus distractor addition, clear
versus covered modal control, and semantic no-op versus unrelated text mutation.

The “oracle” is a frozen server-side expected-truth manifest activated by an action ping;
it does not inspect the DOM. Each route receives the same postcondition. Playwright is
reported in two separate lanes: out-of-box tools and arbitrary `browser_evaluate` code.
Its automatic snapshots are linked YAML artifacts in this pinned version; the runner
validates each path under the temporary output root, hashes and reads it mechanically,
and counts those bytes separately and in an effective total.

All 72 route trials matched the manifest: 0 false greens, 0 false negatives, and 0
`UNKNOWN`. That is equal correctness on four authored fixtures, not an accuracy-rate
estimate. Each row below summarizes the same 24-trial set. “Effective bytes” are exact
JSON-RPC request + response bytes plus linked artifact bytes; they are not token
estimates. Full flow starts with navigation/open and includes setup, action,
verification, and client-side artifact reads. It excludes package/browser installation,
MCP startup, and expected-truth polling.

| Arm (24 trials each) | Correct | Verify rounds, median | Action + verify rounds, median | Full-flow rounds, median | Verify effective B, median | Action + verify effective B, median | Full-flow effective B, median | Verify ms, median | Full-flow ms, median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Playwright out of box | 24/24 | 1.5 | 2.5 | 3.5 | 558.5 | 1,497.5 | 2,557.5 | 5.6 | 195.1 |
| SnapDOM direct `browser_assert` | 24/24 | 1 | 2 | 3 | 2,660 | 3,359 | 5,288 | 17.0 | 556.9 |
| Playwright custom `browser_evaluate` | 24/24 | 1 | 2 | 3 | 1,206 | 2,037.5 | 3,330.5 | 55.5 | 252.0 |

The medians do not hide short-circuit behavior: Playwright's checkbox and exact-add
routes used two verification calls for the correct variant and one when the first
conjunct failed in the near miss. The modal route used two for both variants; automatic
no-op snapshot comparison used zero. SnapDOM direct and Playwright custom evaluation
used one verification call for both variants in all four cases. The generated report
contains the full case-by-arm table, including correct/near-miss rounds and full-flow
costs.

The pooled medians hide the useful product distinction:

- SnapDOM expresses every selected postcondition in one uniform declarative assertion
  request with typed before/after evidence. Playwright out of the box needed zero to two
  post-action rounds; custom evaluation needed one round but required authored JavaScript.
- Playwright out-of-box payloads were usually much smaller. Custom evaluation was also
  smaller in this fixture, but it is an escape hatch rather than a direct assertion
  vocabulary.
- On the covered-modal near miss, SnapDOM used one assertion at 19.8 ms and 3,384 verify
  bytes. Playwright's built-in hover actionability probe used two rounds at 1,214.4 ms
  and 2,286 effective verify bytes. Custom hit testing used one round at 54.7 ms and
  1,860 bytes. Full-flow medians were 554.7, 1,386.2, and 243.6 ms respectively; these
  tiny local samples are descriptive, not a population latency estimate.
- On semantic no-op, Playwright mechanically compared snapshots already returned by the
  navigation and action: zero additional MCP rounds and 751–770 effective action-plus-
  verification bytes. SnapDOM used one assertion round and 1,669–1,911 bytes. In full
  flow, Playwright used 1,633–1,664 B versus SnapDOM's 3,375–3,621 B; Playwright custom
  evaluation used an additional baseline setup call for this case.

Cold initialize plus `tools/list`, including the initialized notification, was 14,418 B
for SnapDOM's 13 tools and 22,271 B for Playwright's 29 tools. This is not a stack-level
saving: SnapDOM currently rides alongside Playwright, so a client loading both pays both
schema costs.

The isolation and cleanup gates passed. The fixture was localhost-only; Chromium for
Testing was resolved by the pinned Playwright MCP package, installed into the task's
temporary root, and run with `--browser=chromium --headless --isolated`; SnapDOM used fresh contexts and
OS-assigned daemon ports explicitly excluding 8377. All MCP processes exited cleanly,
the fixture and daemon ports closed, and the temporary root deletion was verified. No
personal Chrome profile, tab, cookie, session, history, password, or extension was
accessed.

This probe supports a real but narrower value statement: SnapDOM packages typed
transition, side-effect, coverage, and no-op intent into a stable one-call assertion
surface. It does not support “SnapDOM is more accurate,” “SnapDOM is cheaper,” or
“SnapDOM replaces Playwright.” The confirmatory multi-site protocol below remains the
decision test.

## Six-effect focal: what was observed

There is one historical schema-1 observation and five aligned schema-2 observations over
six successful effects on The Internet and Bootstrap: remove, add, enable state, open
modal, delayed content, and no-op. Each compared direct Playwright Test API with the
SnapDOM authenticated daemon; none ran Playwright MCP. Each arm passed 6/6 in schema 1
and 30/30 across schema 2 under the authored predicates. Navigation and runtime
installation were excluded from the timers.

### Schema 2: aligned observation

The [schema-2 raw observation][focal-result-v2] was produced by the current [focal
runner][focal-runner]. Setup, baseline, and precondition work is outside both timers;
target lookup, action, and aligned postconditions are inside. Both arms used Playwright
1.55.1 and Chromium 140.0.7339.186 in fresh isolated contexts.

| Effect | Playwright | SnapDOM | PW setup ms | SD setup ms | PW action-to-verdict ms | SD action-to-verdict ms |
|---|---|---|---:|---:|---:|---:|
| remove | pass | pass | 11.6 | 6.3 | 3,925.2 | 3,123.4 |
| add | pass | pass | 2.6 | 2.0 | 3,895.8 | 3,056.0 |
| enable state | pass | pass | 3.7 | 2.4 | 3,884.5 | 3,043.1 |
| modal | pass | pass | 9.4 | 8.4 | 417.5 | 450.7 |
| delayed content | pass | pass | 7.6 | 4.7 | 5,906.7 | 5,028.3 |
| no-op | pass | pass | 6.1 | 0.0 | 306.3 | 316.9 |
| **Total** | **6/6** | **6/6** | **41.0** | **23.8** | **18,336.0** | **15,018.4** |

On success, Playwright assertions automatically serialized no semantic evidence; the
additional explicit ARIA reads totaled 1,380 B. SnapDOM's full authenticated success
envelopes totaled 17,986 B, including 15,632 B of structured assertions. Controlled
failure diagnostics totaled 10,508 B for Playwright and 3,324 B for SnapDOM.

These are different observation surfaces and evidence contracts. Playwright success
evidence here is an explicitly requested scoped ARIA snapshot; SnapDOM returns baseline
metadata, checks, and typed diff evidence. Playwright locators and sequential assertions
auto-retry within their own boundaries. SnapDOM used one assertion request per case and
internally observed `[25, 25, 25, 1, 42, 1]` attempts. Its no-op observation also covers
supported state, style, and layout signals beyond Playwright's body ARIA comparison.
Consequently, raw time, bytes, and caller-visible call counts are descriptive and do not
support a causal speed or efficiency claim.

The first schema-2 attempt exposed a real contract bug: the disabled textbox became
enabled and the state diff existed, but `to: { disabled: false }` was absent because the
snapshot encodes `disabled` only when true. Diff evidence was fixed to materialize the
missing `false` endpoint only for presence-encoded `disabled` and `hasValue`; ARIA states
such as `expanded` remain absent rather than being coerced to false. The complete exact
rerun then passed 6/6 in both arms. The failed raw attempt remains in the local `work/`
area for diagnosis and is not published or counted as comparative evidence.

Four immediate exact repetitions also passed 6/6 per arm. Across all five schema-2
observations, the median six-effect action-to-verdict sum was 18,344.9 ms for Playwright
and 15,022.3 ms for SnapDOM, with observed ranges 18,336.0–18,363.1 ms and
14,991.2–15,618.9 ms. Median evidence sizes were unchanged: 1,380 B for Playwright's
explicit ARIA reads, 17,986/15,632 B for SnapDOM full/structured success, and
10,508/3,324 B for Playwright/SnapDOM controlled failures. The additional raw files are
[rep2][focal-result-v2-rep2], [rep3][focal-result-v2-rep3],
[rep4][focal-result-v2-rep4], and [rep5][focal-result-v2-rep5].

These five sequential observations add narrow stability data, but still lack randomized
arm order, controlled near misses, an independent hidden oracle, and independent case
diversity. The median raw SnapDOM time sum being 18.1% lower is not evidence that SnapDOM
is faster because the retry and observation surfaces differ.

### Schema 1: historical observation

The [schema-1 raw observation][focal-result] preserves the historical cases, exact APIs,
versions, measurements, isolation, and cleanup status. Its timers and some outcome
conjuncts were asymmetric, so it remains evidence of what happened in that run rather
than a benchmark result.

Both arms passed all six intended effects.

| Effect | Playwright ms | SnapDOM ms | Playwright explicit ARIA evidence, B | SnapDOM full / structured success, B | Playwright / SnapDOM controlled-failure evidence, B |
|---|---:|---:|---:|---:|---:|
| remove | 3,558.8 | 3,035.9 | 52 | 3,309 / 2,913 | 1,269 / 553 |
| add | 3,359.5 | 3,094.9 | 87 | 3,461 / 3,067 | 893 / 553 |
| enable state | 3,325.2 | 3,083.3 | 101 | 4,238 / 3,842 | 1,065 / 553 |
| modal | 225.7 | 451.7 | 212 | 4,266 / 3,750 | 1,632 / 553 |
| delayed content | 5,375.1 | 5,055.1 | 47 | 2,086 / 1,684 | 1,027 / 556 |
| no-op | 311.1 | 314.9 | 881 | 526 / 304 | 3,811 / 556 |
| **Total** | **16,155.4** | **15,035.8** | **1,380** | **17,886 / 15,560** | **9,697 / 3,324** |

Caller-side verification in the historical schema-1 run used 15 Playwright outcome
locators, 17 Playwright assertions, and 6 explicit evidence reads. The SnapDOM side used 5 semantic
finds and 6 assertion calls containing 17 checks. SnapDOM retried those calls internally
for `[24, 25, 25, 1, 42, 1]` attempts, so fewer caller-visible operations do not imply
less browser work.

Descriptively:

- both arms were 6/6 on successful effects;
- the raw SnapDOM time sum was 6.9% lower;
- the SnapDOM full success envelopes were 12.96 times the bytes of the scoped explicit
  Playwright ARIA evidence; even the structured assertion subsets were 11.28 times as
  large;
- the controlled SnapDOM failure envelopes were 65.7% smaller than the captured
  Playwright failure diagnostics.

None of those differences is an estimate of a population effect. The focal has material
limitations:

- it is one run, with no variance, randomization, near-miss trials, or independent hidden
  oracle;
- every intended effect succeeded, so it cannot measure false-green rate;
- the arms shared effect intent but did not encode every conjunct identically. For
  example, the add case checked the `It's back!` message in Playwright and `A checkbox`
  plus a typed addition in SnapDOM;
- Playwright used explicit preconditions and postconditions, while SnapDOM used an earlier
  baseline plus diff checks;
- the SnapDOM timer excluded its semantic find, while the Playwright timer included its
  precondition assertions; the explicit Playwright ARIA evidence read happened after its
  timer, while SnapDOM serialized success evidence inside the assertion response;
- success-byte payloads differ in information content: a scoped ARIA snapshot is not the
  same artifact as a full typed change envelope;
- the intentionally failing predicates used to size diagnostics were controlled probes,
  not matched real failures;
- Playwright Test 1.62.1 used Chromium 151 from an empty temporary browser store, while
  SnapDOM 0.1.0 used its internally pinned Playwright 1.55.1 runtime;
- the pages were public live sites, so server timing and content can drift.

Accordingly, the focal supports “both approaches worked here” and “their evidence shapes
differ.” It does not support “SnapDOM is faster,” “SnapDOM is smaller,” or “SnapDOM is
more correct.”

## Correction to the previous false-green headline

The historical [false-green experiment][old-fg-runner] and
[raw result][old-fg-result] remain in the repository. It reported 0/8 false greens for a
case-specific SnapDOM postcondition, versus 4/8 for a generic SnapDOM “did anything
change?” check and 6/8 for normalized accessibility-tree and pixel-change arms.

That result is useful evidence for one statement: **a specific postcondition is safer
than generic change detection on those authored fixtures.** It is not evidence that
SnapDOM beats Playwright.

The comparison was asymmetric. The winning arm received case-specific intent, while the
other arms were effectively asked whether anything changed. It also did not compare
against current Playwright Test assertions or Playwright MCP's testing tools. Therefore:

- retain the result and its history;
- do not reuse `0/8` as a competitive headline;
- describe it as a motivating within-project experiment;
- replace it with the equal-intent protocol below before making any comparative claim.

## Preregistered comparison required for a product decision

### Separate the two questions

Run two paired strata and never combine their “round” metrics:

1. **Authored verifier:** Playwright Test versus SnapDOM core on Playwright-owned isolated
   pages. A common harness performs the exact same action in cloned contexts. This asks
   whether the SnapDOM verifier adds value over authored Playwright assertions.
2. **Agentic product:** Playwright MCP versus SnapDOM MCP, using the same model, prompt,
   tool policy, initial state, and deadline. Playwright MCP runs with `--caps=testing`.
   This asks whether the evidence shape changes agent rounds, bytes, or verdict quality.

The MCP arm may use official verify tools, accessibility snapshots, screenshots, or
generic evaluation. Record which route it used. Generic evaluation is not prohibited;
it is classified as custom implementation rather than direct evidence.

All runs use isolated Chromium contexts, empty temporary profiles and output directories,
and OS-assigned ports. They must not connect to a personal browser, profile, tab, cookie
store, session, history, password store, or extension.

### Equal intent

Freeze one neutral postcondition manifest per case before implementing either arm:

```json
{
  "action": "complete todo U",
  "postcondition": {
    "all": [
      "todo U changed from incomplete to complete",
      "no other todo changed completion state"
    ],
    "deadlineMs": 10000
  },
  "nearMiss": "a neighboring todo completes instead",
  "oracle": ["application state", "primitive DOM state", "screenshot"]
}
```

Two reviewers approve a mechanical translation for every arm. A generic `changed: true`
cannot replace a target-specific effect. “Something similar exists” cannot replace exact
identity. If a conjunct cannot be expressed directly, the arm must spend an additional
probe, use custom code, or return `UNKNOWN`; the expectation is never weakened.

### Case matrix

The cases are derived from the completed TodoMVC, SauceDemo, The Internet, and Bootstrap
dogfoods. Each runs once as a real success and once as a deterministic near miss.

Those dogfoods are case-selection evidence, not comparative benchmark observations. In
particular, the SauceDemo exploration ended with both SnapDOM checks and a neutral
Playwright ground-truth pass, while TodoMVC exposed action-resolution bugs that were
subsequently fixed and regression-tested; its large diffs also contained layout noise.
Durable raw transcripts were not preserved for every external run, so none receives
accuracy or performance credit in this comparison.

| ID | Intended effect | Near miss that must fail |
|---|---|---|
| T1 | Create exactly one uniquely named todo; count increases by one | Input/footer changes, but the todo is not created |
| T2 | Unique todo changes incomplete to complete; no neighbor changes | A neighboring todo completes |
| T3 | Active route is `#/active`; active item visible and completed item absent | Hash changes but the list does not filter |
| T4 | Delete the unique todo; count decreases by one; no other label is removed | A neighboring todo is removed |
| S1 | Login reaches inventory; product list exists; login form is absent | The page changes or shows an error without reaching inventory |
| S2 | Add Backpack; that button changes to Remove; cart count changes 0 to 1 | A different product is added and the badge still says 1 |
| S3 | Remove Backpack; its row and the badge are absent; cart is empty | A different product is removed and Backpack remains |
| I1 | Remove dynamic checkbox; Add button and `It's gone!` appear | Message/button change but the checkbox remains |
| I2 | Textbox changes disabled to enabled; Disable button and message appear | Message appears while the textbox remains disabled |
| I3 | `Hello World!` is added and visible; loading indicator is absent | Spinner disappears without the target content |
| B1 | Modal becomes a visible dialog; Close is actionable; launcher is covered | Dialog renders but an overlay covers its controls |
| B2 | Modal and backdrop disappear; launcher is actionable again | Dialog hides but the backdrop still intercepts events |

The primary controlled run should use frozen upstream assets or versioned replicas so the
near misses can be planted deterministically. A smaller live-site transfer run checks
that the conclusion is not solely a fixture artifact. Live-site results are reported
separately and never substituted for the controlled truth variants.

### Independent truth and outcomes

A sealed oracle adapter, not visible to either verifier, records application state where
available, primitive DOM properties, URL, hit testing, mutation timing, and a neutral
screenshot. It is authored and frozen before the arm translations. If its independent
channels disagree, the trial is `ORACLE_UNKNOWN` and is excluded from comparative
accuracy rather than awarded to either arm.

Each verifier returns exactly one of `PASS`, `FAIL`, or `UNKNOWN` plus its evidence.
`UNKNOWN` is never counted as correct. A false green is verifier `PASS` when the oracle is
`FAIL`.

The proposed 12 cases x 2 truth variants x 10 repetitions per arm, plus 20 explicit
torn/unobservable safety trials, is a **pilot allocation**, not a powered confirmatory
sample. Even treating all 20 clean safety trials as independent, they would still have a
13.9% one-sided exact 95% upper bound on the failure rate. Randomize arm order within
case blocks and pair each arm on case, truth variant, seed, and attempt. Repetitions
measure flake; they are not independent cases, and four sites are coverage strata rather
than enough site clusters for inference.

Before a separate confirmatory run, freeze a simulation-based power calculation using
pilot event rates and within-case dependence. It must target at least 80% power at
one-sided alpha 0.05 for non-inferiority and two-sided alpha 0.05 for superiority, and
set the case, site, repetition, safety-trial, and reviewer-packet counts. Pilot outcomes
are excluded from the confirmatory analysis. Every numerical margin below is a candidate
until that calculation is frozen; the current allocation is not claimed to attain its
precision.

For binary verifier outcomes, the primary estimate is the paired risk difference. Its
confidence interval uses a preregistered case-cluster bootstrap (10,000 replicates,
fixed seed), resampling whole cases within site and retaining every paired truth variant
and repetition. Exact McNemar inference on discordant matched trials is a sensitivity
analysis, not a substitute for clustering. A comparative accuracy gate is unevaluable
with fewer than 20 discordant pairs, fewer than 10 false-green events across both arms,
or events spanning fewer than six cases and three sites. These are minimum
analyzability floors, not a power guarantee.

### Metrics

Primary correctness metrics:

- false-green rate;
- false-negative rate;
- `UNKNOWN` rate;
- safe completion rate, with `UNKNOWN` in the denominator.

Efficiency metrics, calculated both for all trials and for correct trials only:

- verification-only and end-to-end wall time, p50 and p95;
- MCP tool round-trips after the action and in total;
- Test API assertion/probe counts, reported separately from MCP rounds;
- raw request plus response bytes;
- MCP tool-schema bytes cold and amortized warm;
- actual model tokens when available, without estimating them from bytes.

Evidence metrics ask whether the first returned packet identifies the target,
before/after state, incorrect neighbor, unrelated changes, coverage, and observation
uncertainty. Extra fields receive no credit unless they improve correct diagnosis.

Freeze a separate reviewer power calculation for the candidate 15-point paired
difference, with 80% power, two-sided alpha 0.05, and case clustering. Sample paired
packets balanced by arm, site, truth variant, and oracle outcome; do not treat multiple
packets from one case as independent. Require at least 20 arm-discordant packet pairs,
10 diagnosis errors across both arms, six cases, and three sites before evaluating the
evidence gate. Two reviewers independently score each packet using a frozen rubric. They
are blinded to arm labels, oracle truth, the paired packet, and aggregate results, and no
reviewer sees both arms of one trial. Strip branding but preserve substantive evidence;
record an arm guess to measure residual unblinding. A third similarly blinded reviewer
adjudicates disagreements. Report individual scores and agreement as well as the
adjudicated result; compare arms with the same paired case-cluster bootstrap.

## Decision and kill gates

No pilot can clear a numerical gate. After the power calculation freezes the margins,
sample sizes, and analysis, SnapDOM must first pass all confirmatory safety and
non-inferiority gates. The current candidate gates are:

1. **Safety:** any confirmed false green on a torn/unobservable trial kills the run. With
   zero events, the one-sided exact 95% Clopper-Pearson upper bound over independent
   safety cases—or the preregistered case-cluster bound when cases repeat—must also be
   below a safety ceiling frozen by the power calculation; `0/20` alone does not pass.
2. **Non-inferiority:** the one-sided 95% upper bound for SnapDOM minus Playwright
   false-green risk must be below a candidate +2 percentage-point margin.
3. **Abstention:** the 95% upper bound for ordinary-trial `UNKNOWN` must be no greater
   than the candidate 5% ceiling.
4. **Operation:** the 95% lower bound for clean startup, execution, and cleanup must be at
   least the candidate 95% floor.

After those gates, maintaining SnapDOM as an additional layer requires at least one of
the following candidate, preregistered wins:

1. **MCP accuracy:** at least a candidate 10-point absolute and 30% relative false-green
   reduction, with the paired 95% confidence interval above zero, present on at least
   three of four sites. Relative reduction is `(PW - SnapDOM) / PW`; when the observed
   Playwright rate is zero it is undefined, is not reported as 100%, and this accuracy
   gate cannot clear. Require at least 10 Playwright false-green events to evaluate the
   relative component; inference remains on the absolute paired risk difference.
2. **MCP efficiency at equivalent accuracy:** median verification cost improves by at
   least one tool round and 30% warm bytes, while p95 latency is no worse than 1.2 times
   Playwright MCP, on at least three of four sites.
3. **Evidence wedge:** on at least three cases across two sites, SnapDOM's direct first
   packet enables a candidate 90% correct blinded diagnosis and beats Playwright MCP's
   direct evidence by a candidate 15 points. If Playwright custom evaluation matches that
   accuracy, SnapDOM must still save one round or 30% bytes.

Playwright wins or ties by default when:

- correctness is within the frozen non-inferiority margin and Playwright is no more
  expensive;
- SnapDOM returns more fields but does not improve blinded diagnosis;
- the advantage disappears when Playwright MCP receives its testing tools;
- the advantage requires a weaker postcondition, counting `UNKNOWN` as correct, or
  excluding wrong-target and partial-effect trials.

If the powered design is impractical, any hard gate fails, or SnapDOM clears none of the
three value gates, stop treating it as a separate general verification layer and use
Playwright directly for these workloads. Too few events or discordant pairs is
`UNEVALUABLE`, never a tie or a pass; if a realistic confirmatory run cannot resolve it,
kill the separate layer. A possible no-CDP or embedded-runtime use case is a different
hypothesis and is not rescued or disproved by this browser-owned comparison.

## What this comparison can and cannot decide

With the preregistration above, it can decide for the pinned versions, cases, and sites:

- whether equal-intent SnapDOM checks change false-green, false-negative, or abstention
  rates;
- whether SnapDOM reduces MCP verification rounds, bytes, or latency;
- whether typed transition, coverage, and uncertainty evidence improves diagnosis;
- whether any gain is broad enough to appear on more than one site.

It cannot establish:

- that either tool is better across the web;
- improved end-to-end task completion outside the selected workflows;
- cross-browser equivalence;
- security, privacy, compliance, or evidence authenticity;
- performance for authenticated or personal-session workflows;
- the value of extension, Electron, webview, or other no-CDP deployment modes;
- long-term maintenance cost or any customer, pricing, or market conclusion.

[pw-assertions]: https://playwright.dev/docs/test-assertions
[pw-actionability]: https://playwright.dev/docs/actionability
[pw-aria]: https://playwright.dev/docs/aria-snapshots
[pw-visual]: https://playwright.dev/docs/test-snapshots
[pwmcp-assertions]: https://playwright.dev/mcp/tools/assertions
[pwmcp-snapshots]: https://playwright.dev/mcp/snapshots
[focal-runner]: ../experiment/value-focal.mjs
[focal-result]: ../experiment/results/value-focal.json
[focal-result-v2]: ../experiment/results/value-focal-v2.json
[focal-result-v2-rep2]: ../experiment/results/value-focal-v2-rep2.json
[focal-result-v2-rep3]: ../experiment/results/value-focal-v2-rep3.json
[focal-result-v2-rep4]: ../experiment/results/value-focal-v2-rep4.json
[focal-result-v2-rep5]: ../experiment/results/value-focal-v2-rep5.json
[mcp-value-runner]: ../experiment/mcp-value.mjs
[mcp-value-result]: ../experiment/results/mcp-value.json
[mcp-value-report]: ../experiment/results/mcp-value.md
[old-fg-runner]: ../experiment/c-false-green.mjs
[old-fg-result]: ../experiment/results/c-false-green.json
