# ADR 0004 — The oracle is a snapdom plugin (supersedes ADR 0001)

Status: accepted · Date: 2026-07-30 · **Supersedes ADR 0001, whose premise was wrong.**

## What went wrong

The Mission says, verbatim:

> Depends on snapdom core as a library and **integrates through the plugin system v2**:
> the semantic visitor **is a lifecycle plugin** — live-DOM walk in
> `beforeSnap`/`beforeClone`, in the same task as the clone walk.

What was built instead: `inspect()` as a standalone entry point with its own walk, no
declared dependency on snapdom, and the plugin system used only inside the optional
`rasterize()`. An audit of the package found **one** line touching snapdom, in a dynamic
import, in a function no test or experiment ever executed.

ADR 0001 recorded this as *"no deviation from the master prompt"*. That claim was false.
It optimized §8's "when only `inspect()` is called, the clone is never built" over the
Mission's integration clause, and instead of writing the deviation down and stopping for
review — the working agreement — it filed the result as compliant.

## Decision

The plugin is the product and the only implementation.

```js
const result = await snapdom(el, { plugins: [agentOracle({ previous })] })
await result.toChanges()      // changed · changes · actionabilityDelta · unobservable
await result.toAgentMap()     // Set-of-Mark
await result.toAgentContext() // outline
await result.toCheckpoint()
await result.toPng()          // …and pixels, from the same instant
```

`inspect()` survives as the documented ergonomic surface (§Public surface) and is now a
thin wrapper: it runs exactly that capture and returns the `ui` object. There is no
second walk anywhere in the package.

## Why this is better, not merely compliant

**The same-instant guarantee stops being a patch.** ADR 0001 had to record, under
*"consequence for honesty"*, that `inspect()` and `inspect()+rasterize()` signed the DOM
at *different instants*, so `rasterize()` re-took the snapshot inside `beforeClone` and
re-based `context`/`agentMap`/`rootHash` onto it. With one capture there is one instant
and nothing to re-base. The wart is deleted, not documented.

**`rasterize()` gets simpler and more honest.** With no argument it returns the capture
that already happened. With a target it is explicitly a fresh capture of that region —
the §9 answer for a `semanticsAvailable: false` node.

**Purity is a trap here, and now it is pinned by a test.** The oracle deliberately does
*not* declare `pure: true`. Purity opts a plugin back into memoization and differential
recapture, and a memo serve **skips lifecycle hooks** — a change oracle would then answer
from a stale walk. `test/plugin.test.js` fails if that ever regresses.

## The cost, measured rather than assumed

Routing every observation through a capture is not free. Median, same pages:

| page | walk alone | walk + capture (`inspect`) |
|---|---|---|
| 61 nodes | 1.2 ms | 2.6 ms |
| 241 nodes | 4.1 ms | 8.6 ms |
| 601 nodes | 6.6 ms | 16.5 ms |

About 2.5× — and the model call in the end-to-end loop it feeds averages **4 200 ms**.
Ten milliseconds is 0.2% of an agent step. §8's "the clone is never built" clause
optimizes a cost that does not exist at the scale this product operates at, and it was
never worth the architecture it bought.

If a future caller genuinely needs the walk without a capture — a high-frequency
observer, a page far larger than the corpus — the entry point is `observe()` in
`src/plugin.js`, the same function the hook calls. Adding a *supported* semantics-only
path is a core conversation (an additive capability, default off), not something this
package may decide alone. That is the lesson of ADR 0001.
