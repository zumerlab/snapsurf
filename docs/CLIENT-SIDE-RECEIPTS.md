# SnapDOM Sensor plugin

Status: product hypothesis under test
Evidence cutoff: 2026-08-12 UTC

## Decision

Do not build another browser controller. Freeze features and test SnapDOM Sensor as a
small, stateful plugin for SnapDOM captures.

The plugin's contract is open-ended: the same plugin instance is reused across two
scoped `snapdom()` calls, keeps its semantic baseline in memory, and adds a bounded
`toSensor()` report to the later capture. It receives no action name, expected result,
assertion, or task oracle. It separates semantic changes, rendered actionability, and
uncertainty; it never upgrades those observations into task success or causal proof.

`createBaseline/createReceipt` remain available in the historical compatibility package
when a caller explicitly needs a JSON baseline and a narrow `{changed:boolean}`
postcondition. Their `PASS` is not a task verdict. The plugin instead keeps private local
prior state and emits a descriptive endpoint diff from a normal SnapDOM result.

This is not a claim that SnapDOM is better than Playwright. Playwright remains the
control plane and authored-test default. Its extension can already attach to existing
tabs and reuse logged-in sessions, cookies, and installed extensions. Existing-browser
access is therefore a deployment property, not the differential. See [Playwright's
existing-browser documentation][pw-existing-browser].

## Product boundary

```text
host action or human action
            │
            ▼
existing authenticated tab / webview
            │
            ▼
SnapDOM capture + Sensor plugin
snapdom(scope) → private local prior state → snapdom(scope).toSensor()
                 semantic delta + actionability + uncertainty
              task assessment: NOT_ASSESSED
            │
            ▼
bounded descriptive effect report + regular SnapDOM SVG/exporters
```

The host retains navigation, login, clicks, typing, network interception, tabs, retries,
and orchestration. SnapDOM does not need to know which actuator was used.

The candidate deployment surfaces are:

1. an observer bundled into an existing B2B copilot or extension content script;
2. an Electron/webview preload or isolated world;
3. a browser-agent runtime that already has an actuator and wants a standard descriptive
   effect report;
4. MCP/Playwright as a development adapter, not as the lightweight product.

Electron supports isolated preload contexts and narrowly exposed bridges, so this shape
does not require a browser extension when the buyer owns the application shell. See
[Electron context isolation][electron-isolation] and
[`executeJavaScriptInIsolatedWorld`][electron-isolated-world].

## Evidence already obtained

### 1. The sensor is a separate SnapDOM plugin package

The canonical sensor lives under `packages/sensor` as `@zumer/snapdom-sensor`, separate
from the agent and portable-receipt compatibility package. Its generated ESM is 35,725 B
raw, 13,404 B gzip, and 12,036 B brotli. The tarball is 15,459 B packed / 39,819 B
unpacked, contains five files, exposes `sensor`, `SENSOR_PLUGIN_NAME`, and
`SENSOR_REPORT_CONTRACT`, and declares `@zumer/snapdom >=3.0.0-beta.0 <4` as a peer.
A static bundle scan found no references to the enumerated common egress, Node, or
Playwright primitives; that scan is narrow and does not constrain SnapDOM or the host.

The package still bundles its semantic projection from the repository's top-level `src/`
at build time. At runtime it is a standard SnapDOM plugin: `afterClone` consumes the
prepared capture frame and `defineExports` adds `toSensor()`. SnapDOM is deliberately
unchanged and therefore completes its normal SVG serialization for every endpoint.

The older [footprint result][footprint-result] remains historical evidence for the
pre-sensor surfaces. Its smaller semantic-observer number must not be presented as the
current SKU footprint.

The current all-in-one npm development package still declares Node 22, Playwright, and
esbuild because it contains the daemon, MCP server, CLI, companion, and library together.
Calling that package “Playwright-free” would be false. The browser-only development SKU
now exists and is packable; publication and versioning of that SKU remain release gates.

Playwright itself documents that each version needs matching browser binaries and that
those binaries occupy a few hundred megabytes. That cost is relevant only when a buyer
does not already have Playwright; it is not a reason to replace a Playwright installation
the buyer already operates. See [Playwright browser installation][pw-browsers].

### 2. The companion can read a hermetic pre-authenticated rendered state

The hermetic companion gate establishes an HttpOnly session cookie and `localStorage`
state before asking SnapDOM to observe the tab. It then verifies that:

- the rendered authenticated state and browser-local workspace state are visible;
- observation performs no navigation and does not replay login;
- the HttpOnly credential is unavailable to page JavaScript;
- the credential literal is absent from the semantic response.

