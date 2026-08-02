# Test plan

2026-08-01 · branch `agent-lab` · companion to `PAPER.md` (the evidence) and
`docs/LANDSCAPE.md` (the surrounding field and the risks).

This document answers three questions the other two do not: **(1)** when each way of
using the tool is the right one, **(2)** whether they all give the same answer, and
**(3)** whether a model with its own tools available *chooses* this one — and for what
kind of work.

Rule for this plan: every phase states **what result would prove it wrong**. A phase that
can only confirm what we already believe is a demo, not a test.

---

## 1. The five ways to use it

| # | Mode | What it is | Typical user | Needs CDP | State |
|---|---|---|---|---|---|
| S1 | **Library** | `snapdom(el,{plugins:[agentOracle()]})` / `inspect()` | Product code: extension, embedded copilot, webview | No | 50 tests |
| S2 | **Command line** | `browse.mjs serve` + verbs | An agent that chains many commands per turn | Yes (its own Playwright) | Review rounds v2–v5 |
| S3 | **MCP server** | 10 tools | Any MCP client, as native tools | Yes (via the daemon) | `mcp/GATE.md`, bench-qa |
| S4 | **Chrome extension** | Content script in the isolated world + postMessage | An agent living inside the user's own Chrome | **No** | gate 27/27 |
| S5 | **Global install** | `~/.claude/snapdom-agent` + a user skill | Every Claude Code session on this machine | Yes | Daily use |

### How to choose (in cutting order)

1. **Does the agent live inside the user's page?** (extension, embedded copilot, webview)
   → **S4** if it is a third-party agent that talks over postMessage; **S1** if it is your
   own code. *This is the only case with no alternative on the market* — Playwright MCP,
   agent-browser, Stagehand and computer-use agents all need CDP or their own browser.
2. **Is the user an agent with configurable native tools?** → **S3**. This is the correct
   way in: `claude mcp add` is consent from the machine's owner, not a protocol pasted
   into a chat window.
3. **Can the user chain many commands per model turn?** → **S2**. Measured: 20 commands
   in about 6 turns, against one action per turn for extensions.
4. **Is it your own machine, for every session?** → **S5**.
5. **Does it need the user's real logged-in browser?** → **S4 is the only option** (S2 and
   S3 launch an isolated Chromium). A warm session avoids blocks, but nobody recommends
   pointing an agent at a daily-use profile. That trade-off belongs to the user.

### What this table does not cover (design gaps, not test gaps)

- **Multiple tabs or windows**: no mode supports it. agent-browser does.
- **State restore**: a checkpoint is a point of comparison, not an undo. That is a
  decision, not a bug.
- **Fine-grained permissions**: `--readonly` / `--allow` / `--redact` are coarse. There is
  no per-field or per-destination policy.

---

## 2. Coverage map

| Dimension | S1 lib | S2 CLI | S3 MCP | S4 extension | S5 global |
|---|---|---|---|---|---|
| Comparison is correct | ✅ 50 tests | — | ✅ bench-qa 19/19 | ✅ gate | ✅ since 2026-08-01 |
| Speed / main-thread block | ✅ scaling | ⚠️ JSONL only | — | ✅ gate, throttled | — |
| Bad input fails loudly | ✅ tests | ✅ smoke | ✅ review round | ✅ gate | ✅ |
| Privacy / redaction | ✅ 8 tests | ✅ smoke | ✅ smoke | ✅ gate ×5 | ✅ |
| Real end-to-end task | — | ✅ benchmark | ✅ benchmark | ✅ panel rounds | ⚠️ daily use |
| **All modes agree** | ✅ phase A | ✅ | ✅ | ✅ | — |
| **`rec`/`parent`/`snap`/`cp`/`map`** | — | ✅ phase A-bis | ✅ | — | ✅ |
| **Does the model prefer it** | — | ✅ phase B | ✅ | ❌ | ❌ |
| **Against comparable tools** | ✅ E1 | ✅ E2 | — | — | — |

