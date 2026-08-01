# How browser agents see and verify: the field, the practitioners, and where this project sits

2026-08-01 · Method: two independent passes — (1) Reddit through the arctic-shift archive
(Reddit blocks Anthropic's crawler and every mirror; the archive was the only way in, see
§1.0) and (2) papers, benchmarks and vendor documentation read from the primary source.

Labels: **[measured]** = a number from the paper or evaluation itself · **[self-reported]**
= an evaluation run by the vendor · **[secondary]** = press or third-party coverage.

The comparison in §3 is deliberately even-handed: it includes where this project is
behind.

---

## 1. What practitioners say on Reddit

Sample: 954 posts discovered (17 subreddits × 16 keywords, posted after June 2024) and 32
threads read in full, body and top comments, through the arctic-shift archive. Post ids in
parentheses map to `reddit.com/r/<sub>/comments/<id>/`. The raw data is versioned next to
this document: `landscape-data/discovered.json` and `landscape-data/threads.json`. Every
quotation here can be checked with grep against those files.

### 1.0 A note on access and hygiene

Reddit excludes Anthropic's crawler, the public JSON returns 403, old.reddit asks for a
login, and the mirrors sit behind challenges. The archive was the only reproducible route.

One finding is itself a warning: **this discussion is heavily astroturfed.** In at least 5
of the 32 threads, commenters accuse answers or the original post of being bots or
marketing ("the amount of ai slop astroturfing in these comments is insane"). Any praise
for a product from a single comment in these subreddits is weak evidence.

### 1.1 Themes, with how much agreement each has

**T1 · The cost of perceiving a page is the number one complaint of 2026 builders. Near
consensus.** Screenshots per step, or full accessibility-tree dumps, burn 100k+ tokens per
page, and every vendor pitch leads with reducing that. Concrete numbers from the threads:

- A benchmark from the Opera team (r/AI_Agents 1ukm69c, July 2026): 35 runs × 4 snapshot
  formats — raw chrome-devtools-mcp at 179k tokens on average, a reference CLI at 102k, a
  compressed format at 36k — with **an identical 100% pass rate across all four**. The
  representation changes cost roughly 5×, not the outcome, on reachable tasks.
- "Computer use is 45x more expensive than a structured API call" (1tgyg5r, May 2026,
  a vendor benchmark): 53 steps against 8. The best comment: the bottleneck is not the
  quality of the vision, it is the *number* of screenshots the interface demands.
- OpenBrowser MCP (r/OpenAI 1rb6pgy, February 2026): "One Wikipedia page? 124K+ tokens.
  Every. Single. Call."
- Early reception of Anthropic's computer use (1ga1q15, October 2024): "okay, but very
  expensive".

**T2 · CSS selectors < numbered marks < role plus accessible name. High agreement among
people shipping.** Repeated independently in 3 or more threads (1v7m7q3, 1tnfgel,
1sesyo9): "css selectors break on every redeploy, but numbers break on every dom
change… role + accessible name as the primary locator, then numbered refs from a scoped
snapshot"; resolution chains of "ax_role+name → ax_identifier → css → ocr+pixel"; the
accessibility tree as the most stable binding across redesigns, with the acknowledged
exception of Electron and canvas.

