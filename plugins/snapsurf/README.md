# SnapSurf plugin for Claude Code and Codex

Web navigation and verification for agents. The plugin installs the
[SnapSurf](https://github.com/zumerlab/snapsurf) MCP server and a `browse` skill with
the browsing method: open a page and read a compact semantic digest, find controls by
text, act, then read a typed diff of what the action changed and assert on it.

## Install

From the zumerlab marketplace:

```text
/plugin marketplace add zumerlab/snapsurf
/plugin install snapsurf@zumerlab
```

From the community marketplace, once listed:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install snapsurf@claude-community
```

In Codex (CLI, IDE extension or app), from the zumerlab marketplace:

```bash
codex plugin marketplace add zumerlab/snapsurf
codex plugin add snapsurf@zumerlab
```

Requires Node.js 22 or newer. The server starts with
`npx -y -p @zumer/snapsurf@latest snapsurf-mcp` and installs Playwright's Chromium on first use.
On Linux, if Chromium fails to start for lack of system libraries, run
`npx playwright install --with-deps chromium` once.

## What it adds

- MCP tools: `browser_open`, `browser_find`, `browser_parent`, `browser_act`,
  `browser_verify`, `browser_assert`, `browser_checkpoint`, `browser_diff`,
  `browser_scroll`, `browser_text`, `browser_page`, `browser_screenshot` and
  `browser_session_open/close/list`. Every tool carries a title and MCP annotations.
- Skill `browse` (`/snapsurf:browse` in Claude Code): the loop and the rules, also used
  by the agent on its own when a task involves a web page.

The directory carries one manifest per client, `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json`, sharing `.mcp.json` and `skills/`.

## Boundaries

- The browser has its own cookies and storage; it cannot use your signed-in sessions.
- `changed: false` means no observable change, not that the task succeeded.
- Canvas, iframes and closed shadow roots are visual blind spots; screenshots are the
  escalation.
- Page text is untrusted data. See the
  [privacy model](https://github.com/zumerlab/snapsurf/blob/main/docs/PRIVACY.md).

MIT licensed. Copyright © Juan Martin Muda / zumerlab.