The bold rows are this plan. The verb row was checked with a matcher over `test/`,
`experiment/`, `companion/gate.mjs` and `demo-qa/`: `rec` and `parent` appeared nowhere,
and `snap`/`cp`/`map` only in `mcp/server.mjs`, which is the implementation and not a
test.

---

## Phase A — do all five modes agree? ✅ done

**Question**: do the modes give the same answer to the same fact?

Each one had its own gate and none of them crossed. It had already bitten us: a false
`navigated` on `file://` existed in the daemon and not in the extension, and only turned
up by accident during a demo run.

**Design**: 8 cases from the corpus (4 real changes, 4 noise) plus 2 single-page
navigation cases and 2 occlusion cases, run through S1/S2/S3/S4 against the same local
fixtures. One runner compares `changed`, the change kinds, the names, `navigated`,
whether a reference point existed, and the privacy report.

**Would prove it wrong**: 2 or more differences in meaning (not formatting) would make
"the same reader through every path" false, and it would have to be fixed before showing
this to anyone.

### Result (`experiment/parity.mjs`)

**Agreement on the first run: 0 of 8 disagreements on `changed`, 0 of 8 contradictions
with the hand-written truth, and the change kinds match exactly across all four modes.**

| fixture | truth | S1 lib | S2 CLI | S3 MCP | S4 extension |
|---|:---:|---|---|---|---|
| text-update | true | content | content | content | content |
| list-row-inserted | true | added+moved+resized | same | same | same |
| button-enabled | true | state | state | state | state |
| modal-overlay | true | added | added | added | added |
| live-timestamp | false | — | — | — | — |
| css-animation-running | false | — | — | — | — |
| scroll-only | false | — | — | — | — |
| residual-hover | false | — | — | — | — |

Plus the two contracts the corpus did not cover:

| contract | S1 lib | S2 CLI | S3 MCP | S4 extension |
|---|---|---|---|---|
| something became covered | 1 | 1 | 1 | 1 |
| `navigated` after `pushState` | n/a by design | true | true | true |

**A false alarm worth recording as a result**: the first run reported `navigated:false`
everywhere and failed the phase. It was not a bug. `history.pushState` to a new path
throws a `SecurityError` under an opaque origin (`file://`), so the URL never changed and
`false` was the *correct* answer. The runner now serves the fixtures over HTTP. Same
lesson as the performance saga — check the instrument before accusing the system.

Caveats, without which the result reads as stronger than it is:

- **S2 and S3 are not independent**: the MCP server is a thin translation of the daemon,
  so they share an engine. There are three genuinely independent paths: the raw library,
  the daemon family, and the extension bundle.
- The corpus is the one the tool was developed against. This proves the modes are
  consistent, **not** that they are correct on pages nobody has seen.
- `navigated` is a contract of the modes that track a URL. The library hands back a
  comparison and does not participate. That is design, not a gap.

---

## Phase A-bis — features with zero coverage ✅ done

**Gap found in an outside review** (verified with a matcher over `test/`, `experiment/`,
`companion/gate.mjs`, `demo-qa/`): the verbs `rec`, `parent`, `snap`, `cp` and `map`
appeared **in no gate, test or benchmark**. Only in `mcp/server.mjs`, which is the
implementation. The original plan looked at the modes and never at the inventory of what
the tool exposes.

### A product question to settle before spending tests on recording

`rec` (a GIF encoder in pure JavaScript plus MediaRecorder, both from snapDOM's public
plugins, no external codecs) has no defined user. **A model is not going to watch a GIF
frame by frame at any reasonable cost.** If the viewer is a human, the natural place for
a recording is **evidence attached to a check that failed** — a red assertion that hands
you three seconds of what actually happened. That fits the framing exactly, and it is
real use of the public plugins.

**Decision needed**: either `rec` becomes part of what a failed check returns, and then it
gets tested as part of that contract, or it stays a demo utility and a smoke test is
enough. Do not test something whose user is undefined.

### Result

