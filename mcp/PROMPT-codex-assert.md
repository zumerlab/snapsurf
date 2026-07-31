# Prompt for Codex — browser_assert round (F2 consumer validation) (copy-paste)

New tool since your MCP round: `browser_assert` — the deterministic-assertions ask
from your own report, built on the diff. This round you evaluate it as what it wants
to be: **the replacement for fragile visual assertions in a QA pipeline**.

Setup: same as last time — `node packages/agent/mcp/server.mjs` over stdio,
`tools/list` is your documentation. The server also gained structuredContent
everywhere, lifecycle ownership of the daemon, and English surfaces since your round.

Part 1 — run the reference demo and audit it:
- `node packages/agent/demo-qa/run-demo.mjs` (read its README first). Reproduce its
  two results. Then try to BREAK T2: find a way to make the no-op assertion flaky
  (add waits, repeat runs, resize, whatever a hostile CI would do). Report attempts
  and outcomes.

Part 2 — write your own mini QA suite on a real site (pick one you know from the
previous rounds, e.g. wikipedia or the HN login-less flows), entirely through MCP:
at least 5 assertions covering: an exact semantic effect (mustInclude with kind+name),
a faithful negative (changed:false after a no-op), an existence check, a notCovered
check, and a url check after navigation. Count calls and wall time per assertion.

Part 3 — the verdict that matters:
1. Is the assertion vocabulary sufficient for the tests you would actually write?
   What is missing (state queries? counts? text-equals vs includes? waits/retries
   built in? causality/target-scoping from your last report)?
2. Is `{pass, checks[]}` in structuredContent enough for a runner to consume with
   ZERO prose parsing? Any field you still had to fish out of text?
3. The baseline-consumption semantics (assert advances the diff baseline like
   verify): footgun or fine? Did it bite you?
4. Would you now put this in an unattended QA pipeline? If not, what is the
   shortest list that gets it there?

Report → `packages/agent/experiment/results/codex-assert.md`. Spanish prose is fine
for the report body. No sugar-coating. Kill every daemon/server at the end
(`pgrep -f browse.mjs`, `pgrep -f server.mjs`).
