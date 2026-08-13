# Directed host + receipt: incremental-value result

Status: **VALID / COMPLETED** on 2026-08-12.

Decision: **no incremental correctness was demonstrated on this fixed, strongly
authored action contract**. The browser receipt added normalized diagnostic evidence,
but it did not reduce false greens, false negatives, or `UNKNOWN` results.

## Primary result

| Arm | Correct | False green | False negative | UNKNOWN | OP_ERROR | Median post evidence | Median reader cycle |
|---|---:|---:|---:|---:|---:|---:|---:|
| Directed host (H) | 15/20 | 0 | 0 | 5 | 0 | 593 B | 0.2 ms |
| Same host + receipt (H+R) | 15/20 | 0 | 0 | 5 | 0 | 1,344 B | 4.3 ms |

The reader-cycle timings are browser-side and descriptive only. The absolute medians
are small, and this design cannot support a speed-superiority claim. Post evidence was
2.27× larger with the receipt. Its additional local baseline checkpoint had a median
size of 1,942 B; the shared directed baseline state was 119 B in both arms.

The combined verifier marked all five intended trials `PASS`, all ten determinate
near-miss trials (wrong-target and occlusion) correctly `FAIL`, and all five
harmful-canvas trials `UNKNOWN`. `UNKNOWN` stayed in the primary denominator and was
not counted as correct against the independent `FAIL` truth.

## What the receipt did and did not prove

Both arms retained the exact same four host predicates: target transition,
wrong-target guard, center-point actionability, and scope observability. The receipt's
`expected: { changed: true }` condition did not replace any of them.

The fixed receipt schema now separates these two questions explicitly:

- `receipt.taskOutcome` was `NOT_ASSESSED` in 20/20 trials. The generic receipt never
  claimed that the user's intended task succeeded or failed.
- `receipt.postcondition.outcome` was `PASS` in 20/20 trials because its declared,
  narrower condition was `changed:true`, and the scoped DOM changed in every case.

That nested postcondition was also `PASS` in the 15 trials whose independent task
oracle was `FAIL`. This is expected and no longer ambiguous in the wire contract:
`PASS` qualifies the generic `changed` postcondition only, while task success remains
explicitly `NOT_ASSESSED`. Consumers must combine the receipt with task-specific host
predicates when they need a task verdict.

The structured body still added useful, bounded facts:

- every wrong-target trial carried a typed content change, though that fact alone did
  not establish that the intended target changed;
- every occlusion trial reported one `becameCovered` entry for **Approve target**;
- every opaque trial reported one `canvas` region as unobservable and raster-available.

Those facts were automatic and normalized, but the strong host already had equivalent
directed checks in this fixture. The measured value is therefore a portable diagnostic
record, not better correctness.

## Integration surface

H+R used the packed, temporarily installed `@zumer/snapdom-receipt` browser package
through exactly two public calls per cycle:

```js
const baseline = createBaseline(root)
const receipt = createReceipt(root, {
  baseline,
  expected: { changed: true },
  limits: { changes: 24, actionability: 12, unobservable: 12 },
})
```

The installed ESM bundle was 38,595 B raw / 14,545 B gzip and declared zero runtime
dependencies. In this embedded same-page fixture it needed no additional browser
permission, CDP/debugger connection, Node runtime, daemon, or browser download.
Playwright was experiment scaffolding only.

## Integrity and limits

- 20/20 paired trials completed, with five repetitions per case and no operational
  errors.
- The independent DOM/hit-test/pixel oracle matched every preregistered truth.
- All trials retained four predicates in both arms; all evidence-byte self-checks
  reproduced.
- The result envelope, current runner, preregistration, and installed bundle hashes
  verified after the run.
- Chromium used a deleted temporary profile. The fixture used OS-assigned loopback port
  52431 (not 8377), which was closed after the run; there were zero non-fixture browser
  requests.

This local deterministic experiment does not estimate commercial demand,
willingness-to-pay, multisite generalization, token cost, authoring savings across UI
changes, browser control, or backend truth. A defensible next question is whether the
standard `becameCovered` and `unobservable` fields materially reduce integration and
maintenance work across changing host schemas; this experiment did not measure that.

Machine-readable result:
`experiment/results/directed-host-receipt-value.json`.

Result payload SHA-256:
`5c6d92e3e4c9cac98cbcd9479dfa536f72d345d2293ac9712da6ec92bb6007b4`.