19 of 19 checks, run against **both installs** — the repository tree and the global copy
in `~/.claude/snapdom-agent`. Covered: `parent` climbing to a card with 2 or more
clickable things, `map` paging without gaps or repeats, `snap` producing a real image,
`cp save/list/diff`, `rec` in GIF and MP4 scoped to the page and to one element, a
navigation during a recording, and `find`/`text`/`redact`.

Two findings: the ranking can mislead on some pages, and the documented claim that a
navigation aborts a recording is **wrong** — it does not happen.

---

## Phase E — comparison with `vercel-labs/agent-browser`

**Gap found in an outside review**: it is the most comparable public tool that exists —
same category (CLI plus daemon, references, search, MCP), public repository — and until
this phase we had only read its documentation. **We had never run a single task with it.**
Comparing by reading a README is not comparing.

This is not a competition. E5 below is the reason: it turned out we can run *inside* it.
The point of E1–E4 is to find out whether our central claim survives contact with the
closest comparable implementation, and to write down what it does better.

Verified for this plan: it installs with `npm install -g agent-browser`, CLI and daemon
in Rust, Chrome for Testing downloaded automatically, and it exposes `snapshot`,
`diff snapshot | screenshot | url`, `eval`, `screenshot`, `click/fill/type` and a plugin
protocol over stdio.

### E1 · The comparison with no model involved ✅ done

Added as a fourth arm in `bench-qa.mjs`, next to the pixel and accessibility-tree
baselines, over the 19 cases with hand-written truth.

**Would prove us wrong, stated plainly**: if its comparison scores 19/19, our central
claim collapses and we should be the first to know.

**Result: 11/19 as it comes, 17/19 after normalizing away its element references.** As
shipped, its references are renumbered between readings, so every reading looks different
and all 8 noise cases read as changes. Normalized, it misses 1 real change and reports 1
false alarm. Our 19/19 stands, but **against a well-normalized comparison the margin is
2 cases, not 6** — and that is the honest way to state it.

### E2 · The contracts where we claim an advantage ✅ done

**Result: 2 advantages confirmed, 1 of our assumptions disproved, 1 shared limit.**

- **Occlusion**: we report a covered button *before* the click. It has no such signal —
  its click fails afterwards. Advantage confirmed.
- **Single-page navigation**: we report that the URL moved. Its comparison shows the
  content change but not the page crossing. Advantage confirmed.
- **Identity across a remount**: both stable. We had claimed its references would not
  survive. **False** — they do.
- **Identity across a reordered list**: neither is stable. Our claim of following identity
  through reordering **does not hold** with short names; the tool declares uncertainty
  instead, which is the designed behaviour but is not the same as tracking identity.

### E3 · A fourth arm in the task benchmarks ⬜ open

Add it to `experiment/formal/` (10 tasks, same model, same independent judge). Nearly free
because the harness exists — only the runner changes.

**Hygiene**: the Reddit datapoint about its speed is **one user's anecdote**, not a
result. It is a hypothesis to test, never a quotation.

### E4 · Where it is ahead of us ✅ done

Permission layer (`--action-policy`, `--confirm-actions`, `--content-boundaries`),
sessions and multiple tabs, an auth vault, a dashboard, snapshot scoping. Written into our
backlog rather than swept aside. A comparison where the other tool wins nothing is a
comparison done badly. See `experiment/results/e4-where-they-win.md`.

### E5 · Coexistence ✅ done — and it changes the framing

They have `eval` and a plugin protocol. **Can our reader run inside their flow?**

**Yes.** 45 KB injected through their own `eval`, their flow untouched, and our change
report comes back on top of it. That makes them a distribution channel, not a competitor —
which addresses the single biggest weakness in `LANDSCAPE.md` (no distribution at all).

---

## Phase B — what the model chooses when nothing tells it to ✅ done

**The bias to avoid**: the `agent-browse` skill *tells* Claude Code to prefer this tool.
Any measurement with that skill active measures obedience, not preference. It has to be
off.

**Design — three arms, same model**: free choice with both toolsets and a neutral prompt;
free choice plus a one-line justification per step (run separately, because asking for a
justification changes the choice); and forced single-channel controls for the ceiling of
each.