This proves the extension path against a temporary local fixture in which the companion
was already installed. It does not prove post-hoc attachment, SSO, a buyer integration,
or access to a person's real Chrome; the project must never use private browser state for
a test. It also does not make rendered DOM authoritative evidence that a backend
transaction succeeded.

### 3. Detection and authored diagnosis did not beat Playwright

The controlled multisite pilot and blind packet review did not establish a verification
advantage. Playwright-authored verification scored 240/240 decisive correct outcomes;
SnapDOM scored 230/240 with ten honest `UNKNOWN` results around sensitive password-value
uncertainty. Those `UNKNOWN` outcomes were conservative: visible contradictions were
already sufficient to fail the authored contract, but uncertainty from a sensitive input
was propagated too broadly. Neither arm produced a false green. In the 192-review
identity-redacted evidence-clarity study,
both arms scored 3/3 mean evidence specificity and exact violated-conjunct accuracy of
1.0; failure-mode accuracy was 0.875 for Playwright and 0.8125 for SnapDOM. The frozen
decision was `HELPER_ONLY`. The original v1 score's source links became stale as its
inputs evolved; [v2][review-v2] re-scores and re-hashes the currently available inputs.
Those assignment/response files still live outside the repository, so the v2 provenance
is current but not yet an immutable archive.

That negative result is important. SnapDOM cannot be sold as a generally more accurate
assertion system. Its remaining hypothesis is deployment and selective evidence egress.

### 4. A receipt did not improve correctness over a strong fixed host

In the [directed host experiment][directed-host-value], H and H+receipt retained the same
four predicates and tied at 15/20 correct, zero false greens, zero false negatives, five
`UNKNOWN`, and zero operational errors. Median post evidence was 593 B versus 1,344 B
(2.27×); descriptive reader-cycle wall time was 0.2 versus 4.3 ms.

The distinction between telemetry and task truth was decisive. The receipt reported
`taskOutcome: NOT_ASSESSED` in 20/20, while its narrower `changed:true` postcondition
passed 20/20—including the 15 trials where the independent task oracle said the intended
task failed. It automatically emitted typed changes, `becameCovered`, and canvas
`unobservable` evidence in 5/5 relevant trials, but the strong host already had equivalent
directed checks. The measured decision is **no incremental correctness on this fixed
strong contract**.

### 5. Schema drift did not establish a maintenance advantage

The preregistered [schema-drift experiment][schema-drift-value] compared one reusable
generic host reader with the installed SDK across native markup, wrappers, remounts, a
legitimate role/name change, and a control changing from button to switch. The host was
exact in 15/15 trials and all five variants; the SDK was exact in 9/15 and three variants.
Both paths used zero variant-specific adapters.

The SDK integration block was shorter (17 physical runtime LOC versus 64), which is a
one-time buy-versus-build signal for a host that owns no equivalent reader. It is not a
maintenance win: on legitimate semantic changes the receipt reported added/removed or
ambiguous replacement nodes but omitted the new endpoint state and status-content facts
required by the frozen telemetry contract. The current decision is **no maintenance
advantage; telemetry lost on semantic drift**. The fixtures are authored, not a production
holdout, and were not repaired/re-run after this result.

### 6. The SDK supports small post-action egress, not a smaller full cycle

The historical [SDK egress repeat][egress-v3-result] packed and installed the portable
receipt compatibility SKU and retained 96 raw bodies in a
[gzip archive][egress-v3-artifacts]. Sixteen primary trials
matched exact directional contracts in the ARIA evidence, official receipt, and a
separate primitive DOM oracle. A separate [directional audit][egress-v3-audit] re-read all
bodies and verified banner, badge, and status transitions plus receipt caps and nested
postcondition semantics.

| Actionables | ARIA post | SDK receipt post | ARIA / receipt | SDK baseline | Full SDK cycle / ARIA cycle |
|---:|---:|---:|---:|---:|---:|
| 51 | 5,766 B | 1,059 B | 5.44× | 22,777 B | 2.07× |
| 251 | 29,016 B | 1,059 B | 27.40× | 111,933 B | 1.95× |
| 1,001 | 116,766 B | 1,059 B | 110.26× | 454,395 B | 1.95× |
| 3,001 | 356,766 B | 1,059 B | 336.89× | 1,390,087 B | 1.95× |

