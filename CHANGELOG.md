### Changelog

All notable changes to this project will be documented in this file.

#### [v0.1.3](https://github.com/zumerlab/snapsurf/compare/v0.1.2...v0.1.3)

> 8 September 2026

- Add comprehensive tests for change presentation, daemon compatibility, and select names [`ce204e4`](https://github.com/zumerlab/snapsurf/commit/ce204e45f16b739b7b650cc1073001120f183b03)

# Changelog

## 0.1.2

- Fix MCP plugin startup from a SnapSurf checkout by explicitly selecting the
  `@latest` npm tag; the bare package name could select the checkout without a
  runnable `snapsurf-mcp` bin and close the connection before initialization.
- Add bounded long-text reads with `maxChars`, observation-bound continuation and
  `capturedAt`; search can return longer context under a shared character budget.
- Preserve full structured link destinations. Report requested/final navigation
  URLs and observed HTTP redirects, and provide source-preserving PDF handoffs to
  external readers without claiming to extract PDF text.

## 0.1.1

- Declare `mcpName` (`io.github.zumerlab/snapsurf`) and ship `server.json` for the
  official MCP Registry; `npm run test:pack` checks that both stay in sync with the
  package version.
- Run from npm without a separate install: `npx -y -p @zumer/snapsurf snapsurf-mcp`
  for the MCP server and `npx -y @zumer/snapsurf serve` for the CLI. Chromium for
  Playwright is installed automatically on first start when it is missing.
- Add a `title` and MCP annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) to every tool, and server `instructions` with
  the browsing loop for clients that truncate tool descriptions. The server reports its
  package version.
- Rename the remaining development-era identifiers: configuration uses `SNAPSURF_*`
  variables, the global install lives in `~/.snapsurf/`, the Claude Code skill is
  `snapsurf`, and the daemon identifies itself as `snapsurf`. The `SNAPDOM_AGENT_*`
  variables and the old token paths are still read as fallbacks. Re-run
  `node tools/install-global.mjs` and stop daemons started by 0.1.0.
- Documentation: npx-first installation, per-client snippets, environment variables,
  `AGENTS.md` shipped in the package, repository links to `zumerlab/snapsurf`.

## 0.1.0

First experimental release of SnapSurf, with a local CLI, MCP server and
browser extension for observing pages and checking changes.

- Read a semantic page summary and find elements by text.
- Report changes to content, state, layout and visibility.
- Save the complete verification diff under a `diffId`, then assert against the
  same evidence without observing again or advancing the live baseline.
- Evaluate assertions against all changes, including entries outside the displayed
  summary. Declare uncertainty when a region cannot be observed.
- Keep browser sessions and their retained evidence isolated. Invalidate saved
  diffs when privacy rules change, and fail explicitly when evidence is unavailable.
- Report failed MCP assertions with `isError: true` and structured check results.
- Distribute under the MIT license, by Juan Martin Muda / zumerlab.

The CLI and MCP use their own browser sessions. Visual details and unobservable
regions may need screenshots. See [usage and limits](docs/USAGE.md).