**Tasks: long and real, not the 10 from the formal benchmark.** Those are 2–8 actions
where every arm succeeds (119/120) — they do not discriminate. This needs missions of
15–40 actions: multi-page research with accumulated extraction, a multi-step form with a
deliberate validation error, deep single-page navigation, a task on a huge page, a task
with ambient noise where "my action worked" must be told apart from "the page moved by
itself", and a recovery task where a step fails on purpose.

**Would prove it wrong**: if the model mostly picks its native tools *and* the tasks still
complete, then the perceived value is not there and the framing has to change.

### Result

**The model chose this tool in 63 of 81 channel-using steps (78%), in all six tasks.**
Token cost of the forced arms: 1,078k for pixels against 216k for this tool — 5× fewer,
and 4× cheaper ($6.02 against $1.50).

Qualitatively it uses a screenshot to **orient itself** at the start, then switches to
this tool to **operate and verify**. That supports offering both, not replacing one.

---

## Phase C — silent failures against real frameworks ✅ done

**Question**: does this catch failures that other channels call successes?

**Design**: a test page with planted silent failures — a no-op button, a form rejected
without a message, a click swallowed by an invisible overlay, a notification that expires
before you look, a row inserted out of view, a state change with no visual difference, a
double submit, a half-hydrated single-page navigation. An independent function reads the
real state and decides what happened.

**Metric**: the share of cases where a channel reports success and the independent check
says it did not happen.

### Result

| Channel | Right | Wrong success reports |
|---|---:|---:|
| **Stating the expected outcome and checking it** | **8/8** | **0** |
| Just asking "did anything change?" | 4–6/8 | 2–4 |
| `agent-browser` snapshot diff | 2/8 | 6 |
| Screenshot comparison | 2/8 | 6 |

**0 against 6 out of 8.** The cut-off in this plan asked for a 30-point difference; the
result is 75.

The second row is a range on purpose. It scored 6/8 in the first run and 4/8 in the
re-run, because it depends on what the page's own noise does at that moment. **That
instability is itself the finding**: "did anything change?" is the wrong question on a
live page, and the stated-expectation arm was stable at 8/8 in both runs.

---

## Phase D — somebody else's benchmark ✅ done, and it hurt

**Question**: do the numbers hold on tasks we did not write?

Our formal benchmark gives 119/120 with our own tasks, and that 100% suggests the tasks
are *easy*, not that the channel is better — public benchmarks measure around 30% real
success on comparable work.

**Design**: the subset of `iMeanAI/Mind2Web-Live` whose scoring steps can be judged by URL
alone — 23 of the first 40 tasks; 8 were run. The metric is WebCanvas's, not ours.

**Would prove it wrong**: if this tool does not beat the native channel on somebody else's
corpus, our own benchmark result was an artifact of how we wrote the tasks.

### Result: it did not beat it

| Benchmark | Success |
|---|---:|
| Our formal benchmark (our tasks) | **99%** |
| **Mind2Web-Live, this tool** | **28%** (8 of 29 scoring steps) |
| Tasks finished end to end | 1 of 8 |

28% is exactly where the literature puts current agents on the live web. The pattern: it
reaches the right site almost every time and loses the middle steps — filters, multi-field
forms, flows needing a login or earlier state.

**The comparison arm is incomplete and what exists goes against us.** API credit ran out
after 3 of 8 tasks. On those 3, the screenshot arm scored 5 of 8 scoring steps against
this tool's 3 of 8. Three tasks prove nothing, but the direction is recorded.

**This phase gives no evidence that reading structure instead of pixels helps an agent
finish more tasks.** The measured advantages are cost (phase B) and catching silent
failures (phase C).

Finishing it properly: about $4 for the comparison arm, about $25–30 to widen to 23 tasks
with 2 repetitions.

---

## What the cycle produced

Every phase above carries its own result. They are not repeated here, and the numbers
live in `PAPER.md` — this section keeps only what a results table cannot: the claims we
had to withdraw, and the mistakes we made measuring.

