# snapDOM Agent

snapDOM Agent contains SnapDOM Sensor, a stateful plugin for rendered web pages. A caller
reuses one plugin instance across normal, scoped SnapDOM captures. The plugin keeps a
private semantic baseline and adds a bounded `toSensor()` report with typed effects:
`added`, `removed`, `content`, `state`, `style`, `moved`, `resized`, rendered
actionability changes, and explicit uncertainty.

The report compares capture endpoints. It does not attribute a change to an actor
(`causality.status === 'NOT_ESTABLISHED'`) and does not decide whether the actor's task
succeeded. SnapDOM still performs its normal SVG capture; the sensor stores only its
detached semantic graph as prior state.

The current goal is reliability, not distribution. The package is private and the
license in `LICENSE` applies.

## Where it fits

SnapDOM Agent is a perception/evidence layer, not a replacement for Playwright.
Playwright remains the default for browser control and authored tests: its locators,
auto-waiting, network tooling, tracing, screenshots, and cross-browser support are much
broader and more mature. Playwright Test also has retrying assertions for element state,
text, value, URL, CSS, screenshots, and ARIA snapshots. Playwright MCP, when started with
its testing capability, has direct verification tools and returns a current accessibility
snapshot after interactions.

The sensor hypothesis is that a host already using SnapDOM can obtain a typed before/after
diff, rendered actionability evidence, known blind spots, and explicit uncertainty from
the same scoped capture result. The sensor does not verify the host's task.

Separately, the historical MCP verification path was tested against Playwright. A first
hermetic MCP-to-MCP probe gave both tools the same four local postconditions, each as a
correct effect and a deterministic near miss. Playwright out of the box, Playwright with
custom evaluation, and SnapDOM each matched the frozen expected-truth manifest in all 24 route
trials (72 total), with no false green, false negative, or `UNKNOWN`. SnapDOM used one
uniform declarative verification call; Playwright used zero to two out-of-box calls or
one custom-JavaScript call. On the same 24-trial set, median effective full-flow bytes
were 2,557.5 for Playwright out of box, 5,288 for SnapDOM, and 3,330.5 for custom
evaluation; median full-flow rounds were 3.5, 3, and 3. Playwright was usually smaller,
so this establishes a one-call typed assertion surface—not superiority.

In five immediate repetitions of the aligned six-effect focal, Playwright Test and
SnapDOM each passed all 30 authored successful effects. SnapDOM used fewer caller-visible
probes and returned structured success/failure evidence automatically, but its successful
envelopes were much larger. The cases had no controlled near misses or independent hidden
oracle, and the retry and observation surfaces still differ, so the repetitions do not
establish a performance or accuracy advantage.

A fair comparison must give both implementations the same frozen postcondition and allow
Playwright to use those native capabilities or custom predicates. Playwright Test versus
the core library and Playwright MCP versus SnapDOM MCP are separate questions; results
from one must not be used as evidence for the other.

The MCP runner, raw wires and report live in [`experiment/mcp-value.mjs`](experiment/mcp-value.mjs)
and [`experiment/results/mcp-value.md`](experiment/results/mcp-value.md). The evidence,
fairness correction to the older false-green experiment, equal-intent protocol, and
explicit keep/kill gates live in [`docs/VALUE-COMPARISON.md`](docs/VALUE-COMPARISON.md).

## SnapDOM Sensor plugin

The development plugin lives separately under `packages/sensor`. Its generated ESM is
35,725 B raw / 13,404 B gzip, contains no Node, Playwright, CDP, MCP or browser controller,
and declares SnapDOM v3 as its only peer dependency.

```js
import { snapdom } from '@zumer/snapdom'
import { sensor } from '@zumer/snapdom-sensor'

const effectSensor = sensor({
  privacy: { redact: ['account@example.com'] },
})
const card = document.querySelector('#checkout-card')

await snapdom(card, {
  plugins: [effectSensor],
})

// Another agent, page code, or a person acts. SnapDOM is not told what to expect.

const capture = await snapdom(card, {
  plugins: [effectSensor],
})
const effect = await capture.toSensor()

console.log(effect.taskAssessment) // { status: 'NOT_ASSESSED' }
console.log(effect.observation.semanticDelta)
console.log(effect.observation.renderedActionabilityDelta)
console.log(await capture.toPng()) // regular SnapDOM export remains available
```

The same plugin instance is the private baseline. The caller scopes work by passing the
smallest useful element directly to `snapdom()`. `toSensor()` is descriptive and bounded;
it accepts no expected result and never means the task succeeded. Because this design uses
SnapDOM unchanged, each endpoint is a full SnapDOM capture and includes its SVG result.
Historical resident `mark/read` measurements remain development evidence for an abandoned
prototype and are not performance evidence for this plugin.

