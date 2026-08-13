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

On a staged SnapDOM v3 runtime the sensor takes the standard `needs` knob:
`sensor({ needs: 'live' })` walks the LIVE DOM in `beforeClone` — **no clone is taken**
(the ~89% cut) — and the report says so: `coverage.source: 'LIVE_DOM_WALK'`,
`visual.svg: 'NOT_CAPTURED_STAGE_LIVE'`, `visual.raster:
'REQUEST_A_NEW_SCOPED_CAPTURE_WITH_CLIP'` (pixels of a later instant are a NEW capture —
use `clip` to scope it to the uncertain region). The default stays `'render'` per the
plugin spec: lowering the stage takes the picture away, and that is the caller's call.
If another plugin raises the resolved stage, the sensor follows it back to the prepared
frame automatically. On a stage-less legacy runtime, `needs:'live'` throws
`SNAPDOM_SENSOR_STAGES_REQUIRED` instead of letting the full pipeline run silently.

The package declares `@zumer/snapdom` as a peer dependency and contains no Playwright,
CDP, MCP, Node runtime or browser controller. It remains private development software;
publication is not authorized by the current package metadata/license.