The result is useful and narrower than the earlier companion result. The official receipt
body stayed at 1,059 B across all four scales, but the local baseline grew from 22,777 B to
1,390,087 B. Counting baseline and post together, the SDK cycle was roughly 1.95–2.07×
the two ARIA bodies. There is no total-byte or speed win. The value proposition exists only
when the baseline remains inside the client and only the receipt crosses a process,
network, or model boundary over multiple actions.

The current receipt caps item arrays and reports `total` and `truncated`; this is not a
strict byte ceiling. In a separate 16-trial stress, growing canvas/opaque regions from 0
to 300 increased the receipt from 561 B to 1,893 B. At 300 it returned 12 details,
`total:300`, and `truncated:288`, with an honest `UNKNOWN`. The baseline remained uncapped
and grew to 31,805 B.

The experiment does **not** establish incremental computation, speed, token savings, or
equivalent evidence. SnapDOM still walks the document and returns a digest plus typed
delta and uncertainty; ARIA returns the whole accessibility snapshot. The result is a
deployment/evidence-width signal, not a general Playwright comparison.

## Why the combination may be commercial

Most components are commodities in isolation. Playwright already has current-state
assertions, actionability checks, element screenshots, automatic semantic snapshots, and
tracing. Its MCP documentation estimates roughly 200–400 tokens for the illustrated
snapshot, so a generic “snapshots are huge” story is not credible without matched
measurement. See [Playwright snapshots][pw-snapshots],
[actionability][pw-actionability], and [tracing][pw-tracing].

The less common combination under test is:

- embedded in the buyer's existing client runtime rather than controlling the browser;
- typed pre/post effects rather than only current state;
- resident `observation.scopeStatus: INDETERMINATE` plus explicit uncertainty when canvas,
  iframe, sensitive values, or capture integrity prevent a safe negative description;
- caller-specified redaction before the effect report crosses the client boundary;
- no matches for the enumerated common egress primitives in the generated SDK bundle;
  the scan is not exhaustive and does not constrain the host;
- a small, versioned effect report instead of a full replay stream.

The sensor and portable compatibility receipt are now separate packages. The resident
report has capped item fields and `taskAssessment.status: NOT_ASSESSED`; only the legacy
`createReceipt` API evaluates its narrow declared postcondition as `PASS | FAIL | UNKNOWN`.
That closes a packaging-boundary gap, not the value gap: the strong-host A/B tied and the
historical OEM gate below remains synthetic.

The best initial buyer is therefore a vendor of an in-browser B2B copilot or extension
that already acts inside authenticated SaaS pages and does not want to add a second
browser, a daemon, or `debugger` merely to verify each action. If that vendor already
uses CDP/Playwright everywhere and is satisfied with its assertions, SnapDOM is likely
redundant.

## Permission boundary

Avoid claiming “permissionless.” The current companion requests `tabs` and injects a
content script on `<all_urls>`, which creates real trust friction. Chrome recommends
requesting the narrowest permissions and documents `activeTab` as temporary access after
a user gesture with no install warning. See [Chrome `activeTab`][chrome-active-tab] and
[permission guidance][chrome-permissions].

The primary OEM path should add no new extension permission when the buyer already owns
the relevant content script. A standalone reference extension should use explicit sites,
optional host permissions, or `activeTab` rather than universal access. Avoiding
`debugger` is meaningful but not sufficient on its own: Chrome describes `debugger` as
a CDP transport and notes that it triggers a warning. See
[`chrome.debugger`][chrome-debugger].

## SKU under test

Working product name: **SnapDOM Sensor**. The canonical development package is
`@zumer/snapdom-sensor`; `@zumer/snapdom-receipt` remains a historical compatibility
package. Publication remains unauthorized.

Primary packed API:

```js
import { snapdom } from '@zumer/snapdom'
import { sensor } from '@zumer/snapdom-sensor'

const effectSensor = sensor({
  privacy: { redact: ['account@example.com'] },
  limits: { changes: 24, actionability: 12, blindSpots: 12 },
})
const card = document.querySelector('#checkout-card')

await snapdom(card, { plugins: [effectSensor] })

// A host, another agent, page code, or a person acts here. The sensor is not told what.

const capture = await snapdom(card, { plugins: [effectSensor] })
const effect = await capture.toSensor()
```

`effect` is versioned and JSON-safe. It has
`effect.taskAssessment.status === 'NOT_ASSESSED'`, not a postcondition, and
`effect.causality.status === 'NOT_ESTABLISHED'`; bounded semantic/actionability/blind-spot
arrays with `total/truncated`; and explicit frame provenance. The private baseline is a
detached in-memory graph, not a checkpoint. The capture itself is normal SnapDOM: its SVG
and on-demand image exporters remain on `capture`. Scope is the element passed to
`snapdom()`; there is no browser-wide sensor root or mutation radar in this plugin v1.

