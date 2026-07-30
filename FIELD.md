# Field pass — five real sites, no model, no spend

Date: 2026-07-30 · Chromium 1280×800 · `packages/agent/experiment/field.mjs`

Every number before this document came from fixtures written by the same hand that wrote
the reader. This is the first measurement the product did not author. It cost nothing and
it found more than the paid experiments did.

| site | why it was picked | nodes | walk p50 | walk p95 |
|---|---|---|---|---|
| lanacion.com.ar | news — ad iframes, lazy images, infinite feed | 3 090 | 54 ms | 127 ms |
| github.com | app shell — web components, shadow DOM | 1 503 | 43 ms | 81 ms |
| mercadolibre.com.ar | e-commerce — carousels, sticky header | 1 183 | 33 ms | 66 ms |
| es.wikipedia.org/wiki/Argentina | huge static document — the ceiling | 19 215 | **2 287 ms** | 2 409 ms |
| stripe.com | marketing — scroll-driven animation | 2 121 | 31 ms | 87 ms |

CSP blocked the first attempt on github and stripe. That is a property of the *harness*,
not the product: a content script in an extension's isolated world is not subject to the
page's `script-src`. Re-run with `bypassCSP`, which is the honest simulation.

## 1. Noise — the claim that matters, and it does not hold everywhere

The `agent` preset is supposed to work unconfigured. The test: walk twice with **no user
action** between them. Every reported change is a false positive by construction.

| site | false positives at rest | kinds |
|---|---|---|
| lanacion | **0** | — |
| wikipedia | **0** | — |
| mercadolibre | 31 (intermittent: 0 on a re-run) | 28 `moved`, 3 `style` |
| github | 162 | 162 `moved` |
| stripe | 280 | 274 `moved` |

Three of five fail, and almost every false positive is `moved`. A follow-up run resolved
each one against `getAnimations()` on the node and on every ancestor:

- **github — 162 of 162 are descendants of an animating ancestor** (`Primer_Brand__LogoSuite`,
  the rotating customer-logo strip). This is **our bug**: §5 freezes the geometry of a node
  that is itself animating, but a `transform` animation on a container moves every
  descendant while only the container reports an animation. The freeze does not inherit.
  Fix: propagate the geometry freeze down from an animating ancestor.
- **mercadolibre — an autoplay carousel** ("7 de 7"), driven by JS rather than a CSS
  animation, so `getAnimations()` cannot see it. Intermittent by nature: 31 changes on one
  run, 0 on the next, depending on whether the carousel advanced during the window.
  Not fixable through the animation API; needs either a heuristic or an explicit
  `noise.ignore` selector. **This is a real limit of the zero-config claim.**
- **stripe — 273 `moved`, none with an animating self or ancestor.** The page genuinely
  keeps settling: content arrives and the layout reflows. Nothing to suppress; the honest
  reading is that some pages are still moving seconds after load.

Related finding: the walk descends into SVG internals, reporting `path` and `g` nodes as
moved. Those are not actionable, not readable, and inflate both the noise and the outline.
An SVG should be one node to an agent.

## 2. Size — the diff scales, the snapshot does not

| site | serialized DOM | checkpoint | ratio | outline | idle payload | after scroll |
|---|---|---|---|---|---|---|
| lanacion | 790 KB | 560 KB | 0.71× | 104 KB | **91 B** | 5.8 KB |
| github | 560 KB | 252 KB | 0.45× | 60 KB | 14.8 KB | 29.7 KB |
| mercadolibre | 358 KB | 206 KB | 0.57× | 41 KB | 3.9 KB | 3.4 KB |
| wikipedia | 2 746 KB | **3 621 KB** | **1.32×** | 982 KB | **91 B** | **534 B** |
| stripe | 666 KB | 333 KB | 0.50× | 86 KB | 26.8 KB | 90.7 KB |

Two opposite conclusions, and both are true:

- **The incremental payload survives, and that is the product's actual claim.** On a clean
  page, 91 bytes at rest and 534 bytes after scrolling a 19 000-node document — against
  ~25 KB for a screenshot. Where the noise preset holds, the number that ships to the
  model stays tiny no matter how big the page is.
- **The full snapshot does not scale, and §7's target is missed by an order of magnitude
  in the wrong direction.** The prompt asked for a checkpoint an order of magnitude
  *below* the serialized DOM; measured, it is 0.45×–1.32× of it. Wikipedia's checkpoint is
  3.6 MB and its outline is 982 KB — roughly 250 k tokens, unusable as context.

