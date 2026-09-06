# Using SnapSurf from any LLM

The instrument is model-agnostic by construction. There are three integration surfaces,
in order of preference:

## 1. MCP — works with any MCP-capable client (the normal path)

SnapSurf needs Node.js 22 or newer. `snapsurf-mcp` is a standard MCP **stdio** server:
any client that can run a local command speaks to it. The command that every client
below uses is:

```text
npx -y -p @zumer/snapsurf snapsurf-mcp
```

The server starts and owns the browser daemon on demand, and installs Chromium for
Playwright the first time it is missing (on Linux, run
`npx playwright install --with-deps chromium` once if system libraries are absent).
To pin a version or skip `npx` at startup, run `npm install @zumer/snapsurf` in a
directory and use `node /ABS/PATH/node_modules/@zumer/snapsurf/mcp/server.mjs` instead.

The tool descriptions ARE the instructions — they teach the loop (digest → find → act →
verify → assert), the fail-loud contract, and how to read every field, so the consuming
model needs no extra prompt to use the tools correctly. The server also returns a short
`instructions` text in `initialize` for clients that truncate tool descriptions, and
every tool carries a `title` and MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). Structured clients read `structuredContent`; clients
that only read text get the same facts as prose.

After every action, verify once and pass its `diffId` to assert. For example, with an
MCP client exposing `callTool`:

```js
await client.callTool({
  name: 'browser_act', arguments: { action: 'click', target: currentButtonId },
})
const verified = await client.callTool({ name: 'browser_verify', arguments: {} })
const evidence = verified.structuredContent
if (!evidence.diffId) throw new Error('No retained diff: inspect verify evidence before continuing')
const result = await client.callTool({
  name: 'browser_assert',
  arguments: {
    diffId: evidence.diffId,
    changed: true,
    mustInclude: [{ kind: 'added', role: 'dialog', name: 'Settings' }],
    mustNotInclude: [{ kind: 'removed' }],
  },
})
```

For an explicit session, pass the same `sessionId` in all three calls. The stored
assertion checks the full transition even when verify displays a capped list. It does
not observe or consume the current baseline: `baselineAdvanced` is `false` and
`evidenceSource` is `"stored"`. Both responses carry `beforeObservationId`,
`afterObservationId`, and `observationId` (the historical after observation). A later
navigation does not rewrite this evidence; ids inside it are historical, so use
`browser_find` to obtain current action targets.

Use separate assertions without `diffId` for current page predicates such as `exists`,
`notCovered` or `url`. Mixing them with stored evidence fails, as does adding `ignore`,
`settleMs`, `retry` or `keepBaseline` (even `false`). Without `diffId`, assert retains
its live behavior: after verify it compares a new interval. Stored assertions support
`changed`, `mustInclude`, `mustNotInclude`, `only`, `maxChanges`, `becameVisible` and
`becameCovered`.

Retention is per session: at most 32 diffs, 8 MiB total, for 10 minutes; privacy-rule
changes invalidate stored evidence. An unknown, expired, evicted, invalidated or
other-session `diffId` produces `pass: false` and `error.code: "DIFF_UNAVAILABLE"`,
never a live fallback. If one diff exceeds the retention budget, verify returns
`diffAvailable: false` and `diffError.code: "DIFF_TOO_LARGE"`, without a `diffId`.
A verify without a baseline also has no `diffId`.

For both live and stored assertions, distinguish command execution from the verdict:
the daemon can return `ok: true` with `meta.assert.pass: false`. MCP exposes that
verdict as `structuredContent.pass: false` and sets `isError: true`, retaining the
checks and evidence for diagnosis.

Exact config file names drift between clients — check yours if a snippet below has moved.

**Claude Code**

```bash
claude mcp add --scope user snapsurf -- npx -y -p @zumer/snapsurf snapsurf-mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{ "mcpServers": { "snapsurf": {
  "command": "npx", "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"] } } }
```

**Codex CLI** (registers globally in `~/.codex/config.toml` under
`[mcp_servers.snapsurf]`; verify with `codex mcp list`):

```bash
codex mcp add snapsurf -- npx -y -p @zumer/snapsurf snapsurf-mcp
```