**T3 · Per-step LLM loops waste money and drift. The emerging pattern is plan once,
execute deterministically, and assert.** (1tnfgel, May 2026: browser-use and Stagehand
loops cost 20–50 model calls and $0.50–3.00 per task with "half the runs drifted
off-task"; plan-then-execute cut that by 50×.) The top comment states the doctrine:
compile to "selectors / assertions / fallbacks", run it with plain Playwright, and "only
call the model again if an assertion fails in a new way".

**This is the clearest statement on Reddit of what the literature calls the verification
gap: nobody trusts the agent's own report that its action worked.** High agreement.

**T4 · The 2025 consumer agents were judged not worth it. Dominant sentiment in
high-scoring threads.** "Can't even book a simple flight" (r/OpenAI 1jesec7, March 2025,
score 232, 92 comments); "Too many restrictions… captcha interruptions… Everything I
wanted to do was faster if done myself" (1l2ozip, June 2025); browser-use looping on
Amazon (1jwgclf, April 2025). Counter-anecdotes exist (a Domino's order, some bookings)
but are framed as novelties. In 2026 it continues: "nothing is fast *and* reliable at the
same time" (1uc0bbi).

**T5 · CAPTCHA is considered dead against vision models; the race moved to behaviour and
infrastructure.** The highest-engagement thread in the sweep (r/webdev 1uxfzav, July 2026,
**score 4,316, 491 comments**): a video captcha that took a frontier model "10 minutes and
100k tokens", with the room concluding that an agent with full browser control invalidates
DOM and iframe defences. "CAPTCHA is 100% solvable by AI" (1qzqe7f) is accepted as a
premise; replacing it with typing biometrics was torn apart over false positives.

**T6 · A real logged-in session beats stealth, but nobody recommends using your daily
profile. Unanimous where it is discussed.** (1v7m7q3: "a warm session beats a 'perfect'
fresh fingerprint", and at the same time "attaching an agent to a daily-use profile full
of email, payments, and admin sessions is convenient until one bad page instructs it…").
Blast-radius and prompt-injection reasoning is standard vocabulary now, including a paper
shared in r/LocalLLaMA (1n8bgtr) showing **the accessibility tree itself as an injection
vector** — the "clean" channel is also attack surface.

**T7 · A contrarian view: agents should not use human interfaces. High score, argued down
in the thread.** "Atlas… is just accruing architectural debt" (1od8vv0, October 2025,
score 437), citing the semantic web as a failed precedent. The key counter-argument:
complex sites keep their APIs closed **on purpose**, so navigating like a human is how
agents get around that, not naivety.

### 1.2 What did not show up

r/QualityAssurance and r/softwaretesting produced no on-topic threads by title search —
the flaky-visual-assertion conversation uses different vocabulary there. r/ClaudeAI and
r/Anthropic had nothing distinctive.

Notable for us: **not one thread asked for or discussed a "semantic diff" as a primitive.**
The need shows up as "deterministic asserts" and "don't trust the agent" (T3), not in our
vocabulary.

---

## 2. Published sources

### 2.1 The three families of perception, and the convergence on hybrids

**Pixels** (screenshot → coordinates):

- Anthropic computer use (docs): a screenshot → click(x,y) loop; the declared resolution
  must match or the coordinates are systematically wrong; verification is another
  screenshot. [self-reported] Claude 3.5 Sonnet 14.9% on OSWorld screenshot-only (October
  2024) against 7.7% for the next system.
- OpenAI CUA/Operator (January 2025): GPT-4o fine-tuned on raw pixels, no DOM.
  [self-reported] 38.1% OSWorld · 58.1% WebArena · 87% WebVoyager. Operator was folded
  into agent mode (July 2025) and deprecated standalone (August 2025).
- Google Project Mariner (December 2024): screenshots to Gemini in the cloud.
  [self-reported] 83.5% WebVoyager.
- Magnitude (open source, 2025): vision only, explicitly anti-DOM. [self-reported] 94%
  WebVoyager.
- UGround (ICLR 2025 oral): the strongest academic case for pixels only — grounding
  trained on 10M elements; [measured] +20 absolute points over previous visual grounding,
  with vision-only agents beating agents that also had the accessibility tree and text.

**Structure** (accessibility tree, distilled DOM):

- WebArena (ICLR 2024): the canonical observation is the accessibility tree. [measured]
  best GPT-4 14.41% against 78.24% for humans.
- Playwright MCP (Microsoft): accessibility snapshot with stable references; every tool
  that acts returns a fresh snapshot, so perceive-act-perceive is built in. [primary]
  a snapshot is roughly 200–400 tokens against 3,000–5,000 for a screenshot;
  "deterministic"; screenshots recommended only for canvas and charts.
- Stagehand (Browserbase): moved from raw DOM to the accessibility tree over CDP;
  [self-reported] 80–90% less data than raw DOM.
- vercel-labs/agent-browser: the same accessibility-reference approach in a CLI.
- browser-use: distilled DOM plus element indices, optional screenshot. [self-reported,
  with caveats they state themselves] 89.1% WebVoyager — they admit modifying the harness
  and prompts and re-judging failures by hand, which is an honest illustration of why
  vendor WebVoyager numbers are not comparable.
- Agent-E (2024): distilled DOM plus **"change observation"** — after each action the
  executor reports to the planner what changed. Explicit, lightweight verification.
  [paper] 73.2% WebVoyager, +20% over previous text-only work.
- AgentOccam (Amazon 2024): no vision, just careful alignment of the observation and
  action spaces. [measured] +9.8 absolute points of state of the art on WebArena —
  engineering the observation space pays as much as architecture.

**Convergence**: [measured] EntWorld (2026) finds screenshot plus accessibility tree is
the best configuration and screenshot-only the worst. SeeAct (ICML 2024) finds the best
grounding combines HTML and vision, and that set-of-marks did *not* work well on dense
web pages. VisualWebArena shows tasks that are impossible without pixels. Chrome DevTools
MCP frames itself explicitly as "eyes to verify". The 2025–26 consensus is hybrid, with
structure as the cheap default and pixels on demand.

### 2.2 The bottleneck is grounding, not planning

- [measured] SeeAct: GPT-4V produces the correct textual plan for 51.1% of tasks if a
  human does the grounding to elements. Automatic grounding is what fails.
- [measured] ScreenSpot-Pro (2025): the best grounding model scores 18.9% on
  high-resolution professional interfaces.
- [measured] Mind2Web: picking the right element ~53% against emitting the full correct
  action 11.2%.

### 2.3 Verification is the weakest link and the best lever

- **False success, quantified** [measured; verified against the primary source in this
  session] — Advani, "From Confident Closing to Silent Failure: Characterizing False
  Success in LLM Agents", **workshop paper at FAGEN@ICML2026** (not the main conference —
  cite it as a workshop paper), arXiv 2606.09863. Over 9,876 trajectories from tau2-bench
  (8 model families) and 1,879 from AppWorld (4 families), false success — the agent
  declares success and the environment state contradicts it — accounts for **45–48% of all
  failures** in single-control tau2 domains, **75.8%** in AppWorld among trajectories with
  an explicit completion claim, and **3%** in the dual-control telecom domains where an
  independent user simulator can verify state. An order of magnitude of difference from
  independent verification, measured. **Scope caveat: these are tool-use and code agents,
  not browser agents. Extrapolating to the web is our inference, not the paper's.**
- [measured] ST-WebAgentBench (IBM, ICML 2025): "completion under policy" is below
  two-thirds of nominal completion — a third of the successes violate a policy.
- [measured] Tree Search, Koh et al. (2024): a value function scoring the resulting states
  — explicit verification — gives +28–40% relative over the same reactive agent.
- [measured] "An Illusion of Progress?" (2025): across 300 live tasks on 136 sites,
  current agents sit around **30% real success against 60–90% reported** on earlier
  benchmarks. Automatic judges, including WebVoyager's, overestimate; their WebJudge
  reaches about 85% agreement with humans.
- How vendors verify today: re-perceive (another screenshot or snapshot) or ask a human
  (Atlas pauses on sensitive actions). Not a programmatic check of state.
- WebSight (2025): a dedicated verification agent in the loop; the pattern is high
  precision with incomplete coverage (97.1% correct answers on tasks it completes, 68%
  WebVoyager).

### 2.4 The benchmarks themselves are inflated or broken

- [third-party audit] Epoch AI on OSWorld: about 10% of tasks have serious errors, about
  15% are solvable only through a terminal and about 30% through terminal or Python (so
  they measure coding, not GUI use); the human baseline of 72% implies ambiguity in up to
  28% of tasks.
- [primary] OSWorld-Verified (July 2025): maintainers fixed 300+ issues, so scores before
  and after are not comparable.
- WebVoyager is saturated: 94% (Magnitude) and 98.5% (Alumnium) self-reported in 2025. It
  no longer discriminates. Treat every WebVoyager state-of-the-art claim as marketing.
- WebCanvas / Mind2Web-Live: evaluate on live sites with intermediate "key nodes";
  [measured] best agent 23.1%. Systems that are competitive offline are not competitive
  online.

### 2.5 The token economics of perception

- Playwright MCP [primary]: snapshot 200–400 tokens against 3,000–5,000 per screenshot.
- Stagehand [self-reported]: accessibility tree 80–90% smaller than raw DOM.
- Markdown against HTML [secondary, Cloudflare via Firecrawl]: 3,150 against 16,180 tokens
  (−80%).
- "The Complexity Trap" (2025) [measured]: observation tokens dominate an agent's context
  and are re-billed every step, growing roughly quadratically with step count. That is why
  screenshot-heavy perception is expensive; simple masking performs about as well as
  summarization.

---

## 3. Where this project sits

Internal references: `PAPER.md` (19/19 with 0 false alarms, the formal benchmark of 4
arms × 3 repetitions × 10 tasks with 119/120 and 0 wrong success reports, and the 28% on
third-party tasks), `FIELD.md`, `experiment/results/`.

### 3.1 Where we match the consensus — neither ahead nor behind

- **Hybrid structure plus pixels**: our pilot conclusion (screenshot plus this tool wins;
  snapDOM's own render plus this tool takes fewer steps) is exactly the EntWorld ablation
  and the Playwright MCP recommendation. That is not differentiation, it is the state of
  the art.
- **The economics of perception**: our median of 19 tokens per comparison against roughly
  1,365 for a screenshot is consistent with, and the same order as, Playwright MCP's
  200–400 against 3,000–5,000. The cost complaint that dominates Reddit validates the
  problem, but the large players already attack it with accessibility snapshots.
- **Observing again after acting**: Playwright MCP already returns a snapshot after every
  action, and Agent-E already reports what changed to the planner. Re-observing is not our
  idea. The *shape* of the report is (see 3.2).

### 3.2 Where there is real differentiation, with outside support

- **A change report as a verification layer is exactly what the field measured to be
  missing.** The strongest result in the 2026 literature — false success is 45–76% of
  failures without independent verification and about 3% with it — is the business case
  for `browser_verify` and `browser_assert`. Our 0 wrong success reports out of 120 in the
  formal benchmark is that same metric, measured with an independent judge. None of the
  vendors surveyed offers a programmatic check of effect as a primitive: they re-perceive,
  or they ask a human.

- **A comparison with identity and kinds, not a text diff — but we are not the only ones
  exploring this any more.** Among established tools: agent-browser's `diff snapshot` is a
  text diff of the accessibility tree, with no identity across mutations, no geometry, and
  references it documents as unstable. Playwright MCP does not diff at all — it hands over
  the new snapshot and the model compares. Ours classifies changes and matches by
  fingerprint, with a proactive warning about covered elements.

  On the 19 cases that gives 19/19 with 0 false alarms, against 13/19 with 5 false alarms
  for a pixel comparison and 16/19 with 2 for an accessibility-tree diff — see 3.3 about
  who wrote that corpus. **And against a normalized agent-browser it is 19/19 against
  17/19** (`experiment/results/e1-agent-browser.md`), which is a much smaller margin than
  the pixel comparison suggests.

  **A correction verified against our own raw data**: at least one small project is
  exploring nearly the same core. **"Rote"** (r/AI_Agents 1v695rl, 25 July 2026, score 1,
  5 comments): a "memory manager for browser agents" that, after a grounded snapshot,
  sends only the diff, with ids derived from `hash(role+name+ancestry)` that survive
  re-renders; [self-reported] 37% less token growth over 150 runs against Browser Use.
  Differences from ours: it is positioned as memory and token savings rather than as a
  verification primitive (no assertions, no occlusion, no declared change kinds, no
  fail-loud contract), and it assumes the CDP stack.

  The defensible claim is no longer "nobody does identity-based diffs". It is: **no
  established tool yet offers a complete primitive for checking that an action had its
  intended effect — and the underlying architecture is occurring to other people too.**

- **The no-CDP niche exists and nobody covers it.** Every serious stack surveyed
  (Playwright MCP, agent-browser, Stagehand, CUA, Mariner) needs CDP or its own browser.
  MV3 extensions and embedded copilots cannot use them. Our walk in the isolated world
  (3 of 3 under real CSP) is the only offering surveyed for that case. The symmetric risk:
  the niche may be small, or the runtimes may absorb it (3.3).

- **Failing loudly as a contract** (invalid specifications come back red with a diagnosis;
  probing a redacted term is refused; 0 wrong success reports under misuse in real rounds).
  ST-WebAgentBench shows the field is only starting to measure this, and we saw no
  equivalent of "an assertion that refuses to lie" among the vendors surveyed.

- **The demand exists, in other words.** The doctrine emerging on Reddit (T3: plan once,
  execute deterministically, assert, and only call the model again on a new kind of
  failure) is exactly what `browser_act` plus `browser_assert` cover, with a vocabulary
  that is ready to use. Several decisions we already made match what the community
  validated the hard way: clicking by role and name with an echo rather than by CSS
  selector (their T2), an isolated daemon with `--readonly` and `--allow` instead of the
  daily profile (their T6), and page output fenced as data rather than instructions —
  which the accessibility-tree injection paper backs up from outside.

### 3.3 Where we are behind, and the risks

- **Scale of evidence.** Our formal benchmark: 10 tasks × 3 repetitions × 4 arms, 9 sites.
  WebArena has 812 tasks; Mind2Web 2,350 across 137 sites; Online-Mind2Web 300 across 136.
  With n=10 we cannot claim generalization, only that the harness is honest. And a 100%
  pass rate on our 10 tasks suggests they are **easy** compared to public benchmarks —
  which our own phase D then confirmed directly: 28% on third-party tasks.
- **Self-evaluation.** The 19-case corpus and the task suite were written by the same
  people who built the tool, and we ran the baselines. The mitigation is real (published
  truth per case, standard baselines, an independent judge, a blind replication by an
  outside reviewer) but it is not a third-party benchmark. The lesson of "Illusion of
  Progress" applies to anyone measuring themselves, including us.
- **No validation on public benchmarks.** We have not run WebArena, VisualWebArena,
  Online-Mind2Web or OSWorld end to end. The WebVoyager harness is now built and verified
  for free, but not run. Until then there is no number comparable with anyone. This is our
  most quotable gap.
- **The matcher has never been tested against public grounding benchmarks**
  (ScreenSpot-class). Our node identity works on our corpus; we do not know its rate on
  the long tail of professional interfaces, where the field measures 18.9%.
- **Distribution and ecosystem: none.** browser-use has tens of thousands of stars and
  funding; Playwright MCP is the de facto default with Microsoft behind it; Chrome
  DevTools MCP comes from the Chrome team. We have a private repository, zero outside
  users, and validation by two reviewing agents we orchestrated ourselves. The best
  comparison in the world without distribution loses to a mediocre one built into the
  runtime everybody already uses.
- **Absorption risk, and the window already has traffic.** Playwright MCP already does
  perceive-act-perceive; adding a semantic differ is a natural increment for Microsoft or
  Google (Chrome DevTools MCP already describes itself as "eyes to verify"). The Rote
  finding (§3.2) shows the identity-diff idea has already occurred to at least one
  independent builder who benchmarked it against Browser Use. The window for "an
  integrable component before the runtimes absorb verification" is supported by this
  survey — but it is a window with more people entering it, not a moat.
- **The bet against vision could age badly.** UGround and the CUA line show real progress
  in trained visual grounding. If pixel grounding becomes reliable and cheap in two or
  three years, "structure is more precise than pixels" weakens. The cost argument and the
  no-CDP argument survive better than the precision argument.
- **Missing capabilities the field already considers basic** for production agents:
  multiple tabs and windows, managed auth and sessions, downloads and clipboard, real
  state restore, fine-grained permissions. agent-browser already ships several.
- **Nobody asks for a "semantic diff" by that name.** In 954 posts, not one thread used
  our vocabulary. The need is expressed as "deterministic asserts" and "don't trust the
  agent". That means a market to educate: the pitch has to enter through the pain people
  actually name — token cost, flaky assertions, drift — and not through a category we
  invented.
- **On reachable tasks, the representation does not change the outcome.** The Opera
  benchmark on Reddit (4 formats, identical pass rate, only cost changes) agrees with our
  own formal benchmark (4 arms, 119/120): on easy tasks everyone arrives, and the
  difference is cost, latency and queueing. An advantage in *success* for the structural
  channel would only be demonstrable on harder tasks than either benchmark contains — and
  phase D, on harder third-party tasks, found no such advantage.

### 3.4 What to adopt from the field, cheaply

1. **Run Online-Mind2Web or a WebArena subset** with all four arms of the formal harness.
   This replaces "our 10 tasks" with somebody else's and gives the comparable number we
   lack. Phase D started this with 8 tasks; widening it is the largest credibility gain
   per unit of effort.
2. **A WebJudge-style judge** alongside the deterministic one. Our fetch-based judge is
   strong but covers little; WebCanvas's key-node pattern would make long tasks judgeable.
3. **The completion-under-policy metric** from ST-WebAgentBench for the misuse arm. We
   already have the vocabulary (fail-loud, redact, readonly); formalizing it with their
   metric makes it citable.
4. **Cite the false-success literature** (2606.09863) in `PAPER.md` §4. It is the exact
   outside validation for layer 3, with the scope caveat that it is not about browsers.

### 3.5 In one line

We are **aligned** with the technical consensus (hybrid perception, cheap structure), have
**one real differentiator with outside support** (a programmatic check that an action had
its effect, plus the no-CDP niche), and are **behind on everything around the core**:
scale of evidence, third-party benchmarks, production capabilities, distribution and
community. The science behind the pitch is better supported than we knew. The product
around the pitch is where this survey leaves us worst off.

---

## 4. References

Verification status: **[V]** = primary source re-verified by us in this session (the
figure checked against the abstract or page). The rest come from the research pass with a
primary URL; the figures quoted in §2 have not been audited table by table — do that
before quoting any of them in something publishable.

### Papers and benchmarks

- WebArena (ICLR 2024) — https://arxiv.org/abs/2307.13854
- VisualWebArena (ACL 2024) — https://arxiv.org/abs/2401.13649
- Mind2Web (NeurIPS 2023 spotlight) — https://arxiv.org/abs/2306.06070
- SeeAct: "GPT-4V(ision) is a Generalist Web Agent, if Grounded" (ICML 2024) — https://arxiv.org/abs/2401.01614
- WebVoyager (ACL 2024) — https://arxiv.org/abs/2401.13919
- OSWorld (NeurIPS 2024) — https://arxiv.org/abs/2404.07972 · https://os-world.github.io/
- Set-of-Mark Prompting (Microsoft, 2023) — https://arxiv.org/abs/2310.11441
- SeeClick + ScreenSpot (ACL 2024) — https://arxiv.org/abs/2401.10935
- ScreenSpot-Pro (ACM MM 2025) — https://likaixin2000.github.io/papers/ScreenSpot_Pro.pdf
- UGround (ICLR 2025 oral) — https://arxiv.org/abs/2410.05243
- AgentOccam (Amazon, 2024) — https://arxiv.org/abs/2410.13825
- Region4Web (2026) — https://arxiv.org/html/2605.07134
- EntWorld (2026) — https://arxiv.org/pdf/2601.17722
- WebSight (2025) — https://arxiv.org/abs/2508.16987
- Reflexion (NeurIPS 2023) — https://arxiv.org/abs/2303.11366
- Tree Search for Language Model Agents (2024) — https://arxiv.org/abs/2407.01476
- WebCanvas / Mind2Web-Live (2024) — https://arxiv.org/abs/2406.12373
- "An Illusion of Progress?" / Online-Mind2Web + WebJudge (OSU, 2025) — https://arxiv.org/abs/2504.01382
- **[V]** Advani, "From Confident Closing to Silent Failure: Characterizing False Success
  in LLM Agents" (workshop, FAGEN@ICML2026) — https://arxiv.org/abs/2606.09863 · Figures
  verified against the abstract: 9,876 tau2-bench trajectories (8 families) + 1,879
  AppWorld (4 families); false success = 45–48% of failures in single-control tau2
  domains · 3% in dual-control telecom domains · 75.8% in AppWorld among trajectories with
  an explicit completion claim. Note: tool-use and code domains, not browsers;
  single-author workshop paper — cite it with that framing.
- AgentErrorTaxonomy / "Where LLM Agents Fail" (2025) — https://arxiv.org/abs/2509.25370
- ST-WebAgentBench (IBM, ICML 2025) — https://arxiv.org/abs/2410.06703
- VerificAgent (2025) — https://arxiv.org/abs/2506.02539
- OSWorld-Human (2025) — https://arxiv.org/pdf/2506.16042
- TRAP (2025-26) — https://arxiv.org/pdf/2512.23128
- Agent-E (2024) — https://arxiv.org/abs/2407.13032
- "The Complexity Trap" (2025) — https://arxiv.org/pdf/2508.21433
- Prompt injection through the accessibility tree (2025) — https://arxiv.org/abs/2507.14799

### Vendors

- Anthropic computer use (docs) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool · blog https://www.anthropic.com/news/developing-computer-use · Claude for Chrome https://claude.com/blog/claude-for-chrome
- OpenAI CUA/Operator — https://openai.com/index/computer-using-agent/ · Atlas https://openai.com/index/introducing-chatgpt-atlas/
- Google Project Mariner — https://techcrunch.com/2024/12/11/google-unveils-project-mariner-ai-agents-to-use-the-web-for-you/
- browser-use — https://github.com/browser-use/browser-use · https://browser-use.com/posts/sota-technical-report
- Playwright MCP (Microsoft) — https://github.com/microsoft/playwright-mcp · https://playwright.dev/mcp/snapshots
- Stagehand (Browserbase) — https://www.browserbase.com/blog/ai-web-agent-sdk
- Chrome DevTools MCP — https://developer.chrome.com/blog/chrome-devtools-mcp · https://developer.chrome.com/blog/devtools-for-agents-v1
- agent-browser (Vercel) — https://github.com/vercel-labs/agent-browser
- Firecrawl — https://www.firecrawl.dev/crawl
- Magnitude — https://magnitude.run/

### Industry analysis

- Epoch AI on OSWorld — https://epoch.ai/blog/what-does-osworld-tell-us-about-ais-ability-to-use-computers
- OSWorld-Verified (XLANG Lab) — https://xlang.ai/blog/osworld-verified
- Steel.dev leaderboard — https://leaderboard.steel.dev/
- Deepsense on evaluating web agents — https://deepsense.ai/blog/evaluations-limitations-and-the-future-of-web-agents-webgpt-webvoyager-agent-e/
- Alumnium on WebVoyager — https://alumnium.ai/blog/webvoyager-benchmark/

### Reddit (raw data)

- `landscape-data/discovered.json` (954 posts) · `landscape-data/threads.json` (32 threads
  with comments) — collected through https://arctic-shift.photon-reddit.com on
  2026-08-01. **[V]** The Rote post (r/AI_Agents 1v695rl) was re-verified by grep against
  these files in this session.