The compatibility `createBaseline/createReceipt` API is still exported for callers that
need a portable checkpoint. Its v1 postcondition is intentionally only
`{changed:boolean}` and remains distinct from task success. It serializes the baseline,
so it is not the resident fast path.

The distinction is deliberate: a page can change while the intended task fails, targets
the wrong element, or produces an unwanted side effect. A `changed` postcondition `PASS`
must never be consumed or marketed as task success.

The browser package must have:

- no bundled runtime dependency beyond its declared SnapDOM peer;
- no Node, Playwright, daemon, browser download, CDP, or `debugger` requirement;
- no matches for the enumerated `fetch`, XHR, WebSocket, beacon, Node, or Playwright
  patterns in the generated bundle, with this explicitly treated as a narrow static gate;
- a versioned sensor-report schema; portable checkpoint/receipt schemas remain in the
  separate compatibility package;
- explicit limits and truncation metadata for caller-data-bearing item arrays, plus
  bounded copied strings;
- a privacy contract that states literal redaction is not automatic DLP.

The existing MCP package remains a reference adapter and dogfood surface. It is not the
artifact used to substantiate the lightweight claim.

### A historical portable-receipt OEM gate passed in one synthetic fixture

The [OEM embed gate][oem-embed-gate] packed and installed
`@zumer/snapdom-receipt` into an existing synthetic isolated content script. The package
was 15,587 B packed / 40,254 B unpacked; its 38,595 B bundle matched the checked-in SDK
SHA and declared zero runtime dependencies. Before/after manifest permission surfaces
were identical (`{}` delta), one official receipt crossed content-script → service-worker
→ extension-page, and no secret literal appeared.

This historical gate predates the current plugin package: it used the older 38,595 B
portable-receipt build, not the current 35,725 B sensor ESM. It proves mechanical
embedding of that build without an added permission in one loopback fixture. It does not
gate the current resident build or prove an exact shared tarball archive, a real buyer, real
origins/SSO, store review, reliability, or willingness to pay.

### Standalone sensor package proof

The standalone sensor package smoke passes from the packed and installed tarball, not
from repository imports. The checked-in ESM is 35,725 B raw, 13,404 B gzip, and 12,036 B
brotli. Its package contains five files, is 15,459 B packed / 39,819 B unpacked, has no
bundled runtime dependency, declares SnapDOM as a peer, and exposes exactly three symbols.
Its tarball smoke installs both packages in an isolated temporary Chromium profile,
performs two standard SnapDOM captures, retains the regular SVG result, and verifies a
two-change descriptive `toSensor()` report.

A static scan of the generated bundle found no references to the enumerated `fetch`,
`XMLHttpRequest`, `WebSocket`, `sendBeacon`, Node-import, or Playwright patterns. This is
a narrow static check, not an exhaustive proof that all possible network primitives are
absent, and it does not constrain the host application around the SDK. Playwright appears
only in the repository test harness; it is absent from the packed package and runtime.

## Keep/kill scorecard

The sensor SKU survives only if every safety gate and at least one value gate passes.

### Safety and deployment gates

- the sensor plugin never emits task `PASS`/`FAIL`; the portable compatibility verifier
  has zero false greens in the frozen deterministic suite;
- zero secret literals in resident reports, compatibility receipts, and public artifacts;
- current browser ESM at most 25 KiB gzip;
- no bundled runtime dependency beyond SnapDOM and no enumerated built-in network
  primitive in the sensor bundle;
- no second browser, Node process, CDP, or `debugger` in the embedded path;
- resident blind regions produce `INDETERMINATE` plus uncertainty rather than a clean
  negative; portable compatibility assertions return `UNKNOWN`, not `PASS`;
- embedded raw trials plus runner and bundle hashes make each published measurement
  auditable within its stated cleanup and provenance limits.

### Value gates

At least one:

- selective evidence: preregister a material ratio against a matched full-state reader,
  then report the private prior-state footprint, serialized effect report, and blind-region
  behavior separately;
- diagnosis: at least +0.5/3 mean specificity over the same strong host;
- authoring: at least 30% fewer verifier tokens for the same frozen contract and no
  correctness loss;
- deployment: a buyer's existing extension or preload can integrate the SDK without a
  new privileged permission or auxiliary process.

### Historical mark/read prototype (not the current plugin)