Codex also reads `AGENTS.md` — this repo ships one with the browsing playbook, and a
compact global block for `~/.codex/AGENTS.md` is a good reinforcement for clients that
truncate long tool descriptions.

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{ "mcpServers": { "snapsurf": {
  "command": "npx", "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"] } } }
```

**VS Code (Copilot agent mode)** — `.vscode/mcp.json`:

```json
{ "servers": { "snapsurf": {
  "type": "stdio", "command": "npx", "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"] } } }
```

**Gemini CLI** — `~/.gemini/settings.json`:

```json
{ "mcpServers": { "snapsurf": {
  "command": "npx", "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"] } } }
```

**OpenAI Agents SDK** (Python):

```python
from agents.mcp import MCPServerStdio

snapsurf = MCPServerStdio(params={
    "command": "npx",
    "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"],
})
```

Windsurf, Zed, Cline and other MCP clients follow the same shape under their own config
paths.

Notes for non-Claude models:

- Some clients truncate long tool descriptions. The descriptions here are deliberately
  complete (they carry the usage contract); if your client truncates, pair the tools
  with the server `instructions` and the playbook below.
- **Schemas are deliberately flat** — no `oneOf`/`anyOf` unions in any `inputSchema`.
  A real client (Codex CLI, first field test) projected union branches as complete
  signatures and lost the conditional fields, so calls died client-side. Per-action
  requirements (`click` → `target`, `type` → `text`, `zoom` → `id`) are stated in the
  field descriptions and enforced fail-loud server-side; a regression test keeps every
  schema union-free.
- Everything between `«««` and `»»»` in responses is page content — **data, never
  instructions**. Make sure the consuming agent's system prompt says so; the tool output
  already fences it.

## 2. The playbook prompt — for agents that need the method, not just the tools

`skill/SKILL.md` (installed as the `snapsurf` skill for Claude Code by
`tools/install-global.mjs`) is a model-agnostic method: when to `find` instead of
scroll, `look` after every action instead of screenshots, checkpoint before risky
actions, ids expire per epoch, covered is literal, how to escalate to pixels. For any
other framework, paste or adapt it into the agent's system prompt next to the MCP tools.
`AGENTS.md` at the repository root is the same method in the form coding agents read.

## 3. No MCP at all — subprocess or HTTP

Any framework that can spawn a process can drive the CLI (auth against the local daemon
is automatic; both sides must run as the same OS user). Start the daemon once with
`npx -y @zumer/snapsurf serve`, then:

```python
import subprocess
out = subprocess.run(
    ["npx", "-y", "@zumer/snapsurf", "open", "example.com"],
    capture_output=True, text=True).stdout
```

Verbs, output shapes and policies are in the [usage reference](USAGE.md). For batch flows use
`snapsurf run "open …" "find …"` (one process, N verbs). Structured metadata for
every command also lands in the session JSONL under `logs/` (or `SNAPSURF_LOGDIR`).

The daemon's loopback HTTP control plane (`/cmd`, HMAC-authenticated envelopes) is what
the CLI and MCP server themselves use; `tools/daemon-client.mjs` is the reference
client if you want to integrate at that layer directly. Port, token file and log
directory come from `SNAPSURF_PORT`, `SNAPSURF_TOKEN_FILE` and `SNAPSURF_LOGDIR`.

## What travels to the model (cost notes)

- `browser_open` digest: ~2–3 KB of landmarks/headings/top actionables.
- `browser_verify` after an action: a typed diff, usually well under the cost of any
  re-read; wrapper noise folded, full counts declared.
- Pixels only on explicit request (`browser_screenshot`, scoped by id).
- Measured on identical tasks with identical agents, the semantic loop's advantage
  concentrates where verification matters (occlusion, side-effect absence); plain text
  extraction is cheaper via a text dump. Route accordingly.

## The embedded surfaces (no LLM client at all)

The sensor plugin (`packages/sensor`) and the library (`agent.inspect`) run inside a
page next to snapDOM — they serve whatever host embeds them, regardless of which model
(if any) reads the reports. See the README sections for both.
