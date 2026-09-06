# Changelog

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