The following measurements belong to the abandoned standalone `mark/read` prototype.
They must not be used as timing, size, SVG, or behavior claims for the standard SnapDOM
plugin implemented now. The [resident sensor v2 probe][resident-sensor-v2] held the
semantic scope fixed at 54
elements while surrounding it with 100, 1,000, or 10,000 adversarial `label[for]`
elements. Each scale ran 30 measured windows. All 90 reports contained exactly the two
directional changes, zero reported known-blind-spot items (`exhaustive:false`), no
actionability change, no uncertainty, and no task verdict. `JSON.stringify(report)` was
exactly 2,507 UTF-8 B at every scale; no transmission occurred, and the private
prior-state graph never appeared in the opaque two-byte handle or report.

Median renderer `TaskDuration` for mark plus read was 2.010, 2.047, and 2.409 ms; the
largest p95 wall time was 2.355 ms. Retained-heap p50 was 76,660 B at all three scales,
but that forced-GC heap delta is diagnostic, not an exact allocation measure. An exterior
mutation was detected as count-only activity and its secret text did not enter the
report. No external HTTP request, port, or personal Chrome state was used. Serialized
reports contained no SVG/raster payload and declared `visual.raster: NOT_CAPTURED`;
separate implementation tests, rather than this timing run, guard that `mark/read` do not
call SVG/canvas serialization.

The preserved [v1 development run][resident-sensor-v1] and code inspection found a real
architecture defect: shadow-root discovery traversed the entire sensor root. V1 measured
160.71% growth in p50 mark+read renderer `TaskDuration`; after restricting discovery to
the paid scope, V2 measured 19.88%. These two single runs do not by themselves attribute
the whole difference to that repair. Neither had a preregistered performance threshold,
so this is not a speed or asymptotic-complexity claim.

For the same 54-element effect, the older portable API emitted a 5,630 B baseline plus a
782 B receipt (6,412 B total), 2.56× the resident report. That is a wire-ready artifact
comparison, not network egress and not a general comparison against ARIA or Playwright.

The current plugin has only passed its mechanical package and integration smoke. The
fixed-contract A/B still showed no incremental correctness, and schema drift still lost
telemetry on two legitimate semantic changes in the older receipt path. Commercial value
remains unproven. Features remain frozen while the standard plugin is tested in a real
host workflow; if it provides no integration or diagnostic benefit there, keep it as an
optional SnapDOM helper and stop product expansion.

## What not to build now

Do not add settle, crops, stable IDs, flight recording, generic automation, or a replay
dashboard merely because each sounds useful. Those capabilities already have mature
alternatives and do not repair a missing commercial wedge. A new capability becomes
eligible only after the browser sensor survives the gates above and the feature changes
a measured buyer workflow.

[footprint-result]: ../experiment/results/client-side-footprint.json
[egress-result]: ../experiment/results/client-side-egress-v2.json
[egress-artifacts]: ../experiment/results/client-side-egress-v2.artifacts.json.gz
[egress-directional-audit]: ../experiment/results/client-side-egress-v2.directional-audit.json
[review-v2]: ../experiment/results/multisite-review-v2.json
[directed-host-value]: ../experiment/results/directed-host-receipt-value.json
[oem-embed-gate]: ../experiment/results/oem-embed-gate.json
[egress-v3-result]: ../experiment/results/client-side-egress-v3.json
[egress-v3-artifacts]: ../experiment/results/client-side-egress-v3.artifacts.json.gz
[egress-v3-audit]: ../experiment/results/client-side-egress-v3.directional-audit.json
[schema-drift-value]: ../experiment/results/schema-drift-receipt-value.json
[resident-sensor-v1]: ../experiment/results/resident-sensor-value.json
[resident-sensor-v2]: ../experiment/results/resident-sensor-value-v2.json
[pw-existing-browser]: https://playwright.dev/mcp/configuration/browser-extension
[pw-browsers]: https://playwright.dev/docs/browsers
[pw-snapshots]: https://playwright.dev/mcp/snapshots
[pw-actionability]: https://playwright.dev/docs/actionability
[pw-tracing]: https://playwright.dev/docs/trace-viewer
[electron-isolation]: https://www.electronjs.org/docs/latest/tutorial/context-isolation
[electron-isolated-world]: https://www.electronjs.org/docs/latest/api/web-contents/#contentsexecutejavascriptinisolatedworldworldid-scripts-usergesture
[chrome-active-tab]: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
[chrome-permissions]: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
[chrome-debugger]: https://developer.chrome.com/docs/extensions/reference/api/debugger