## Install and verify

Requires Node.js 22 and Chromium for Playwright-backed modes.

```bash
npm ci
npx playwright install chromium
npm test
npm run test:lint
npm run test:bundles
```

`npm test` runs the real-browser core suite and the isolated daemon/MCP regressions.
`npm run test:cold` copies only files currently tracked by git into a temporary
directory, installs dependencies and Chromium into empty task-owned locations, and
repeats the checks. Untracked working-tree files are deliberately absent, so a cold pass
does not validate them.

A GitHub Actions workflow is prepared at `.github/workflows/ci.yml`, but it is currently
untracked and has not run in GitHub Actions. CI must not be described as active or
verified until that workflow is committed and completes there.

## Library

```js
import { agent } from '@zumer/snapdom-agent'

const before = await agent.inspect(document.body)
const checkpoint = before.checkpoint()

await doSomething()

const ui = await agent.inspect(document.body, {
  previous: checkpoint,
  noise: 'agent', // 'agent' | 'none' | custom rules
  privacy: { redact: ['Jane Doe', 'account@example.com'] },
})

console.log(ui.changed)
console.log(ui.changes)
console.log(ui.actionabilityDelta)
console.log(ui.unobservable)
```

Queries and element resolution use the same observation:

```js
const save = ui
  .getByRole('dialog', { name: 'Settings' })
  ?.getByRole('button', { name: 'Save' })

const element = agent.resolve(save)
```

The library observes and resolves; it does not click or type. Capture plugins supplied in
`capture.plugins` are composed with the oracle rather than replaced.

Checkpoints are compact, JSON-serializable wire objects. Version 2 uses length-framed
hashes and a columnar node representation. Version 1 is rejected explicitly because its
hashes cannot be upgraded honestly. Treat every persisted checkpoint as sensitive: it
contains structural and state evidence, and ordinary filled fields include a
deterministic fingerprint that can be tested against guesses.

## CLI and daemon

Start one local daemon, then use short commands from other processes:

```bash
node tools/browse.mjs serve
node tools/browse.mjs open example.com
node tools/browse.mjs find "Sign in"
node tools/browse.mjs click n_example
node tools/browse.mjs look
node tools/browse.mjs stop
```

`node tools/browse.mjs help` prints all verbs. Useful groups:

```text
open <url>                 navigate and establish a baseline
look [id]                  diff, or inspect one subtree
find <text>                ranked whole-page search
text <id>                  full text for one element
click <id|x,y>             act, then use look/assert
type <text> · enter
assert '<json>'            evaluate a postcondition
cp save|list|diff <name>   named checkpoints
map [offset] · outline · parent <id>
snap [id] [file.png] · shot [file.jpg]
session open|list|close
status · stop
```

Policies are fail-closed at daemon startup:

```bash
node tools/browse.mjs serve --readonly
node tools/browse.mjs serve --allow example.com,static.example.com
node tools/browse.mjs serve --redact "Jane Doe,account@example.com"
```

Unknown flags refuse to start. Redaction policy, revisions, baselines, ids, checkpoints,
and command queues are session-scoped. Each session owns an isolated BrowserContext, so
cookies, storage, permissions, workers and popup trees do not cross sessions. Closing it
closes every page it created.

The HTTP control plane binds to loopback and uses a private per-process token. CLI and
MCP verify an HMAC challenge before sending command data, then authenticate the exact
request and response with one-time nonces. The discovery token file, logs, checkpoints
and generated captures use private filesystem permissions. The security boundary is the
local operating-system user, not mutually hostile processes running as that same user.
Logs go to `logs/`, which is ignored by git.

An assertion spec can combine:

```json
{
  "changed": true,
  "mustInclude": [{ "kind": "added", "role": "dialog", "selector": "#settings" }],
  "mustNotInclude": [{ "kind": "removed" }],
  "only": [{ "role": "dialog" }],
  "maxChanges": 3,
  "exists": "Settings",
  "notCovered": "Save",
  "becameVisible": "Save",
  "ignore": [".marquee", "#clock"],
  "retry": { "budgetMs": 2000 },
  "keepBaseline": true
}
```

Empty specs, unknown keys, malformed matchers, invalid selectors, and missing baselines
fail with a reason. A selector matcher is checked exactly; it cannot pass because some
unrelated element changed.

## MCP server

Register the local server with an MCP client:

```bash
claude mcp add --scope user snapdom-agent -- node /ABS/PATH/snapdom-agent/mcp/server.mjs
```

The server starts and owns the daemon when necessary. It exposes:

- `browser_open`, `browser_find`, `browser_act`
- `browser_verify`, `browser_assert`
- `browser_checkpoint`, `browser_diff`, `browser_text`, `browser_page`
- `browser_screenshot`
- `browser_session_open`, `browser_session_close`, `browser_session_list`

