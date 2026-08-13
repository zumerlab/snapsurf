# Directed host + receipt: fair incremental-value protocol

Status: **COMPLETED / VALID** on 2026-08-12. The unified `createBaseline` /
`createReceipt` API became available after this protocol was frozen, and the browser
run used that packed API exactly. Results are reported in
`experiment/results/directed-host-receipt-value.md` and the machine-readable
`experiment/results/directed-host-receipt-value.json`.

## Question

On a large rendered page with a local action contract, what incremental verification
value does a browser-only receipt add to an already-strong directed host verifier?

This is **not** a Playwright comparison. Playwright is only the isolated test harness.
Both arms read the same page after the same fixture action:

- **H:** four explicit, JSON-safe directed checks.
- **H+R:** the exact same four checks, plus the unified browser receipt.

The four shared predicates are target transition, wrong-target guard, center-point
actionability, and scope observability. The receipt cannot replace or weaken them. It
may only add typed evidence or conservatively change a result to `UNKNOWN` when it
reports an evidence gap. The MVP's `expected.changed` contract cannot express the rich
predicates, so it is never treated as proof that the right target changed.

## Cases and oracle

Each case runs five times on a fresh page with 3,000 unrelated cards:

1. intended local transition (`PASS` truth);
2. neighbor changes instead (`FAIL` truth);
3. target changes but a new overlay intercepts the target action (`FAIL` truth);
4. target changes but a new canvas carries a harmful red pixel inside the operation
   scope (`FAIL` truth; both arms should honestly return `UNKNOWN` because neither
   semantic verifier inspects raster pixels).

A separate primitive oracle reads target/neighbor text, calls `elementFromPoint`, and
reads the canvas pixel. It does not call either verifier or the receipt SDK. Any
oracle/preregistration mismatch invalidates the run.

## Metrics

Primary denominator: all 20 scheduled paired trials, including `UNKNOWN` and
operational errors.

- correctness;
- false greens;
- false negatives;
- `UNKNOWN` count.

Secondary evidence records exact UTF-8 JSON bytes, shared predicate count, host and
receipt API calls, installed package dependency fields, bundle bytes/hash, browser
permission requirement, and descriptive browser-side wall time. Wall time cannot
support a speed-superiority claim.

## Isolation and provenance

The runner npm-packs and installs the SDK in a temporary directory with dev
dependencies omitted, launches only an isolated temporary Chromium profile, serves a
deterministic fixture on an OS-assigned loopback port that is rejected if it equals
8377, rejects non-fixture browser requests, hashes the runner/preregistration/tarball/
installed bundle/result, closes the server, and deletes the profile. It never opens or
reads personal Chrome state.

## Reproduce with the unified API

```sh
node experiment/directed-host-receipt-value.mjs
```

The observed outcome was a correctness tie: 15/20 for each arm, with zero false greens,
zero false negatives, five `UNKNOWN`, and zero operational errors. Accordingly the
registered decision is **no incremental correctness on a fixed, well-authored
contract**. The following interpretation rules remain applicable:

- A correctness tie means **no incremental verdict value on a fixed, well-authored
  contract**; any receipt advantage must be limited to standardized evidence and its
  costs.
- Fewer false greens without more false negatives supports incremental primary value.
- This local fixture cannot establish commercial demand, willingness to pay, multisite
  generalization, token savings, or browser-control capability.

Machine-readable preregistration:
`experiment/results/directed-host-receipt-value.preregistration.json`.

Prepared runner: `experiment/directed-host-receipt-value.mjs`.
