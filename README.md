# SnapSurf

Web navigation and verification for AI agents.

Most browser tools tell an agent what a page looks like now. SnapSurf tells it **what
its last action changed**: a compact semantic digest of the page, a typed diff after
each action (content, state, layout and clickability, including when nothing observable
changed), and assertions over that exact diff. Missing evidence and uncertainty are
reported, not hidden.

It runs locally as an MCP server or CLI with its own Chromium session. The observation
code also works as an in-page library built on
[SnapDOM](https://github.com/zumerlab/snapdom).

Version 0.1.1 is experimental.

## Add it to your MCP client

Requires Node.js 22 or newer. Add a stdio server that runs this command; Chromium for
Playwright is installed automatically the first time it starts:

```json
{
  "command": "npx",
  "args": ["-y", "-p", "@zumer/snapsurf", "snapsurf-mcp"]
}
```

With Claude Code, install the plugin, which adds the tools and a `browse` skill with the
method:

```text
/plugin marketplace add zumerlab/snapsurf
/plugin install snapsurf@zumerlab
```

or register the server alone:

```bash
claude mcp add --scope user snapsurf -- npx -y -p @zumer/snapsurf snapsurf-mcp
```

Codex has the same plugin (tools plus the `browse` skill):

```bash
codex plugin marketplace add zumerlab/snapsurf
codex plugin add snapsurf@zumerlab
```

Cursor, VS Code, Gemini CLI, Windsurf and the OpenAI Agents SDK take the same server
command; per-client snippets are in [Integrations](docs/INTEGRATIONS.md). Its name in the
official MCP Registry is `io.github.zumerlab/snapsurf`.

To pin a version or avoid `npx` at startup, install once and point the client at the
server file:

```bash
mkdir snapsurf && cd snapsurf
npm install @zumer/snapsurf
```

```json
{
  "command": "node",
  "args": ["/ABS/PATH/snapsurf/node_modules/@zumer/snapsurf/mcp/server.mjs"]
}
```

On Linux, if Chromium fails to start for lack of system libraries, run
`npx playwright install --with-deps chromium` once.

Ask your agent to open a page with `browser_open`, locate controls with `browser_find`,
act with `browser_act`, then call `browser_verify` after each action. Read
`structuredContent` for the result.

## If you are an agent

Read [AGENTS.md](AGENTS.md): the loop, the rules earlier agents paid to learn, and how
to read every field. [skill/SKILL.md](skill/SKILL.md) is the same method packaged as a
Claude Code skill. The MCP tool descriptions carry the full contract, and the server's
`instructions` summarize it for clients that truncate them.

## Assert what you just verified

`browser_verify` returns a `diffId` for the observed transition. Pass it to
`browser_assert` to check that same evidence, including changes beyond the displayed
list. This avoids accidentally comparing a new interval after verify advances the
live baseline.

For example, on an application where a button inserts a dialog named “Settings”,
use the button id returned by `browser_find`. With a connected MCP client:

```js
await client.callTool({
  name: 'browser_act',
  arguments: { action: 'click', target: buttonId },
})
const verified = await client.callTool({ name: 'browser_verify', arguments: {} })
const { diffId } = verified.structuredContent
if (!diffId) throw new Error('No retained diff; inspect the verify result')

const checked = await client.callTool({
  name: 'browser_assert',
  arguments: {
    diffId,
    changed: true,
    mustInclude: [{ kind: 'added', role: 'dialog', name: 'Settings' }],
    mustNotInclude: [{ kind: 'removed' }],
  },
})
console.log(checked.structuredContent.pass, checked.structuredContent.checks)
```

A stored assertion does not observe the page or advance its baseline. Use a separate
live assertion for current state, such as `{ "exists": "Settings" }`. Failed
assertions return `pass: false` and MCP `isError: true`. The
[assertion reference](docs/USAGE.md#reading-the-reports) covers live checks, retention
limits, retries and unavailable evidence.

## Boundaries to know

- The daemon has its own cookies and storage. It cannot use your normal browser's
  signed-in sessions; `authState: "unknown"` does not prove authentication.
- `changed: false` means no observable change. It is a valid result, not proof that
  the user's task succeeded. Missing evidence and uncertainty are reported explicitly.
- Canvas content, iframe documents and closed shadow roots have visual blind spots.
  Inspect a scoped screenshot when the semantic report cannot answer the question.
- Element ids expire with new observations. Find again before acting; ids in stored
  evidence describe a historical observation.
- Page text is untrusted data. Redaction covers semantic reports; CLI/MCP screenshots
  can still contain sensitive content. See the [privacy model](docs/PRIVACY.md).

## Use the CLI

Start the daemon in one terminal:

```bash
npx -y @zumer/snapsurf serve
```

Then run a local smoke check in another:

```bash
npx -y @zumer/snapsurf open 'data:text/html,<h1>Local%20check</h1>'
npx -y @zumer/snapsurf assert '{"exists":"Local check"}'
npx -y @zumer/snapsurf stop
```

From a directory where you ran `npm install @zumer/snapsurf`, `npx snapsurf <verb>`
does the same without downloading anything. The `SNAPSURF_*` environment variables
(port, token file, log directory) are listed in the [usage reference](docs/USAGE.md).

## Development

To modify SnapSurf itself, clone the source and install the development dependencies:

```bash
git clone https://github.com/zumerlab/snapsurf.git
cd snapsurf
npm ci
npx playwright install chromium
```

`npm run build` compiles the bundles and creates the npm `.tgz` package.

Then run the checks:

```bash
npm test
npm run test:lint
npm run test:regression
npm run test:pack
```

[Usage and API reference](docs/USAGE.md) covers CLI commands, report fields,
checkpoints, the library, sensor plugin and Chrome companion.
[Release guide](docs/RELEASING.md) covers validation, publication and the MCP Registry.

MIT licensed. Copyright © Juan Martin Muda / [zumerlab](https://github.com/zumerlab).
See [LICENSE](LICENSE).