### What this cycle corrected in our own claims

- ~~"a text diff of the accessibility tree misses the `disabled` flip"~~ → **false**, it
  catches it; the flag travels in the serialization.
- ~~"their references do not survive a remount"~~ → **false**, they do (`e1 → e1`).
- ~~"we track identity through reordering"~~ → **only sometimes**: it depends on how rich
  the names are. With short names the tool declares uncertainty instead.
- ~~"a navigation aborts a recording"~~ → **does not happen**; the documentation was
  stale.

### Measurement hygiene

Seven method bugs of our own, all found and fixed before believing any number:
`diffPixels` called wrongly (0.000% everywhere), a programmatic click that passed straight
through the overlay, a click by coordinates outside the viewport, an unfair comparison of
their `eval` against our real click, and a judge measuring "did anything mutate?" instead
of "did the expected outcome happen?". Plus the `execFile` input handling in E5, and in
phase D a `catch { break }` that swallowed API errors and made five dead runs read as
legitimate zeros.

**No result in this cycle survived its first run without review, and the silent-failure
pattern showed up three times in my own harness** — the same pattern the tool exists to
catch in pages.

---

## What is still open

- **E3**: add `agent-browser` as a fourth arm in `experiment/formal/`. Nearly free, the
  harness already exists.
- **Phase D properly**: the comparison arm ran out of credit after 3 of 8 tasks. About $4
  to finish it, about $25–30 to widen to 23 tasks with repetitions.
- **A decision, not a test**: whether `rec` becomes evidence attached to a failed check,
  or stays a demo utility. Until that is settled its tests are a smoke test of a feature
  with no user.
- **Phase 4 of `PLAN.md`**: the cold-integration gate, which has never been run.

The cut-off criterion was met: phase C showed a 75-point difference on silent failures
and phase A is clean, so there is a case for looking for a first real user. Phase D says
the framing must stay narrow while doing it — this checks postconditions, it does not
make an agent more capable.

## Not in this plan, on purpose

- More features. The priority is outside validation and distribution, not new surface.
- Improving on 19/19 or 119/120: neither number tells us anything new.
- Multiple tabs, state restore, fine-grained permissions: deferred until a real user asks
  — but E4 documents them as things the comparable tool already has, which is different
  from ignoring them.
- Publishing anything.

---

## History of gaps in this plan

Written so we do not repeat them.

1. **A whole family of features untested** (`rec`/`snap`/`cp`/`parent`/`map`): the plan
   looked at the modes and never at the inventory of verbs. New rule: before planning
   tests, list everything the tool exposes and mark what no gate touches.

2. **A comparable tool never actually run**: agent-browser was analysed in
   `LANDSCAPE.md` at documentation level and that felt like coverage. It is not. New rule:
   a tool you have not run is a tool you have not measured, however tidy the notes you
   wrote about it.

3. **The install we use every day was in no gate** (2026-08-01). Every gate ran against
   the repository tree; the global install in `~/.claude/snapdom-agent` was never
   exercised. There, the `sdk.js` bundle was built from a **second copy** of the entry
   source, which never received `redactString`: `window.__agentRedact` was undefined and
   `find`, `text` and `assert` threw inside the page. `open` still worked, so the daemon
   looked healthy. New rules: (a) one bundle definition, in one file
   (`tools/sdk-bundle.mjs`, which verifies the globals at build time); (b) gates take
   `--daemon <path>` and are run against the global install too; (c) the extension bundle
   is rebuilt and compared before trusting its gate — it was stale relative to commit
   `91daf6d`, so the privacy fixes were **not** in the extension loaded in Chrome.

4. **Four harnesses finished and never exited** (2026-08-01). `e1`, `e2`, `e5`,
   `c-false-green` and `b-preference` wrote their results and then hung, holding the
   fixture server open on a keep-alive socket. Measured: over 10 minutes of hanging on
   43 seconds of real work. A CI run with a timeout would have reported a red result on a
   run that succeeded. New rule: any harness with a server closes its connections and
   exits on the result.
