# Prompt for a blind MCP review round (phase 1 gate, part c) — copy and paste

This round is different from the previous ones: you do **not** use the `browse.mjs`
command line and you do not use the skill. You consume the reader as an **MCP server**,
exactly as a client that knows nothing about this lab would.

Setup:

- Server: `node packages/agent/mcp/server.mjs` (stdio transport, one JSON-RPC message per
  line). Register it in your MCP tooling if you can; otherwise talk to it over raw stdio
  (initialize → tools/list → tools/call).
- The server starts the browser daemon by itself. Do not run `browse.mjs` by hand.

The rule of this round: **play blind.** Your only documentation is the descriptions
returned by `tools/list`. Do not use anything you know from earlier rounds about commands,
ids or command-line flows. If a description is not enough to work out how to use a tool,
that is a FINDING — write it down. It is exactly what this round measures: does the MCP
surface explain itself?

Tasks: the same 5 as always (HN top story and its comment count; open and closed issues on
zumerlab/snapdom; Wikipedia Argentina → the Mar del Plata link; npm preact weekly
downloads; eBay "vinyl record" → the first `/itm/` result). Cap of 15 calls per task.
Measure wall time per task and per call.

Report into `packages/agent/experiment/results/codex-mcp.md`:

1. A table: success · calls · wall time per task, compared against your own command-line
   numbers from round v4 (27.6 s total) and the gate's MCP reference (5/5 · 21 calls ·
   21.2 s).
2. **An assessment of the surface**: were the descriptions of the tools enough to operate
   with no outside documentation? Which one confused you, which one was missing, what tool
   would you invent? Did `browser_verify` change your flow — verifying instead of
   re-observing?
3. Transport friction: latencies, response sizes, protocol errors if there were any.
4. A verdict for an outside builder: is this integrable as it stands? What does it need
   before you would put it in a QA pipeline?

Do not sugar-coat it. When you finish, kill the server and check that no `browse.mjs`
daemon is left running (`pgrep -f browse.mjs`).
