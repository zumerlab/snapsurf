# PLAN — from lab to product

Started 2026-07-31 · branch `agent-lab` (private, never pushed) · status updated
2026-08-01, after phases 1–3 passed their gates.

This document holds the positioning and what is still open. The evidence for the finished
phases lives where it was produced — it is not copied here.

## Positioning (decided — do not re-open)

**A layer that checks whether an agent's action did anything.** Not "a replacement for
screenshots": describing a page is a solved, crowded problem. And not a replacement for
any existing browser tool — this adds one reading, and it can run *inside* other tools
(phase E5 proved that).

What is actually ours, in order of how well it is backed:

1. **The change report.** An agent without it believes it acted and carries on with a
   wrong idea of the page. Measured: 0 wrong success reports against 6 out of 8 for three
   other channels (`experiment/results/c-false-green.md`).
2. **Targeted search.** 38 kB down to 2 kB, measured, for the same result.
3. **Warning about covered elements before the click**, which the accessibility tree does
   not carry (`experiment/results/e2-contracts.md`).

There is a fourth thing often listed here that should not be: two silent failures caught
during ordinary browsing. Those are anecdotes. They are why we looked here in the first
place, and they are not evidence.

Target user: **people building QA and web-automation agents** — the niche that already
pays for this, and where the change report replaces brittle visual assertions. The
extension case stays as a demonstration of what this can do that others cannot, not as a
consumer product.

Nothing gets published without an explicit decision from the owner.

## Status

| Phase | State | Evidence |
|---|---|---|
| 1 · MCP server, ten tools | ✅ gate passed | `mcp/GATE.md` |
| 2 · The number to quote | ✅ gate passed | `experiment/results/bench-qa.md`, `demo-qa/` |
| 3 · Auditable privacy | ✅ gate passed | `docs/PRIVACY.md`, `experiment/results/codex-f3-privacy.md` |
| 4 · Package it as a component | ⬜ open | below |

The quotable line from phase 2: *zero false alarms where a pixel comparison reports 5 out
of 8, and it says what changed in about 30 tokens.*

## Phase 4 — package it as a component

The only phase still open.

- Freeze a minimal public API with the guarantees written down as a versioned contract:
  unique-or-absent targets, honest negatives, same-environment repeatability only.
- Move `companion/` to `demo/` with its own README.
- Licence, name and pricing: the owner's call, deliberately outside this plan.

**Gate**: somebody who has never seen this integrates it from the README alone, in under
30 minutes, without help.

Progress: the README was rewritten as a manual for all five modes on 2026-08-01, which is
the prerequisite. The API surface was narrowed the same day (nine exports that nothing
used are gone). The cold-integration test has not been run.

## Method

Phase 1 first because it is the vehicle for phase 2 — running the benchmark *through* the
MCP server means the number measures the product, not the lab. After each phase, a real
consumption round by an outside reviewer before moving on. That is the method that worked
for six rounds, and it is the reason the results in `TESTPLAN.md` include claims we had to
withdraw.

## Deliberately not in this plan

- Publishing anything: npm, Chrome Web Store, a public repository.
- A consumer-facing extension.
- Full autonomy: state restore, per-field permissions. No real user has asked, so it stays
  deferred — but `experiment/results/e4-where-they-win.md` records these as things a
  comparable tool already has, which is different from ignoring them.
- Re-opening the positioning.
