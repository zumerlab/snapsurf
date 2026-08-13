# SnapDOM AgentMap + Sensor cost probe

Classification: single-machine synthetic descriptive local-cost and candidate-boundary-byte probe; not a token, model-quality, production-site, or commercial-demand claim.

## Outcome

- Candidate agent-boundary value: **PASS**. Sensor/post-SVG = 1.5%; Sensor/post-map = 11%.
- Cheap local overhead claim: **PASS**. Sensor/raw cycle = 1.25×; combined/map cycle = 1.22×.
- Scope value: **PASS**. Target/whole-page combined cycle = 4%.
- Raster knobs: **PASS**.
- Commercial value: **NOT_ASSESSED**.

No cloud or model call occurred. “Boundary bytes” below are candidate payloads measured locally, not observed network egress.
The no-op probe retained status **INDETERMINATE** because it deliberately contained a sensitive password blind spot, while reporting zero semantic and actionability delta. That uncertainty was not coerced to PASS.

## Primary local cycle and candidate payload

| Scope | Arm | Local cycle p50 | Capture p50 | Export p50 | Post SVG URL | Post map | Map pair | Sensor delta | Map entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| target | raw | 4.4 ms | 4.4 ms | 0 ms | 26.3 KiB | 0 B | 0 B | 0 B | 0 |
| target | agent-map | 4.8 ms | 4.8 ms | 0 ms | 26.3 KiB | 184 B | 312 B | 0 B | 2 |
| target | sensor | 5.3 ms | 5.3 ms | 0 ms | 26.3 KiB | 0 B | 0 B | 2.6 KiB | 0 |
| target | combined | 5.5 ms | 5.5 ms | 0 ms | 26.3 KiB | 184 B | 312 B | 2.6 KiB | 2 |
| page | raw | 107.5 ms | 107.5 ms | 0 ms | 175.8 KiB | 0 B | 0 B | 0 B | 0 |
| page | agent-map | 112.2 ms | 112.2 ms | 0 ms | 175.8 KiB | 23.2 KiB | 46.4 KiB | 0 B | 362 |
| page | sensor | 133.9 ms | 133.9 ms | 0 ms | 175.8 KiB | 0 B | 0 B | 2.6 KiB | 0 |
| page | combined | 137.2 ms | 137.1 ms | 0.1 ms | 175.8 KiB | 23.2 KiB | 46.4 KiB | 2.6 KiB | 362 |

AgentMap and Sensor are not substitutes: AgentMap answers “what can I act on now?”; Sensor answers “what changed since the last capture?”. The combined arm obtains both from the same two SnapDOM results.

## Scale and DPR

| Runtime | Profile | scale | DPR | PNG p50 | PNG dimensions | decoded SVG p50 |
|---|---:|---:|---:|---:|---:|---:|
| snapdom224 | low | 0.5 | 1 | 213.3 KiB | 482×292 | 29.7 KiB |
| snapdom224 | standard | 1 | 1 | 793.8 KiB | 964×584 | 29.7 KiB |
| snapdom224 | equal-effective | 0.5 | 2 | 793.8 KiB | 964×584 | 29.7 KiB |
| snapdom224 | retina | 1 | 2 | 2795.7 KiB | 1928×1168 | 29.7 KiB |
| snapdom3 | low | 0.5 | 1 | 213.3 KiB | 482×292 | 17.6 KiB |
| snapdom3 | standard | 1 | 1 | 793.8 KiB | 964×584 | 17.6 KiB |
| snapdom3 | equal-effective | 0.5 | 2 | 793.8 KiB | 964×584 | 17.6 KiB |
| snapdom3 | retina | 1 | 2 | 2795.7 KiB | 1928×1168 | 17.6 KiB |

The fixture has no embedded raster assets. Therefore scale/DPR change the optional PNG but not the DOM/CSS structure serialized into the raw SVG. For structural savings, capture a smaller root or use clip/exclude.

## AgentMap image width

| maxImageWidth | output dimensions | image p50 | map p50 |
|---:|---:|---:|---:|
| 320 | 320×193 | 2.2 KiB | 150 B |
| 640 | 640×386 | 4.4 KiB | 150 B |
| 1024 | 956×576 | 6.9 KiB | 153 B |

AgentMap performs its own raster pass. Its effective visual-cost knob is `maxImageWidth`; `image:false` omits that pass entirely, while SnapDOM still produces the normal SVG capture.

## Attached AgentMap finding

- Native SnapDOM 2.24.1 + AgentMap loaded: true.
- Capturing an interactive root returned 0 entries: **ROOT_ELEMENT_OMITTED_BY_QUERY_SELECTOR_ALL**.
- A synthetic password was present in AgentMap JSON: **true**.
- The same synthetic password was present in Sensor JSON: **false**.

This is why the old plugin matters but is not the whole product. It already proved local actionable perception. The Sensor adds temporal memory, bounded typed deltas, privacy handling, and explicit uncertainty; AgentMap itself still needs privacy and geometry hardening.

## Boundaries

- Synthetic fixture, one machine, one browser version.
- No token estimate and no model task-success claim.
- Local timings are descriptive; bytes are exact UTF-8 lengths.
- The attached AgentMap source came from the SnapDOM 2.24.1 tree; the composition arm ran on the Sensor peer runtime (vendored SnapDOM 3 beta).
- No personal Chrome profile, session, tab, cookie store, password store, or extension was accessed.

JSON evidence: [sensor-agent-cost-v1.json](./sensor-agent-cost-v1.json). Preregistration: [sensor-agent-cost-v1.preregistration.json](./sensor-agent-cost-v1.preregistration.json).

