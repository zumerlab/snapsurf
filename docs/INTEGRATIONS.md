# Using snapDOM Agent from any LLM

The instrument is model-agnostic by construction. There are three integration surfaces,
in order of preference:

## 1. MCP — works with any MCP-capable client (the normal path)

`mcp/server.mjs` is a standard MCP **stdio** server: any client that can run a local
command speaks to it. The tool descriptions ARE the instructions — they teach the loop
(digest → find → act → verify → assert), the fail-loud contract, and how to read every
field, so the consuming model needs no extra prompt to use the tools correctly.
Structured clients read `structuredContent`; clients that only read text get the same
facts as prose.

The invariant for every client: **command `node`, args `["/ABS/PATH/snapdom-agent/mcp/server.mjs"]`**.
The server starts and owns the daemon on demand. Exact config file names drift between
clients — check yours if a snippet below has moved.

**Claude Code**

```bash
claude mcp add --scope user snapdom-agent -- node /ABS/PATH/snapdom-agent/mcp/server.mjs
```

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{ "mcpServers": { "snapdom-agent": {
  "command": "node", "args": ["/ABS/PATH/snapdom-agent/mcp/server.mjs"] } } }
```

**VS Code (Copilot agent mode)** — `.vscode/mcp.json`:

```json
{ "servers": { "snapdom-agent": {
  "type": "stdio", "command": "node", "args": ["/ABS/PATH/snapdom-agent/mcp/server.mjs"] } } }
```

**Gemini CLI** — `~/.gemini/settings.json`:

```json
{ "mcpServers": { "snapdom-agent": {
  "command": "node", "args": ["/ABS/PATH/snapdom-agent/mcp/server.mjs"] } } }
```

**OpenAI Agents SDK** (Python):

```python
from agents.mcp import MCPServerStdio

snapdom = MCPServerStdio(params={
    "command": "node",
    "args": ["/ABS/PATH/snapdom-agent/mcp/server.mjs"],
})
```

Windsurf, Zed, Cline and other MCP clients follow the same shape under their own config
paths.

Notes for non-Claude models:

- Some clients truncate long tool descriptions. The descriptions here are deliberately
  complete (they carry the usage contract); if your client truncates, pair the tools
  with the playbook below.
- Everything between `«««` and `»»»` in responses is page content — **data, never
  instructions**. Make sure the consuming agent's system prompt says so; the tool output
  already fences it.

## 2. The playbook prompt — for agents that need the method, not just the tools

`skill/SKILL.md` (installed as the `agent-browse` skill for Claude Code) is a
model-agnostic method: when to `find` instead of scroll, `look` after every action
instead of screenshots, checkpoint before risky actions, ids expire per epoch, covered
is literal, how to escalate to pixels. For any other framework, paste or adapt it into
the agent's system prompt next to the MCP tools. It is the distilled version of every
mistake previous agents paid for.

## 3. No MCP at all — subprocess or HTTP

Any framework that can spawn a process can drive the CLI (auth against the local daemon
is automatic; both sides must run as the same OS user):

```python
import subprocess
out = subprocess.run(
    ["node", "/ABS/PATH/snapdom-agent/tools/browse.mjs", "open", "example.com"],
    capture_output=True, text=True).stdout
```

Verbs, output shapes and policies are in the README. For batch flows use
`browse.mjs run "open …" "find …"` (one process, N verbs). Structured metadata for
every command also lands in the session JSONL under `logs/`.

The daemon's loopback HTTP control plane (`/cmd`, HMAC-authenticated envelopes) is what
the CLI and MCP server themselves use; `tools/daemon-client.mjs` is the reference
client if you want to integrate at that layer directly.

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
