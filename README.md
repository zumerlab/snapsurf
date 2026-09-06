# SnapSurf

Web navigation and verification for AI agents.

SnapSurf gives browser agents a compact page summary, a typed diff after each
action, and assertions over that diff. It reports changes to content, state, layout
and clickability, including when an action produces no observable change.

It runs locally through an MCP server or CLI, using its own Chromium session. The
observation code also works as an in-page library built on
[SnapDOM](https://github.com/zumerlab/snapdom).

Version 0.1.0 is experimental.

## Install from npm

Requires Node.js 22 or newer. Create a separate installation directory:

```bash
mkdir SnapSurf
cd SnapSurf
npm install @zumer/snapsurf
npx playwright install chromium
```

`npm install` installs SnapSurf; the Playwright command downloads its Chromium browser.
This installation becomes available when the first npm release is published.
On Linux, use `npx playwright install --with-deps chromium` if system libraries
are also needed.

## Connect your MCP client

Add a stdio MCP server to your client with these settings, replacing the path with
the absolute path to the directory where you ran `npm install`:

```json
{
  "command": "node",
  "args": ["/ABS/PATH/node_modules/@zumer/snapsurf/mcp/server.mjs"]
}
```

The MCP server starts the browser daemon when needed. Client configuration examples
are in [Integrations](docs/INTEGRATIONS.md).

Ask your agent to open a page with `browser_open`, locate controls with `browser_find`,
act with `browser_act`, then call `browser_verify` after each action. Read
`structuredContent` for the result.

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

From the directory where you installed SnapSurf, start the daemon in one terminal:

```bash
npx snapsurf serve
```

Then run a local smoke check in another:

```bash
npx snapsurf open 'data:text/html,<h1>Local%20check</h1>'
npx snapsurf assert '{"exists":"Local check"}'
npx snapsurf stop
```

## Development

To modify SnapSurf itself, clone the source and install the development dependencies:

```bash
git clone https://github.com/zumerlab/SnapSurf.git
cd SnapSurf
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
[Release guide](docs/RELEASING.md) covers validation and manual publication.

MIT licensed. Copyright © Juan Martin Muda / [zumerlab](https://github.com/zumerlab).
See [LICENSE](LICENSE).
