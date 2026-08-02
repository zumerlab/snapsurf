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

Target user — revised 2026-08-02 after an outside feature-coverage benchmark, which is
the first assessment by someone with no stake in the answer.

**Not "people who want a browser for agents".** That lane is crowded and the competitor is
free: on bespoke extraction from a known site, Playwright with a 40-line `evaluate()` beat
this tool on both cost and calls, measured. Selling there means losing to something that
costs nothing.

The buyer is **whoever carries a compliance obligation over data that passes through a
model** — legal tech, health, KYC and financial onboarding, anyone under GDPR. For them,
redacting at the observation boundary with an attestation is not a feature, it is what
lets them sign. It is also the one capability with **no architectural substitute**:
post-processing is too late, because the datum has already entered the model's context and
the transcript by the time it is masked.

Second, smaller but faster to close: **registries and data providers** sweeping thousands
of domains, whose real cost is the false negative. The argument there is the negative
control, not the positive one — a thin page comes back thin and *unflagged*, while a
blocked one is typed. A detector that fired on every Cloudflare-hosted site would be
worthless; not crying wolf is what makes the flag worth anything.

Third, and the one worth pursuing: **do not sell the product, license the honesty layer.**
`blocked` / `truncated` / the faithful negative / the attestation are one coherent
contract — never let confusion look like an answer — and almost nobody implements it. It
fits whoever already has the browser and lacks the auditability, and E5 already showed the
reader running inside another harness in 45 KB through its own `eval`.

**Do not sell authenticated sessions.** The tool drives its own cookie jar; a site the
user is signed into elsewhere is read anonymously. Since 2026-08-02 that is reported
unprompted (`authState`, `cookiesForOrigin`) instead of failing silently, but the
capability still is not there, and it is the failure a customer would meet in production
rather than in a demo.

Attach to any compliance pitch, always: redaction protects against the *consumer*, not
against code running in the page, and screenshots are pixels and are not redacted. A buyer
who finds that limit after signing is worse than one who was told before.

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
