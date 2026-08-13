# QA without visual assertions — demo

A minimal, complete example of the pattern the benchmark measured
(`experiment/results/bench-qa.md`: oracle 19/19 · 0 false positives, vs pixel-diff
13/19 · 5/8 false positives on noise): **assert the semantic diff, not the pixels**.

## The app

`app.html` is a todo list that carries ambient noise on purpose — a live clock and a
CSS spinner. That is what real pages look like, and it makes every screenshot
assertion around it flaky by construction.

## The tests

```bash
node demo-qa/run-demo.mjs
```

Two cases, both run end-to-end THROUGH the MCP server (`browser_open`, `browser_find`,
`browser_act`, `browser_assert`):

**T1 — the action worked, precisely:**

```js
await tool('browser_assert', {
  changed: true,
  mustInclude: [{ kind: 'added', name: 'Buy milk' }],
  exists: 'Buy milk',
})
// PASS (3/3 checks) — the assertion names WHAT changed, not how many pixels moved
```

**T2 — the action did NOTHING (the assertion pixels cannot express):**

```js
await tool('browser_act', { action: 'click', target: refreshBtn.id })
await tool('browser_assert', { changed: false })
// PASS — while the clock ticks and the spinner spins
```

The same no-op under a screenshot assertion: **264 pixels differ (clock + spinner)
→ flaky failure**. The oracle's evidence for the whole check: ~61 bytes.

## Why this matters for a QA pipeline

- A **failed** `browser_assert` is a structured RESULT (`{pass:false, checks:[…]}`),
  not prose to parse and not a tool error.
- The **faithful negative** (`changed:false`) turns "my click was a no-op" into a
  first-class, non-flaky assertion — the class of bug agents silently ship past.
- `mustInclude` asserts by meaning (`kind` + `role` + `name`), so a CSS refactor,
  an animation, a timestamp or a scroll cannot break the test.

## Assertion vocabulary

| Field | Checks |
|---|---|
| `url` | current URL contains the substring |
| `changed` | the diff since the last observation is exactly true/false |
| `mustInclude` | `[{kind, role, name}]` entries present in the diff (kind ∈ added/removed/content/state/style/moved/resized) |
| `exists` | text findable anywhere on the page |
| `notCovered` | the best match for a text is not occluded |

`browser_assert` consumes the diff baseline (like `browser_verify`): one call covers
act → assert.