This matters less than it looks *if* the checkpoint stays in memory between steps of an
in-page agent, which is the designed use. It matters a lot the moment anyone serialises
it, ships it to a server, or wants to send the whole outline to a model. The
"compact, one order of magnitude below the DOM" claim in the spec should be retired or
re-scoped to the diff, which earns it.

## 3. Speed — fine until it isn't

31–54 ms per walk on 1 200–3 100 nodes, against a ~4 200 ms model call: irrelevant.
Wikipedia at 19 215 nodes: **2.3 seconds**, and 16 s for a full capture. The walk is
linear in nodes with a `getComputedStyle` per node, so a document-sized page falls off the
end. An agent loop on a page like that is not viable today without scoping the walk to a
subtree or a viewport.

## 4. Two defects found and fixed here

**The capture path returned an empty snapshot on three of five sites.** `lanacion`,
`mercadolibre` and `stripe` reported an outline of 14 characters — literally
`body [0,0 0x0]` — while the walk alone returned 3 090 nodes on the same page.
Instrumenting the hook showed why: **a single `snapdom()` call runs the pipeline twice on
these pages**, once for `document.body` and again for `documentElement`, and the oracle
kept whichever ran last. It now keeps the first pass — the element the caller asked
about. Fixed, with a regression test that drives the hook twice by hand. All three sites
now return full snapshots (107 k / 42 k / 88 k character outlines).

**Containers were named after their inline scripts.** A Mercado Libre section reported its
accessible name as `"(function() { if (false) { var firstViewUrl = …"`. Content-derived
names read `textContent`, which includes `<script>` and `<style>` source. It never
corrupted identity (a generic role takes no name from content) but it shipped code into
every outline and every change entry. `visibleText()` now skips non-textual tags.

Neither was reachable from the corpus: fixtures do not carry tracking scripts, and no
fixture is a whole document.

## What this changes

The free pass did its job — it moved three claims from "asserted" to "measured", and two
of them came back worse than advertised:

1. **Zero-config noise suppression: not yet.** It holds on a news home and a large
   document, and fails on three pages with moving parts. One of the three causes is a
   plain bug with a clear fix; one is a real limit; one is the page genuinely moving.
2. **Compact checkpoints: no.** Off by an order of magnitude from the spec's target. The
   incremental diff is the part that is genuinely small, and the pitch should say so.
3. **Speed: yes, up to a few thousand nodes.** Beyond that the walk needs scoping.

None of this is fatal, and none of it was visible from inside the corpus. The next honest
step is fixing inherited geometry freezing and collapsing SVG internals — both cheap, both
attack the largest measured failure — and then re-running this exact pass to see the
numbers move.

---

# Visual field pass — three real sites, screenshots judged against the oracle's report

Date: 2026-07-30 · Chromium 1280×800 · `scratchpad/field-visual.mjs` (Playwright, same
page instance produces both the semantic report and the pixels; a model then judged the
screenshots against the report — the first time the two channels were compared by eye).

Also the first field run of the privacy layer (`privacy.redact`), same day it was fixed
to cover the diff surface.

| site | nodes | inspect p50* | rest-noise FPs | privacy leaks | interaction verdict |
|---|---|---|---|---|---|
| es.wikipedia.org/wiki/Buenos_Aires | 11 351 | 6 796 ms | **0** | 0 (1 879 redactions) | ✅ typing in search: 119 `added` = the suggestion dropdown; `becameCovered` names exactly the links the dropdown occludes |
| lanacion.com.ar | 3 135 | 1 400 ms | **0** | 0 | ✅ opening SECCIONES: `becameVisible` = drawer links + "Cerrar", `becameCovered` = the header strip behind the overlay — 1:1 with the screenshot |
| mercadolibre.com.ar | 1 916 | 1 102 ms | **0** | 0 | ✅ honest negative: programmatic fill fired no dropdown and the oracle invented no `added`; the 28 `moved` are the carousel genuinely advancing (visible in before/after) |

\* `inspect()` = walk + full snapdom capture, unlike the walk-only numbers of the first
field pass. Wikipedia confirms the known ceiling: big documents need scoping.

Rest-noise went 3-of-5-failing (first pass) → 0-of-3 here; mercadolibre's intermittent
carousel noise did not reproduce at rest, only across the interaction window, where it is
a true positive.

## New finding — the hidden-input proxy pattern is invisible to the map

