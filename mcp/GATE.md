# Phase 1 gate — the MCP server

## (a) Consumed as native tools — ✅ 2026-07-31

Registered at user level (`claude mcp add --scope user snapdom-agent`, ✔ Connected).
Claude Code sessions see it with no skill and no pasted snippet. Claude Desktop: the same
registration pointing at `packages/agent/mcp/server.mjs`.

## (b) The 5 tasks through MCP only — ✅ 2026-07-31

A runner using `tools/call` exclusively (scratchpad `mcp-gate.mjs`), with the same
criteria as the command-line comparison:

| Task | Result | Calls | Wall |
|---|---|---|---|
| T1 HN top story comments | ✓ "114 comments" (/item?id=49118781) | 2 | 1.6 s |
| T2 GitHub issues | ✓ Open 0 · Closed 338 | 3 | 1.8 s |
| T3 deep Wikipedia link | ✓ /wiki/Mar_del_Plata | 4 | 5.1 s |
| T4 npm downloads | ✓ 27,689,392 (live data, changed with the week) | 4 | 1.2 s |
| T5 first eBay result | ✓ "Alice Cooper…" /itm/287458494065 | 8 | 11.5 s |
| **Total** | **5/5** | **21** | **21.2 s** |

Command-line reference: 5/5 · 20 commands · 21.2 s. The extra call: T4 tried ids from the
search until it hit the number, while the command-line flow already knew the right id.
Equivalent.

## (c) A blind review round, MCP only — ✅ 2026-07-31

`results/codex-mcp.md`: **5/5 · 25 calls · 19.98 s of pure execution** (better wall time
than either reference), with nothing but `tools/list` as documentation. Verdict:
"integrable today for experimentation and for agents with a model in the loop; not as-is
for unattended QA", plus 9 requests.

## Hardening after (c) — ✅ same day

Of the 9 requests, 6 applied and verified:

1. **Daemon lifecycle (a CI blocker)**: the server owns the daemon it starts and kills it
   on EOF, SIGINT or SIGTERM. Two landmines measured along the way:
   `ChildProcess.kill()` returns true WITHOUT delivering the signal (use
   `process.kill(pid)`), and a signal followed by an immediate `process.exit` is not
   delivered either — the sender has to outlive the send. Hence the pattern
   TERM → 400 ms → KILL. Verified: zero orphans by either route.
2. **Envelope v1 from the daemon** (`{ok, text, error, epoch, url, meta}` when `/cmd`
   receives `envelope:true`; the command line is unchanged) → **`structuredContent`** on
   every MCP reply: changed, matches, resolved, settle, epoch and url as FIELDS, not prose.
3. `browser_act` with a conditional schema (`oneOf` per action).
4. Command-line phrasing translated to MCP names at the edge ("run look" → call
   browser_verify, and so on).
5. `browser_page {view:"zoom", id}` — the per-region reading that was missing.
6. The `changed:false` negative is now structured too, verified on a fixture.

Deferred to phase 2 (features, not fixes): a deterministic `browser_assert`, telling the
target's effect apart from ambient change in verify, `browser_query` with ordering, and
auditable redaction (which became phase 3). Gate (b) re-run after the hardening:
5/5 · 21 calls · 21.8 s.
