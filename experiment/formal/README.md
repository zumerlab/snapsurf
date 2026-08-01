# Formal benchmark — Claude native vs ChatGPT (Codex) native vs snapDOM Agent

The reproducible benchmark behind `packages/agent/PAPER.md` §6. Everything a run
produces is a JSON file; everything a claim cites is judged by code in this folder.

## Arms

| arm id | runner | perception/action stack |
|---|---|---|
| `claude-native` | Claude Code session | claude-in-chrome extension ONLY (screenshots, read_page, find, computer) |
| `claude-agent` | Claude Code session | snapDOM Agent ONLY (CLI `browse.mjs` or MCP tools) |
| `codex-native` | Codex (ChatGPT) | Codex's own stack as it comes — anything EXCEPT `packages/agent/*` |
| `codex-agent` | Codex (ChatGPT) | snapDOM Agent ONLY (CLI `browse.mjs` or MCP tools) |

Prompts: `PROMPT-claude-native.md`, `PROMPT-codex-native.md`, `PROMPT-agent-arm.md`
(shared by both `*-agent` arms). Tasks: `TASKS.md` (10 tasks, cap 15 actions each).

## Protocol

1. **Reps**: ≥3 per arm. One rep = one fresh session running all 10 tasks in order.
2. **Never two rounds at once** — the agent daemon shares port 8377; parallel rounds
   contaminated a previous evaluation (`../results/codex-self-v5.md`). Agent arms:
   start a fresh daemon per rep, `stop` it at the end.
3. **demo-qa (T8/T9)**: agent arms open
   `file://<repo>/packages/agent/demo-qa/app.html` directly. Native arms that can't
   open `file://` serve it first: `python3 -m http.server 8123 -d packages/agent/demo-qa`
   → `http://localhost:8123/app.html`. T9 continues T8's session (same page, no reload).
4. **Recording**: the runner writes `results/<arm>-r<rep>.json` (schema below) and
   optionally a narrative md. Failures, dead ends and action counts go in verbatim —
   a claimed:false with honest notes is a valid data point; an inflated claimed:true
   becomes a FALSE GREEN when judged.
5. **Judge immediately after the rep** (T1/T4 are tolerance-judged against live
   sources): `node packages/agent/experiment/formal/judge.mjs results/<file>.json`
6. **Aggregate**: `node packages/agent/experiment/formal/report.mjs` → markdown
   tables for the paper.

## Result file schema

```json
{
  "arm": "claude-native | claude-agent | codex-native | codex-agent",
  "runner": "claude | codex",
  "model": "<model id as reported by the runner>",
  "rep": 1,
  "date": "2026-07-31",
  "notesGlobal": "anything that affected the whole rep",
  "entries": [
    {
      "task": "hn-top",
      "claimed": true,
      "answer": "Some Title | 45",
      "finalUrl": "https://news.ycombinator.com/item?id=…",
      "actions": 3,
      "wallMs": 2100,
      "tokensObserved": null,
      "notes": "how it went, method used, dead ends"
    }
  ]
}
```

Field rules:
- `claimed` — the runner's OWN belief that the task succeeded. The gap between
  `claimed` and the judge's verdict is a first-class metric (false-green rate).
- `actions` — page-affecting or page-reading operations: tool calls / extension
  calls / CLI verbs. Planning text does not count. Cap is 15; hitting the cap =
  `claimed: false` with notes.
- `wallMs` — wall time from the first action of the task to the answer being
  recorded. Claude arms: `date +%s%3N` before/after. Agent arms may additionally
  report per-verb daemon ms from `packages/agent/logs/*.jsonl` in notes.
- `tokensObserved` — only if the interface actually exposes it (agent arm: sum of
  output KB is acceptable in notes; native arms: usually `null`). **Never estimate.**

## Measurement asymmetries (declared, not hidden)

- The agent CLI chains many verbs per model turn; the Chrome extension forces ~1
  action per turn. Wall time includes that turnaround — it is part of operating
  each interface. Report both wall and per-verb time where available.
- `codex-native` may legitimately solve tasks with curl/scripts instead of a
  browser; record the method in notes. If a task is unreachable that way (dynamic
  pages, captchas), that is a finding about the stack, not noise.
- Live sites are not stationary (T1/T4 tolerance-judged; T5 non-deterministic for
  every arm). The demo-qa tasks (T8/T9) are the deterministic control.

## Anti-circularity

Judges (`tasks.mjs`) use plain fetch + constants: Hacker News Firebase API,
raw.githubusercontent, api.npmjs.org, URL patterns, and the demo app's known
truth. No arm's own assertions are ever used as ground truth.
