# ADR 0001 — The semantic visitor rides `beforeClone`; no `visitNode` core hook (yet)

Status: accepted (no deviation from the master prompt; recording the judgement call)
Date: 2026-07-29

## Context

§8 requires one walk, two outputs: the semantic visitor and the (optional) render
visitor must observe the **same instant**, and the prompt allows adding an **additive**
`visitNode` core hook "if per-node access inside the clone walk becomes necessary".

## Decision

It is not necessary. The semantic visitor is a **whole-subtree synchronous walk** of the
live DOM, not a per-node callback: `takeSnapshot()` runs start-to-finish with no awaits
(every read is `getComputedStyle` / `getBoundingClientRect` / `elementFromPoint`). So it
can run inside a single lifecycle hook and still be atomic with respect to the page.

`inspect()` therefore:

- runs `takeSnapshot()` directly when no raster is requested — the clone is never built
  and its cost is never paid (§8);
- when `rasterize()` is called, registers a per-capture plugin whose `beforeClone` hook
  re-takes the snapshot **synchronously, in the same task as the clone walk**, with no
  awaits in between, and re-bases the ui's `context` / `agentMap` / `rootHash` onto it.

This keeps core untouched (no new hook, no behavior change, no dependency on this
package) and still gives the pixel/structure/bbox alignment §8 demands.

## When to revisit

Add `visitNode` only if a future requirement genuinely needs **per-node interleaving**
with the clone walk — e.g. attaching semantic ids to clone nodes as they are created, or
capturing state that the clone pass mutates and restores. If that day comes: additive
hook, default absent, zero cost when unused, and core must keep working with the hook
never registered.

## Consequence recorded for honesty

`inspect()` alone and `inspect()+rasterize()` sign the DOM at **different instants** (the
second re-signs inside `beforeClone`). That is why `rasterize()` refreshes `ui.context`,
`ui.agentMap` and `ui.rootHash` rather than leaving the earlier values in place: the map
must match the image, and the earlier snapshot is by definition older than the pixels.
