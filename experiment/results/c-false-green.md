# Phase C — Internal false-green fixture

2026-08-01 · `experiment/c-false-green.mjs` · app `demo-qa/silent-failures.html`, which
carries deliberate ambient noise (a live clock, a spinner, a ticker) · agent-browser
0.33.1 · perceptual pixel comparison (pixelmatch class, @zumer/snapdiff).

Eight actions that **look** as if they worked. An independent judge —
`window.__intent()`, which reads the real DOM state without going through any channel —
says what actually happened. Only the stated-expectation arm receives the case-specific
intended outcome. The other arms receive a weaker generic change question, so this is an
internal product-design experiment, not an equal-intent tool comparison.

## Result

| Channel | Right | **WRONG SUCCESS** | wrong failure |
|---|---:|---:|---:|
| **SnapDOM assertion with the case-specific postcondition** | **8/8** | **0** | 0 |
| SnapDOM `changed` check only | 4–6/8 † | 2–4 | 0 |
| agent-browser `diff snapshot` (as it ships) | 2/8 | 6 | 0 |
| agent-browser with references normalized away | 2/8 | 6 | 0 |
| Screenshot (perceptual pixel comparison) | 2/8 | 6 | 0 |

**The historical internal difference is 0 against 6 wrong success reports out of 8
cases. It is withdrawn as a competitive headline.** It demonstrates that an explicit
postcondition is stronger than a generic change signal on these authored fixtures. It
must not be read as a head-to-head result against Playwright Test (or any other system)
given the same postcondition: only the stated-expectation arm received that intent here.
See [`../../docs/VALUE-COMPARISON.md`](../../docs/VALUE-COMPARISON.md) for the
equal-intent protocol and the first descriptive focal.

† **The raw "did anything change?" arm is NOT stable between runs.** The first run scored
6/8 with 2 wrong successes; the re-run on 2026-08-01 scored 4/8 with 4. It depends on what
the page's ambient noise happens to do at that moment — which is exactly what these cases
simulate. The stated-expectation arm scored 8/8 with 0 wrong successes in both runs. This
supports the narrower conclusion that asking "did anything change?" is inherently
unstable under noise. Whether this product checks a stated expectation more effectively
than Playwright must be measured separately with identical intent.

## Per case

Rows below are from the first run, where the raw arm scored 6/8.

| # | Planted failure | Truth | stated expectation | raw "changed?" | agent-browser | pixel |
|---|---|:---:|:---:|:---:|:---:|:---:|
| F1 | plain no-op | ✗ | ✓ FAIL | ✓ | ✗ says it changed | ✗ 0.118% |
| F2 | submit rejected silently | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0.182% |
| F3 | click swallowed by an overlay | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0.082% |
| F4 | notification already gone | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0.112% |
| F5 | worked, but out of view | ✓ | ✓ PASS | ✓ | ✗ cannot tell | ✗ 4.9% |
| F6 | state change with no visual difference | ✓ | ✓ PASS | ✓ | ✗ cannot tell | ✗ 3.9% |
| F7 | double effect (inserted 2, not 1) | ✗ | ✓ FAIL | ✗ says fine | ✗ | ✗ 3.8% |
| F8 | half-hydrated single-page navigation | ✗ | ✓ FAIL | ✗ says fine | ✗ | ✗ 3.9% |

## What to read carefully

**1. The value is not the comparison, it is the stated expectation.** Our own raw
"did anything change?" produces wrong success reports (F7: two rows were inserted and
"something changed" is true; F8: the URL changed and the content never arrived). The
channel that reaches 0 is the one that checks the outcome you intended. This confirms by
measurement what we already suspected: **a bare `changed:true` is a smoke signal, not an
assertion**. The defensible finding is that a verifier needs the intended postcondition,
not merely "a better diff"; whether this runtime supplies that layer more effectively
than Playwright remains the separate equal-intent question.

**2. The other channels were asked a different question.** The pixel comparison detects
movement, and there is always movement here because the clock runs. The historical
agent-browser arm returned a text diff for the runner to interpret. This experiment did
not give either arm the same postcondition through Playwright assertions, custom code, or
another verifier. It therefore says nothing about how those implementations perform
when the missing decision layer is supplied.

**3. The two cases that separate everything are the uncomfortable ones**: F7, where the
action worked *too much*, and F8, where the navigation started and never finished. Both
are "something happened" for any change-detection channel, and only an assertion carrying
intent — `maxChanges`, `urlIncludes` plus `exists` — tells them apart from a success.

## Measurement hygiene (four bugs of our own, fixed before believing anything)

This phase produced different results across five runs. All four errors were mine:

1. **The pixel comparison always returned 0.000%** — `diffPixels` was called with
   `ImageData` instead of the raw buffers, returned `undefined`, and that read as 0. Fixed
   by copying the exact call from the pixel arm of `bench-qa`.
2. **A programmatic `element.click()`** goes straight through hit-testing, so F3 (the
   intercepted click) reported "it happened". Fixed to a real mouse click.
3. **A real click by page coordinates** left buttons below the fold outside the viewport,
   so the click landed on nothing and all 8 cases reported "nothing happened". Fixed with
   auto-scroll plus `force:true`, which skips Playwright's own checks but **not** the
   browser's hit-testing, which is what F3 needs.
4. **An unfair asymmetry**: agent-browser received the action through `eval`
   (programmatic) while we used a real click. Levelled: all three channels now use their
   own tool's real click.

And a fifth, conceptual one: the judge was measuring *"did anything mutate?"* instead of
*"did the intended outcome happen?"*. Under the first definition, F7 and F8 counted as
successes — which is precisely the error this experiment exists to detect.

## Reproducing

```bash
npm install -g agent-browser
node experiment/c-false-green.mjs
```

Raw per-case data: [`experiment/results/c-false-green.json`](c-false-green.json).
