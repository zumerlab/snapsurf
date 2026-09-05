# `@zumer/snapdom-sensor`

A stateful semantic sensor implemented as a standard SnapDOM plugin.

```js
import { snapdom } from '@zumer/snapdom'
import { sensor } from '@zumer/snapdom-sensor'

const effectSensor = sensor({
  privacy: { redact: ['private-account-name'] },
})

// Capture only the region that matters. Reuse the same plugin instance.
const before = await snapdom(document.querySelector('#checkout-card'), {
  plugins: [effectSensor],
})

// A person, page script, browser agent or any other host acts here.

const after = await snapdom(document.querySelector('#checkout-card'), {
  plugins: [effectSensor],
})
const report = await after.toSensor()
```

The first capture establishes a private in-memory baseline. Each later capture of the
same root returns a bounded, typed delta through `toSensor()` and advances that baseline.
The report describes semantic, state and rendered-actionability changes. It never accepts
an expected result and never decides whether the host's task succeeded.

Baselines are keyed to the live Element, so they cannot survive a host remount of the
scope. That loss is loud, never silent: every report carries
`localState.rootContinuity` — `ESTABLISHED` (first sight of this root), `CONTINUOUS`
(delta against this root's own history), or `HISTORY_NOT_CARRIED` (a previously tracked
root is gone; `possibleRemount: true` when the new root has the same tag and testid).
`HISTORY_NOT_CARRIED` also adds `baseline-history-not-carried` to `uncertainty.reasons`,
so a consumer can never mistake a post-remount first capture for continuous observation.
`reset()` is explicit amnesia and restarts continuity without the warning.

This is a SnapDOM plugin, not an alternative capture engine:

- it uses SnapDOM's existing `afterClone` and `defineExports` hooks;
- its semantic walk is restricted to source elements present in SnapDOM's prepared frame
  and reuses SnapDOM's computed-style cache;
- the caller scopes work by passing the desired element directly to `snapdom()`;
- SnapDOM still completes its normal SVG capture, exposed as `result.url`,
  `result.toSvg()`, `result.toPng()`, and the other regular exporters;
- the sensor stores no SVG or portable checkpoint as its private baseline.

One plugin instance is stateful. Reuse it sequentially, do not share it across concurrent
captures of the same root, and call `reset(root?)` or `dispose()` when its history is no
longer needed.

On current SnapDOM v3, the supported stages are `'clone' | 'render'`.
`sensor({ needs: 'clone' })` observes the prepared frame in `afterClone` and skips
image rendering. The report declares `coverage.source: 'SNAPDOM_AFTER_CLONE_FRAME'`,
`coverage.stage: 'clone'`, and `visual.svg: 'NOT_RENDERED_STAGE_CLONE'`. Pixels requested
later need a **new** capture: use `clip` to scope that work to the desired region.
The default remains `'render'`. Another plugin can raise the resolved stage to render;
the sensor follows `ctx.options.needs`, and `result.needs` reports the same stage.

The former experimental `'dom'` and `'live'` stages are rejected; core now always
prepares at least a clone. Historical no-clone timing results do not apply to this
version. A clone request on a stage-less runtime throws
`SNAPDOM_SENSOR_STAGES_REQUIRED` instead of silently rendering an image.

## Captured-content privacy

`privacy: { redact: ['literal'] }` filters literal strings in the report only. The
optional `captureRedaction` field composes SnapDOM's `redactInputs` with the sensor so
one per-capture policy also protects the selected image content:

```js
const sensorPlugin = sensor({
  captureRedaction: {
    all: true,
    blocks: '.private-panel',
    attributes: [{ selector: '.customer', names: ['title', 'aria-label'] }],
  },
})
```

It accepts all `redactInputs` options: `types`, `autocomplete`, `selector`, `all`,
`mask`, `blocks`, `attributes`. `selector` matches inputs/textareas only. Blocks use
the capture's `excludeMode` (`hide` by default, or `remove`). Attribute names are exact,
not wildcard patterns. A matching `value` rule clears an input/textarea's displayed
value and omits its value from structured state. Filled-to-filled edits hidden by
these field rules are declared unobservable. Source DOM is never modified.

The shared policy filters source-derived names, text, state and signatures before
baseline storage. The sanitized clone feeds normal image exports and every deferred
GIF/video frame. Reports record `privacy.captureRedaction:
'SELECTED_FIELDS_BLOCKS_ATTRIBUTES'` when enabled. No option is enabled by default.

Masks can change glyph widths/wrapping. Custom masks and nonempty selector, block or
attribute rules disable unchanged-capture memoization; block/attribute rules add a
final render hook and require SVG rendering. Rules do not scan text or images for
secrets: an attribute's visible text, CSS-content or bitmap copies remain unless their
subtree is blocked. A separately supplied redactor plugin has its own private policy;
use `captureRedaction` when semantic outputs must follow the same rules.

Capture redaction permits one composed configuration per capture. A protected capture
rejects additional `agentOracle`/`sensor` readers, including unconfigured ones; use
separate captures for separate readers. In `agentOracle` or
`agent.inspect`, checkpoints created with `captureRedaction` are bound to that local
policy. Enabling, removing or changing the selection rules, or reloading the page,
requires omitting `previous` to establish a fresh baseline. This prevents an older
checkpoint from reintroducing previously visible names or text into a protected diff.


The package declares `@zumer/snapdom` as a peer dependency and contains no Playwright,
CDP, MCP, Node runtime or browser controller. It remains private development software;
publication is not authorized by the current package metadata/license.

