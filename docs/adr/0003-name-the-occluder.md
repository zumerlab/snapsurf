# ADR 0003 — A covered element must name what covers it

Status: accepted · Date: 2026-07-29 · Found by: the end-to-end agent loop (Phase 5, layer 3)

## Context

`covered` started as a boolean: an interactive node whose centre resolves to a foreign
element via `elementFromPoint`. That is enough to answer "is this clickable now?", which
is what the single-observation layers measure — and both of them scored it 1.00.

The end-to-end loop measured something the observation layers cannot see: **actions
spent**. In a fixture with two dismissable overlays where only one actually covers the
goal button, the agent reading arm B cleared *both*, and always started with the wrong
one — 3.0 actions to success against 2.0 for the screenshot arm, 10 runs out of 10, with
no variance. The boolean told it a bar was in the way; it did not say which bar, so the
only safe plan was to clear every candidate.

The bounding boxes were in the payload, so the answer was derivable by arithmetic
(`Aceptar` at y=676 can overlap y=700; `No, gracias` at y=14 cannot). The model did not
do that arithmetic, and expecting it to is the wrong side of §"expose classes, not
floats": geometry is our job, not the caller's.

## Decision

`elementFromPoint` already returns the occluding element — keep it instead of collapsing
it to a boolean. Every covered node carries `coveredBy: {id?, role, name?, label?}`,
where `id` is the occluder's snapshot id when the occluder (or its nearest ancestor) was
walked, and `label` is the occluder's trimmed text for the common case of an overlay div
with no role and no accessible name. It surfaces in all three report shapes: the context
outline (`⊘covered by …`), the Set-of-Mark entries, and `actionabilityDelta.becameCovered`.

Two constraints fall out of §1:

- **It is resolved after the walk, never inside a signature.** `coveredBy` describes
  another node; letting it into `contentHash` would propagate that node's geometry and
  stacking into this node's identity. Occluders are resolved in a pass after every hash
  is computed, so this is true by construction rather than by discipline.
- **It is not serialized into the checkpoint.** It is an observation about the present,
  not identity, and the diff only needs the *after* snapshot to say who covers what.

Cost is one `textContent` read per covered interactive node. Covered interactive nodes
are rare by nature; the walk is unchanged for everything else.

## Consequence

Re-running the same loop on the same fixture, same model, same prompts: 2.0 actions to
success, 10/10 optimal runs, 0 invalid clicks — from 3.0 and 0/10. The screenshot arm
stayed at 2.3 (7/10 optimal); the markup-only arm at 3.67 with 8 invalid clicks.

The general lesson repeats the one from the blind-judge run (ADR-adjacent, recorded in
EXPERIMENT.md): a datum being **present** and being **usable** are different properties,
and only a loop that spends actions can tell them apart.
