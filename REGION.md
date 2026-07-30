# The region experiment — image alone vs image + actionables

Date: 2026-07-30 · `claude-opus-5` · real pages, Chromium 1280×800 · API spend: $0.46
Harness: `packages/agent/experiment/region.mjs`

## Why this replaces the Phase-5 framing

Phase 5 asked "did anything change?" over whole synthetic pages, with screenshots and
structure as **rival** arms. Two mistakes:

- snapdom's point is going to the region that matters. Walking `document.body` of
  Wikipedia and concluding "it does not scale" measured the worst case anyone would ever
  ask for, not the product.
- The product is not text *instead of* pixels. It is a **small image of the region plus
  the list of what can be clicked and where**, from one capture and one instant.

So this measures the question an agent actually has to answer, on real pages, and grades
itself against the live DOM with no judge:

> "Give me the (x, y) you would click for &lt;goal&gt;."

A hit is the point landing inside the intended element's box. Same prompt for every arm;
only the evidence differs.

## Result

Three regions (GitHub header, Stripe nav, Wikipedia infobox), 6 goals, 2 repetitions,
12 answers per arm.

| arm | evidence | hits | confidently wrong | tokens / call | $ |
|---|---|---|---|---|---|
| image ×1 | 17–406 KB | 8/12 (67%) | 4 | 781 | 0.069 |
| image ×0.25 | 3–53 KB | **1/12 (8%)** | 8 | 437 | 0.066 |
| actionables | **0.6–10.6 KB** | **12/12 (100%)** | 2 | 2 095 | 0.158 |
| image ×0.25 + actionables | 3.6–63 KB | **12/12 (100%)** | 2 | 2 174 | 0.164 |

Per region (hits out of 4):

| region | image ×1 | image ×0.25 | actionables | pair |
|---|---|---|---|---|
| GitHub header | 2 | 1 | **4** | **4** |
| Stripe nav | 4 | 0 | **4** | **4** |
| Wikipedia infobox | 2 | 0 | **4** | **4** |

## What it says

**Downscaling the image alone destroys the task: 67% → 8%.** It saves tokens and loses
everything, because every pixel of pointing error is multiplied by four. Worse, it is
*confidently* wrong 8 times out of 12 — the failure an agent acts on. Cheap pixels are
not a cheaper version of the same answer; they are a different, much worse answer.

**The actionables list is the piece that carries the task.** 12/12 against 8/12 for a
full-resolution image, in 0.6 KB for a site header. It is the only arm that gives exact
coordinates instead of an estimate.

**The pair did not beat the list on this task, and that is expected.** Pointing is a
localisation problem and the coordinates are already in the text; the image adds nothing
to it. Where the image earns its place is the question this experiment does not ask —
what something *looks like*: is it broken, which one is highlighted, does the layout
look wrong. That is worth measuring separately before claiming the pair is the product.

**The uncomfortable number: the text is not cheaper in tokens.** 2 095 tokens against 781
for the full image, and $0.158 against $0.069 — more than double. Images tokenise by area
(~w·h/750), so a 406 KB screenshot of the Wikipedia infobox is only a few hundred tokens,
while its 151-link JSON is not. In *bytes* the list is 25–38× smaller; in *tokens* it can
be more expensive. The honest claim is precision, not cost: **the list buys accuracy, and
in dense regions it costs more to do it.**

That points at the obvious next move: the list should be scopeable — viewport-only,
top-N, or filtered by role — which would keep the accuracy and remove the token penalty
exactly where it appears.

## Two flaws in the harness, found and fixed / disclosed

**Fixed — grading only worked above the fold.** The first run graded with
`elementFromPoint`, which answers only for the visible viewport. Wikipedia's infobox runs
to y≈2290 on an 800 px viewport, so every answer below the fold scored zero for every arm
— including correct ones. The grade is now geometric (does the point fall inside the
element's box), with `elementFromPoint` consulted only when the point is on screen, to
catch a correct aim at something covered. Wikipedia went from 0/10 to 10/16 across arms.

**Disclosed — La Nación is excluded.** All four arms answered (1204, 342) for
"log in to the reader account", agreeing with each other on the "INICIAR SESIÓN" button,
and all four scored zero: the ground-truth selector was wrong, not the answers. Two more
goals on Mercado Libre never resolved a ground-truth element. Rather than tune selectors
until the numbers improve, they are left out and said so here. N is small: 3 regions,
6 goals, 12 answers per arm, one model.
