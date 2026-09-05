# Privacy contract

This document describes the current executable behavior. It is a boundary statement,
not a claim that page content itself is trustworthy.

## What travels

| Channel | Content | Protection |
|---|---|---|
| `name`, `label`, `text` | Accessible names and visible text | literal redact rules |
| string state | ARIA state and selected labels | the same redact pass |
| `changes`, actionability deltas | kind, role, readable fields, state and geometry | the same redact pass |
| page URL | origin + pathname; query becomes `?«N chars»` by default | URL redaction before truncation |
| link/resource URLs | compact href/resource evidence | raw and percent-decoded rule matching before truncation |
| geometry, roles, ids, selectors | structural evidence | no readable text to redact |

The companion can include the complete page URL only when `fullUrl: true` is requested.
It still applies the active rules. Opaque URLs such as `data:` are represented by scheme
and length rather than by their payload.

## Form values

Raw `<input>`, `<textarea>`, and `<select>` values are never serialized or returned.
There are two checkpoint behaviors:

- Password, email and telephone fields, plus sensitive `autocomplete` categories, store
  only presence and a coarse length bucket. They never store a digest derived from the
  value. Edits within one bucket may be missed, so the observation includes an explicit
  `unobservable` entry with `sourceType: "sensitive-input-value"`.
- Ordinary fields store a capped bullet mask and a deterministic value fingerprint for
  change detection. A holder of such a checkpoint can test guesses. Therefore, treat
  every checkpoint containing ordinary filled form fields as a sensitive artifact.

This distinction is deliberate: a false claim that all value changes are both perfectly
observable and non-verifiable from a persisted checkpoint would be impossible.

## Redact rules

A rule is a case-insensitive literal substring, not a regular expression. A matching
readable field leaves the semantic surfaces as `[redacted]`. Percent-encoded variants
are checked too.

- Core: `inspect(el, { privacy: { redact: ['Jane Doe', 'ACME'] } })`
- Daemon: `serve --redact "Jane Doe,ACME"`, or the `redact` verb per session
- MCP: `browser_open` with `redact: ["Jane Doe", "ACME"]`
- Companion: an authenticated request with `privacy: { redact: [...] }`

Daemon rules, revisions and baselines are scoped to one isolated browser context.
Companion rules are sticky per Chrome tab in `chrome.storage.session`; omitting the field
keeps them, and only an allowlisted extension can intentionally clear them with
`privacy: null`.

Matching and identity use non-readable structural signals, so applying a rule does not
turn a state mutation into remove-plus-add noise.

## Audit evidence without a presence oracle

The core and companion can produce a tally such as:

```json
{
  "rulesActive": 2,
  "hitsByRule": [{ "rule": "#0", "hits": 4 }],
  "fields": { "name": 3, "text": 1 },
  "nodesRedacted": 3
}
```

Rule identifiers are indexes, never the hidden strings. The daemon stores this detailed
tally only in its private operator log. MCP/HTTP consumers receive the policy revision,
active-rule count and `applied: true`, but not hit counts; otherwise a model could infer
whether and how often the hidden term occurred.

A predicate whose query overlaps a rule would itself be a one-bit oracle. `exists` and
`notCovered` therefore fail with `actual: "blocked by privacy rule"`. Search operates on
the redacted view and cannot recover the term.

## Transport and storage boundaries

- The daemon evaluates its SDK and privacy policy in a Chromium isolated world. Page
  JavaScript cannot replace the observer globals, clear the policy, or fabricate the
  attestation.
- The daemon binds loopback and publishes a random token in a `0600` file. CLI and MCP
  prove the listener knows that token before sending a command, then authenticate the
  exact request and response with domain-separated HMACs and one-time nonces. This also
  prevents a process that pre-binds the port from collecting command bodies.
- The daemon's trust boundary is the operating-system user. Another process running as
  that same user can generally read that user's files or memory and is not considered an
  isolated principal.
- Every daemon session owns a separate BrowserContext, including cookies, storage,
  permissions, service workers and its popup tree.
- Log directories are forced to `0700`; logs, checkpoints and generated captures are
  written `0600`. Typed text is logged only as `«N chars»`, and rule strings are omitted.
- The Chrome companion accepts only explicitly allowlisted extension ids and returns
  through the extension runtime. Page `postMessage`, DOM result nodes and markers have no
  authority.

Screenshots and recordings are pixels and are not redacted. Do not request them for a
sensitive region.

The companion protocol itself has no pixel-returning response. Its `privacy.applied`
attestation covers only the semantic result produced by the isolated content reader;
screenshots taken by a consumer remain outside that attestation.

## Library capture redaction

The library APIs `agent.inspect`, `agentOracle` and `sensor` accept the opt-in
`captureRedaction` option, with the same settings as SnapDOM's `redactInputs` plugin.
Unlike literal `privacy.redact`, this explicitly selects fields, blocks and named
attributes for both clone and semantic removal. Fields selected by these rules retain
presence only in their value signal; filled-to-filled edits are declared unobservable.

Use `selector` for inputs/textareas, `blocks` for whole subtrees, and
`attributes: [{ selector, names }]` for exact attribute names. Rules are applied before
semantic hashes and baselines are created and to every attached GIF/video frame.
`inspect().rasterize()` retains them for regional captures. The source page stays
unchanged. Blocks retain invisible layout space unless `excludeMode: 'remove'` is used.

This is configured selection, not automatic discovery: attribute removal does not erase
copies in ordinary text, CSS `content` or bitmap pixels. Masks may change wrapping.
The CLI/MCP and native screenshots do not inherit this library-only option; their
existing pixel warnings above remain accurate. Separately installed redactor plugins
do not share a policy automatically with these semantic readers.

Capture redaction permits one composed configuration per capture. A protected capture
rejects additional `agentOracle`/`sensor` readers, including unconfigured ones; use
separate captures for separate readers. In `agentOracle` or
`agent.inspect`, checkpoints created with `captureRedaction` are bound to that local
policy. Enabling, removing or changing the selection rules, or reloading the page,
requires omitting `previous` to establish a fresh baseline. This prevents an older
checkpoint from reintroducing previously visible names or text into a protected diff.


## Verification

- `test/privacy-probe.test.js`: core redaction, encoded forms and audit behavior
- `test/sensitive-input-privacy.test.js`: non-verifiable sensitive value checkpoints
- `test/audit-daemon-mcp.test.mjs`: isolated world, authenticated transport, private
  files, session storage isolation, popup cleanup and URL redaction
- `companion/gate.mjs`: hostile page/iframe attacks against the extension boundary
