# Post-run audit: where the Sensor is actually cheaper

This audit interprets `sensor-agent-cost-v1.json` without changing or relabelling
the measured artifact. The result JSON SHA-256 is
`3825cdf82cf413cd0fc98c2d0767e0b5323852b28ae1739c17f014cc60b3acc1`.

## Honest conclusion

The Sensor is not always the smallest payload.

When the host already knows the exact target card, the existing AgentMap is much
smaller:

| Target scope payload | Bytes |
|---|---:|
| AgentMap post state | 184 |
| AgentMap before + after | 312 |
| Sensor post-action delta | 2,613 |
| SnapDOM post SVG data URL | 26,923 |

The Sensor is 14.2× the one-state map and 8.4× the two-state map in that small,
directed scope. It remains 9.7% of the SVG.

On the whole authored page, which contains 362 actionable elements, the relationship
reverses:

| Whole-page payload | Bytes |
|---|---:|
| Sensor post-action delta | 2,617 |
| AgentMap post state | 23,807 |
| AgentMap before + after | 47,556 |
| SnapDOM post SVG data URL | 180,006 |

There the Sensor is 11.0% of one post map, 5.5% of the map pair, and 1.45% of the
post SVG data URL.

These bodies do not contain identical information. Sensor reports the typed status
change in addition to the actionable button/link facts; AgentMap with
`semantic:false` intentionally omits the status. Treat the comparison as product-route
cost, not codec efficiency at an identical information contract.

## Local work

- Whole page: Sensor median cycle was 133.9 ms versus 107.5 ms for raw SnapDOM
  (1.246×). Combined AgentMap + Sensor was 137.2 ms versus 112.2 ms for AgentMap
  alone (1.223×).
- Target card: combined median cycle was 5.5 ms versus 137.2 ms whole-page. Choosing
  the right capture root was the largest compute optimization in this fixture.
- The preregistered local-cost gate passed narrowly. With seven repetitions on one
  machine this is “about 25% overhead in this fixture,” not a universal speed claim.

## Visual fallback

For both SnapDOM 2.24.1 and the vendored v3 runtime, `scale:0.5, dpr:1` produced
25% of the standard raster pixels and 26.9% of the PNG data-URL bytes. The decoded
SVG was byte-invariant because the fixture contained no raster assets. Scale/DPR are
raster controls; scope/clip/exclude are structural controls.

AgentMap's separate `maxImageWidth` path produced 2.2 KiB, 4.4 KiB, and 6.9 KiB
WebP data URLs at widths 320, 640, and the natural 956 pixels. `image:false` omits
that raster pass but not SnapDOM's SVG capture.

## Product position supported by this result

> A client-side SnapDOM plugin that reports what changed in the real rendered browser,
> while the full capture and prior state stay local. Use the actionable map for current
> controls and request a small visual fallback only when semantic evidence is insufficient.

The useful wedge is a large or dynamic surface, or a moment when the host does not yet
know the smallest relevant scope. If the host already knows one small target and only
needs its current state, AgentMap map-only is the better route.

This run made zero HTTP(S), cloud, or model calls. Therefore it proves local mechanics
and candidate boundary-body sizes, not observed cloud savings, model tokens, task success,
production reliability, privacy safety for every data class, or commercial demand.

## Why the old AgentMap matters

The attached plugin is `@zumer/snapdom-plugins` 2.2.1 in the SnapDOM 2.24.1 tree.
It already implemented fully client-side actionable perception, optional images, badges,
roles, names, states, bounding boxes, and hit-test-derived coverage. It should have been
the starting point for this product analysis.

The run also reproduced two defects with synthetic data:

- capturing an interactive root button returns an empty map because the implementation
  scans descendants with `querySelectorAll` but not the root itself;
- the minimal map exposes a synthetic password through `input.value`, while the Sensor
  report and SnapDOM SVG did not contain that literal.

AgentMap is the current-state half of the product. Sensor is the temporal, bounded,
privacy-aware and uncertainty-aware half. They compose on the same SnapDOM result; neither
needs to replace the other.
