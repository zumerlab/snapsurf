# A-bis — The verbs that had never been tested

2026-08-01 · runner: `experiment/abis-verbs.mjs` · **19/19 checks OK, on both installs**

Previous coverage, verified with a matcher over `test/`, `experiment/`,
`companion/gate.mjs` and `demo-qa/`: `rec` and `parent` appeared nowhere; `snap`, `cp` and
`map` only in `mcp/server.mjs`, which is the implementation and not a test.

Since 2026-08-01 the runner takes `--daemon <path>`, so the same checks run against the
repository tree **and** against the global install in `~/.claude/snapdom-agent`. That
second run is not optional: the global install had a broken bundle and no gate touched it.

## Result by verb

| Verb | Checks | State |
|---|---|---|
| `parent` | finds the node and climbs to the card with 2+ clickable things (sees the link **and** the button) | ✅ |
| `map` | first page 40 ids · offset 40 returns 22 new ones · **no overlap** | ✅ |
| `snap` | 60 KB PNG of the region plus enough surrounding context | ✅ |
| `cp` | `save` / `list` / `diff` against the named reference point | ✅ |
| `rec` | 296 KB GIF and 75 KB MP4 of the page (2 s) · scoped to one element · survives a navigation | ✅ |
| `find` | responds without throwing, returns ids | ✅ |
| `text` | returns the element's text | ✅ |
| `redact` | rules accepted at runtime · term absent from the summary · `[redacted]` visibly present · probing a hidden term fails loudly | ✅ |

`rec` produces **GIF89a through gifExport and MP4 through videoExport**, both using
snapDOM's public plugins, with no external codecs. Measured overhead: 2,200 ms for 2 s of
GIF and 2,053 ms for 2 s of MP4 — roughly real time, no meaningful penalty.

## Three findings that only appear by running it

### 1. Scoping in `rec` works; what misleads is taking the first id from `find`

First run: the "scoped" recording weighed the same as the full-page one and measured
1280×800. It looked as if `rec <id>` ignored the scope. **It does not.** Recording the
card by its exact id gives **326×106 px**, identical to its CSS box.

What had happened: the test took `match(/n_\w+/)` — the **first** id from the ranked
`find` — and for the query "Producto destacado" the top hit was a **page wrapper
(1264×270)**, not the heading and not the card. That is the known behaviour of the ranking:
containers concatenate the accessible names of their children and match everything.

**Consequence for callers**, and for our own documentation: *never take the first id from
`find` blindly.* Read the role, name and box before acting. The echo on `click` exists for
exactly this, but `rec` and `snap` have no such echo.

### 2. Documentation contradicts behaviour: a navigation does NOT abort a recording

It is documented that "a navigation aborts the recording, the element dies with the
document". Measured: with a 4-second recording and a **real navigation to another URL** at
800 ms, the recording **finished normally** and produced a valid 591 KB GIF.

Either the documentation went stale or the behaviour changed. Resolve which before
promising a caller anything about this edge.

### 3. The global install was broken and nothing was testing it

Adding `--daemon` immediately paid for itself. Against `~/.claude/snapdom-agent`, `find`
and `text` threw `window.__agentRedact is not a function` inside the page, because that
install's bundle was built from a second copy of the entry source that never received
`redactString`. `open` still worked, so the daemon looked healthy. Fixed by removing the
duplicate definition (`tools/sdk-bundle.mjs`), and both installs now pass 19/19.

## Still a decision, not a test

`rec` still has no defined user. A model is not going to watch a GIF frame by frame at any
reasonable cost; if the viewer is a human, the natural place for it is **evidence attached
to a check that failed**. Until that is decided, these checks are a smoke test that the
verb is not broken, not a validation of a product.