Pass `sessionId` on every call in a multi-session flow. Routing metadata stays outside
assertion specs. Screenshot temporary files are private per request and deleted after the
response is encoded.

## Chrome companion

The companion observes the user's existing Chrome without CDP. Build and load it:

This mode can see the selected tab's authenticated page state. The current product
validation does **not** use it: all dogfood and automated gates use isolated temporary
Chromium contexts. Do not point the companion at a personal profile, tab, cookie store,
session, history, password store, or extension set without the browser owner's explicit
authorization.

```bash
node companion/build.mjs
```

Load `companion/` unpacked at `chrome://extensions`. Requests are accepted only from
extension ids in `companion/manifest.json`; ordinary page JavaScript cannot call it. The
authenticated path is:

```text
allowlisted consumer extension
  → companion service worker
  → chrome.tabs.sendMessage(frameId: 0)
  → isolated content script
```

From an allowlisted extension context:

```js
const reply = await chrome.runtime.sendMessage(
  'cgkacingkmbmhpmffioljbcfjimjhjig',
  {
    channel: 'snapdom-companion-v1',
    tabId,
    request: { type: 'SNAPDOM_OBSERVE', obsId: crypto.randomUUID() },
  },
)
```

Results never travel through `window.postMessage`, a page-owned DOM node, or a marker.
Privacy is sticky per tab in `chrome.storage.session`; only an authenticated client can
clear it. See `companion/PROMPT-extension.md` for the full protocol.

Run the hermetic adversarial gate after any companion change:

```bash
node companion/gate.mjs
```

It loads fixed-id companion and client extensions against a local hostile page and iframe
and verifies response authenticity, privacy persistence, semantic changes, assertions,
and rejection of the former page/DOM channels.

## Global machine copy

For a fixed local path independent of the checkout:

```bash
node tools/install-global.mjs
```

This writes the daemon, MCP server, SDK bundle, and companion runtime (`manifest.json`,
`worker.js`, `content.bundle.js`) under `~/.claude/snapdom-agent/`, plus the user-level
agent-browse skill. Re-run it after source changes. Installation mutates `~/.claude`, so
it is not part of the repository's default test suite.

## Honesty boundaries

- Canvas pixels, iframe documents, and possible closed shadow roots are reported as
  unobservable rather than silently treated as unchanged.
- `noise: 'agent'` suppresses configured ambient signals. `noise: 'none'` preserves
  clocks, relative time, whitespace, animations, and exact geometry.
- The observer detects authored destinations/resources/accessibility changes including
  `href`, `src`, `srcset`, accessible names, and computed `background-image`.
- A page controls its own DOM. An authenticated transport proves where a result came
  from, not that hostile page content is factually true.
- The daemon reader and privacy policy run in a Chromium isolated world; page JavaScript
  cannot replace the observer or clear its policy.
- Sensitive form values use presence plus coarse length buckets and report their
  same-bucket uncertainty; they do not store a value-derived digest. Ordinary form values
  keep a deterministic change fingerprint. Raw form values are not returned, but every
  persisted checkpoint must still be handled as a sensitive artifact.
- Daemon and MCP consumer responses report that redaction is active, with the policy
  revision and active-rule count. They do not expose per-rule match or hit counts, because
  those counts would reveal whether a protected term occurred.
- Screenshots are pixels and are not redacted.
- IDs expire when a full observation establishes a new epoch. Resolve or search again.
- A checkpoint compares state; it is not an undo operation.
- Repeatability is claimed only within one environment. No cross-browser equivalence is
  implied.

## Test layers

```bash
npm test                  # core browser suite + daemon/MCP security/session regressions
npm run test:lint         # src, tests, tools, MCP, and companion
npm run test:bundles      # deterministic companion bundle freshness
npm run test:regression   # offline corpus/parity/daemon/contracts/demo gates
npm run test:adversarial  # adversarial experiment gate
node companion/gate.mjs   # hermetic extension boundary gate
npm run test:cold         # git-tracked clean copy, browser install, tests and package gates
```

`test:global` remains an explicit check of the copy under `~/.claude`; it is not run by
CI or the default gates because it depends on user machine state.

## Repository map

```text
src/          observation, matching, diff, privacy, queries, checkpoints
vendor/       pinned snapDOM browser runtime and export plugins
tools/        CLI/daemon, bundle definition, installer, cold-install proof
mcp/          MCP stdio adapter
companion/    MV3 extension, authenticated worker, adversarial gate
test/         browser and daemon/MCP regression tests
corpus/       hand-written mutation fixtures
experiment/   research and regression runners
docs/         privacy notes and architecture records
```
