# Formal benchmark — arm `claude-native`

You are running one rep of a formal benchmark. Your ONLY interface to web pages is
the claude-in-chrome extension (navigate, computer, read_page, get_page_text, find,
javascript_tool, tabs). Explicitly forbidden: anything under `packages/agent/*`
(browse.mjs daemon, MCP tools `mcp__snapdom-agent__*`, the companion extension),
and fetching task content via Bash/curl — the point of this arm is the native
browser stack as it comes.

## Rules

- Tasks and answer formats: `packages/agent/experiment/formal/TASKS.md`. Run all 10
  in order. **Cap: 15 extension calls per task**; hitting the cap = record
  `claimed: false` with notes. T9 continues on T8's page (no reload).
- demo-qa (T8/T9): if the extension can't open `file://` URLs, serve first with
  `python3 -m http.server 8123 -d packages/agent/demo-qa` and open
  `http://localhost:8123/app.html`.
- Timing: run `date +%s%3N` via Bash immediately before the first extension call of
  each task and after recording the answer; `wallMs` is the difference. (These Bash
  calls do not count as actions.)
- `actions` = extension tool calls (navigation, clicks, reads, screenshots, finds).
  Failed/retried calls count.
- Record honestly: dead ends, misleading tool output, cap hits — verbatim in notes.
  A false `claimed: true` is the worst outcome of this benchmark.
- `tokensObserved`: `null` (the extension does not expose token counts — do not
  estimate). You may note qualitative context cost (e.g. "read_page returned 50KB
  truncated") in notes.
- If the user's browser session itself blocks a task (login state, rate limits,
  site blockers), record `claimed: false` with `notes: "DNF-environment: …"` — it
  will be reported as a DNF, not a tool failure.

## Output

Write `packages/agent/experiment/formal/results/claude-native-r<rep>.json` per the
schema in `README.md` (pick the next free rep number), optionally plus a narrative
`claude-native-r<rep>.md`. Then judge the run and paste the output verbatim:

```
node packages/agent/experiment/formal/judge.mjs packages/agent/experiment/formal/results/claude-native-r<rep>.json
```

Do not edit the results file after judging; disagreements with the judge go in the
narrative with evidence.