Set-of-Mark overlays (agentMap drawn onto the live page) showed near-complete coverage on
all three sites, with one systematic hole: **Wikipedia's hamburger menu and every
"Apariencia" radio are missing**. Probed cause: Wikimedia Codex (like most design
systems) renders the native `<input>` at `opacity: 0` with a styled `<label>` on top —
the walk drops the input as invisible, and a label is not classified interactive. Any
custom checkbox/radio/toggle built this way vanishes from the agent map. Fix direction:
a hidden enabled input with an associated visible label should surface as interactive at
the label's box.

Evidence: `field-visual/<site>/{1-before,2-marks,3-after}.png` + `report.json` in the
session scratchpad.

## Re-run after the two fixes (same day)

Both fixes landed (`snapshot.js`) with regression tests (`test/field-fixes.test.js`, suite
46/46), and the pass was re-run with github and stripe added:

- **Hidden-input proxy: fixed.** A control at `opacity:0` whose associated label is
  visible is kept (labels also stopped counting as their own control's occluder;
  `visibility:hidden`/`display:none` controls are still dropped). On the live page the
  map gained exactly the missing controls: `button "Menú principal"` and all 8
  Apariencia radios, confirmed on the overlay screenshot.
- **Geometry freeze now inherits.** `frozenGeo` propagates from an animating ancestor
  through the walk. **github at-rest false positives: 162 → 0.**
- Stripe stays noisy at rest (276) — the first pass's honest verdict stands: the page
  genuinely keeps settling via JS-driven animation `getAnimations()` cannot see. This is
  the documented limit of zero-config noise, not a walker bug.
- Everything else held: 0 rest noise on wikipedia/lanacion/mercadolibre, 0 privacy leaks
  on all five sites, unobservable regions honestly reported (4/6/3 on the iframe-heavy
  pages).

---

# Free validation round — wide sweep, real MV3, and the priced model experiment

Date: 2026-07-30 · everything below cost $0.

## Wide sweep — 35 sites (`experiment/sweep.mjs`, results in `results/sweep.json`)

The zero-config noise claim, measured beyond hand-picked pages: **18/35 sites report
ZERO changes at rest; the other 17 are almost entirely decorative motion** (marquees,
carousels, settling heros: slack 575, stripe 292, cloudflare 282, react.dev 219,
figma "Marquesina con logotipo" 104). No site failed the walk; 1/36 (zalando) failed to
load at all. Perf on real homepages: inspect p50 958 ms, worst 17 s (wikipedia
Argentina, 19 215 nodes — the known scoping ceiling).

The number that reframes the product's economics: per-turn payload to a model,
**incremental turn p50 = 19 tokens vs 1 365 for a 1280×800 screenshot** (~70× cheaper).
The FIRST turn (full outline) costs MORE than a screenshot on 31/35 sites (p50 13.8 k
tokens, wikipedia 394 k). Conclusion: the outline is a once-per-page cost that needs
scoping/truncation; the diff turns are where the product wins. This also settles the §7
checkpoint-size complaint: the checkpoint is *stored*, never sent — the wire the model
pays for is the diff, and the diff is tiny.

Noise implication: `moved`/`resized` from decorative motion is the dominant FP class in
the wild. A first-class suppression (`noise.ignore` selectors, or scoped inspect roots)
is justified by data, not just by the stripe anecdote.

## Real MV3 extension (`experiment/mv3/`, results in `results/mv3.json`)

The product's actual environment, previously only simulated with `bypassCSP`: a real
MV3 content script in the isolated world, page CSP fully enforced. github + stripe +
wikipedia all pass: walk, capture, checkpoint and rest-gate all work, and
`probeCapabilities` reports `inlineStyles/dataUrls/blobUrls = true` under github's
strict CSP — the isolated-world hypothesis from the first field pass is now measured
fact. (github showed 86 rest FPs here vs 0 in the Playwright pass: it served a
different homepage variant with a JS/video hero — the stripe class of genuinely-moving
page, not an environment difference.)

## Priced model experiment, validated dry (`experiment/realloop.mjs --dry`)

Five real-site tasks (wikipedia search + link-nav, ebay search, python-docs search,
npm search), each proven completable by a scripted golden path before any model pays
for it; success is a URL predicate, never the model's claim. Three arms: screenshot /
oracle / both. Discarded during validation: mercadolibre (captcha wall on results
navigation), lanacion (google vignette interstitial), MDN (A/B-served homepage without
a search input). Budget for the full run (2 reps × ≤5 steps × 3 arms × 5 tasks):
**$1.21 sonnet-5 · $1.81 sonnet-4.6 · $3.02 opus-5 · $6.04 fable-5 · $0.60 haiku-4.5.**
