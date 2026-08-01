# PLAN — from lab to product

Started 2026-07-31 · branch `agent-lab` (private, never pushed) · status updated
2026-08-01 after phases 1–3 ran.

## Positioning (decided — do not re-open)

**A layer that checks whether an agent's action did anything.** Not "a replacement for
screenshots": describing a page is a solved, crowded problem (Playwright snapshot,
browser MCPs, and several others do it). And not a replacement for any existing browser
tool — this is a tool that adds one reading, and it can run *inside* other tools
(phase E5 proved that).

What is actually ours, in order of how well it is backed:

1. **The change report.** An agent without it believes it acted and carries on with a
   wrong idea of the page. Measured: 0 wrong success reports against 6 out of 8 for three
   other channels (`experiment/results/c-false-green.md`).
2. **Targeted search.** 38 kB down to 2 kB, measured, for the same result.
3. **Warning about covered elements before the click**, which the accessibility tree does
   not carry. Confirmed against a comparable tool in `experiment/results/e2-contracts.md`.

There is a fourth thing often listed here that should not be: two silent failures caught
during ordinary browsing (a deleted Reddit comment, three no-ops on a news site). Those
are anecdotes from real use. They are a good story and they are why we looked here in the
first place, but they are not evidence and must never be quoted as a result.

Target user: **people building QA and web-automation agents** — the niche that already
pays for this, and where the change report replaces brittle visual assertions. The
extension case stays as a demo of what the tool can do that others cannot, not as a
consumer product.

Nothing gets published without an explicit decision from the owner.

## Phase 1 — MCP server ✅ done

`packages/agent/mcp/`: a stdio MCP server in Node wrapping the daemon. Ten tools:
`browser_open`, `browser_find`, `browser_act`, `browser_verify`, `browser_assert`,
`browser_checkpoint`, `browser_diff`, `browser_text`, `browser_page`,
`browser_screenshot`.

It inherits everything the lab already hardened: per-session JSONL logs, the
`--readonly` / `--allow` policies, verified selectors, honest negatives, adaptive settle.

**Gate: passed.** Claude Code and Claude Desktop consume it as native tools with no skill
and no pasted snippet; the benchmark runs through it; an outside reviewer used it blind
(`experiment/results/codex-mcp.md`).

## Phase 2 — the number to quote ✅ done

`experiment/bench-qa.mjs`, over the 19 hand-written cases, through the MCP server:

| Metric | This tool | Pixel difference | Accessibility tree diff |
|---|---|---|---|
| Right | **19/19** | 13/19 | 16/19 |
| False alarms on 8 noise cases | **0** | 5 | 2 |
| Missed, of 11 real changes | **0** | 1 | 1 |
| Explains *what* changed | kind + role + name | % of pixels | two JSON trees to diff |
| Evidence size, no-op case | **61 B** | 33 KB | 1 KB |

**Gate: passed.** The quotable line: *zero false alarms where a pixel comparison reports
5 out of 8, and it says what changed in about 30 tokens.*

`demo-qa/` is the matching demo: a QA test that uses `browser_assert` where a screenshot
assertion used to be.

## Phase 3 — auditable privacy ✅ done

The redaction layer existed and was tested; this phase made it visible.

- Exposed in the daemon and MCP as a session option.
- Redaction report: which rules matched, how many nodes, in which fields — by rule
  *number*, never by rule text, because the report is read by a model and naming the rule
  would leak the string being hidden.
- One-page document: `docs/PRIVACY.md`, exactly what text leaves the page and what
  never does.

**Gate: passed.** A page with sensitive data shows the redactions, the report lists them,
asking whether a hidden string exists is refused rather than answered, and it is covered
by 8 unit tests plus 5 checks in the extension gate. An adversarial review round found
five holes and all five are closed (commit `91daf6d`).

## Phase 4 — package it as a component ⬜ open

- Freeze a minimal public API with the guarantees written down as a versioned contract:
  unique-or-absent targets, honest negatives, same-environment repeatability only.
- Move `companion/` to `demo/` with its own README.
- Licence, name and pricing: the owner's call, deliberately outside this plan.

**Gate:** somebody who has never seen this integrates it from the README alone, in under
30 minutes, without help.

Progress: the README was rewritten as a manual for all five modes on 2026-08-01, which is
the prerequisite. The cold-integration test has not been run.

## Order and dependencies

Phase 1 first because it is the vehicle for phase 2 — running the benchmark *through* the
MCP server means the number measures the product, not the lab. Phases 3 and 4 can
interleave. After each phase, a real consumption round (an outside reviewer, or the
browser panel) before moving on. That is the method that worked for six rounds.

## Deliberately not in this plan

- Publishing anything: npm, Chrome Web Store, a public repo.
- A consumer-facing extension.
- Full autonomy: state restore, per-field permissions. No real user has asked, so it
  stays deferred — but `experiment/results/e4-where-they-win.md` records them as things a
  comparable tool already has, which is different from ignoring them.
- Re-opening the positioning.
