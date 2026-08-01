# Privacy: exactly what leaves the page, and how to audit it

One page. If a string is not listed under "what travels", it does not travel.

## What travels in an observation (digest / diff / checkpoint)

| Channel | Content | Redactable? |
|---|---|---|
| `name` / `label` | Accessible names of nodes (buttons, links, headings) | yes — redact rules |
| `text` | Visible text of nodes (pre-truncated ~80c; find/match up to 300c) | yes — redact rules |
| `state` string values | e.g. `aria-expanded`, selected option label | yes — redact rules |
| Change entries (`changes`, `actionabilityDelta`) | kind + role + the fields above, before/after | yes — same rules, same pass |
| `url` | origin + pathname only; **query strings never travel by default** (daemon logs them as `?«N chars»`; the companion offers opt-in `fullUrl`) | structural |
| Geometry / roles / ids | bbox, vbox, role, `n_xxx` ids, selectors | not text — nothing to redact |

## What NEVER travels, rules or no rules

- **Input values.** The snapshot stores only a mask (`•••`, capped length) plus a
  content hash used solely for change detection. The raw value of any
  `<input>`/`<textarea>` is never serialized; sensitive input types skip even the
  mask. (The hash is deterministic, not salted — a holder of a checkpoint could
  verify a *guessed* value against it, so treat stored checkpoints of pages with
  secret input values as sensitive artifacts.)
- **Typed text in logs.** The daemon JSONL records `type` as `«N chars»`.
- **Redact rule terms in logs.** A `redact` command is logged as `«N rule(s)»`.
- Pixels, unless explicitly requested (`snap`/`shot`/`browser_screenshot`).

## Redact rules

A rule is a plain string; matching is case-insensitive substring. Any `name`,
`label`, `text` or state string containing a rule term leaves every surface as
`[redacted]` — snapshot views, diffs, digests, `find`/`match` results, `text`
verb reads, section headings, click echoes.

- Core API: `inspect(el, { privacy: { redact: ['Jane Doe', 'ACME'] } })`
- Daemon: `serve --redact "Jane Doe,ACME"` or at runtime `redact Jane Doe,ACME`
  (`redact off` clears; bare `redact` shows the count)
- MCP: `browser_open` with `redact: ["Jane Doe", "ACME"]` (session-wide until replaced)
- Companion: any `SNAPDOM_OBSERVE`/`SNAPDOM_ASSERT` message with
  `privacy: { redact: [...] }` (sticky for the session; `privacy: null` clears)

Matching is NOT affected: node identity rides fingerprints and hashes, so diffs
stay correct across redacted content.

## The audit report

Every observation taken with active rules carries a `privacy` report:

```json
{ "rulesActive": 2,
  "hitsByRule": [{ "rule": "#0", "hits": 4 }, { "rule": "#1", "hits": 2 }],
  "fields": { "name": 4, "text": 2 },
  "nodesRedacted": 4 }
```

- Rules are identified **by index, never by text**: the report travels to the
  consumer (an LLM), and naming the rule would leak the exact string the operator
  asked to hide. The operator maps `#0`, `#1`… back to their own rule list.
- `rulesActive` with zero hits is still reported — "the rules are running and
  matched nothing" is auditable information.
- Surfaces: `ui.privacy` (core), the `privacy:` line + JSONL `meta.privacy`
  (daemon), `structuredContent.privacy` (MCP), `result.privacy` (companion).

## Probing is refused, loudly

A text predicate whose query touches a redact rule (either direction of
substring) would confirm the hidden term's presence — a 1-bit leak around the
redaction. `assert exists` / `notCovered` on such a query fails with
`actual: "blocked by privacy rule"` instead of answering. `find`/`match` simply
cannot match redacted strings (they search the redacted view).

## Threat model, honestly

Redaction is applied at the moment strings leave the page world. It protects
against the *consumer* (the model reading observations) — it is not a defense
against code running in the page itself, which by definition already has the DOM.
Screenshots (`snap`/`shot`) are pixels and are NOT redacted; if a region is
sensitive, do not request its pixels.

Verified by: `test/privacy-probe.test.js` (core, 8 tests), `companion/gate.mjs`
(5 privacy checks against a real page), and the daemon/MCP smoke flows.
