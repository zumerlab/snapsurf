# Formal benchmark — arm `codex-native` (your own stack)

You are running one rep of a formal benchmark comparing web-task stacks. This arm
measures YOUR native capabilities, exactly as they come: use any tooling you
normally have (shell, curl, scripts you write yourself, a browser if your harness
provides one). The ONE restriction: nothing under `packages/agent/*` — no
browse.mjs, no snapdom MCP tools, no companion extension. You have used those in
prior rounds; this arm is the baseline they are compared against, so keeping it
clean is what makes your previous results meaningful.

## Rules

- Tasks and answer formats: `packages/agent/experiment/formal/TASKS.md`. Run all 10
  in order. **Cap: 15 actions per task** (an action = a command/tool call that reads
  or affects the target site; writing your own helper script counts as 1 action when
  executed, not per line). Hitting the cap = `claimed: false` with notes.
- demo-qa (T8/T9): the app is `packages/agent/demo-qa/app.html`. T8/T9 require
  actually driving the page (form submit, button click) and observing the result —
  a static read of the HTML file does not perform the task; if your stack cannot
  drive a page, record `claimed: false` with notes saying so. That is a finding
  about the stack, not a trick: T9's question ("did the click change the app
  state?") only exists at runtime.
- **Record your METHOD per task in notes** (e.g. "curl + grep", "wrote a Playwright
  script", "no browser available"). Method choice is data for this benchmark, not
  something to hide. If a site blocks your method (captcha, dynamic rendering),
  record it verbatim.
- Timing: `wallMs` from the first action of a task to the answer recorded, measured
  with real timestamps (e.g. `date +%s%3N`), not estimated.
- `tokensObserved`: only if your harness actually reports token usage per task;
  otherwise `null`. Never estimate.
- Record honestly — dead ends and failures verbatim. A false `claimed: true` is the
  worst outcome of this benchmark.

## Output

Write `packages/agent/experiment/formal/results/codex-native-r<rep>.json` per the
schema in `README.md` (runner: "codex"; pick the next free rep number), optionally
plus a narrative `codex-native-r<rep>.md` with a per-task table (method, actions,
wall ms, outcome) and findings. Then judge the run and paste the output verbatim:

```
node packages/agent/experiment/formal/judge.mjs packages/agent/experiment/formal/results/codex-native-r<rep>.json
```

Do not edit the results file after judging; if you believe a judge verdict is
wrong, argue it in the narrative with evidence.
