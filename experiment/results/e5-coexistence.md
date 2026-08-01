# E5 — Coexistence: our reader running INSIDE agent-browser

2026-08-01 · `experiment/e5-coexistence.mjs` · agent-browser 0.33.1

The strategic question from `docs/LANDSCAPE.md`: if we work inside their flow without
replacing it, they stop being a competitor and become **a distribution channel** — which
addresses the single biggest weakness the survey found.

## It works

| | |
|---|---|
| Reader bundle | **45 KB** (observe + buildUi) |
| Injection route | their own `agent-browser eval --stdin` |
| `typeof window.__sdObserve` after injection | `"function"` |
| Their flow | **untouched**: `open` and `click` stay theirs |
| Our report for the same moment | `state button "Enviar"` + `style` + `moved` |

The full flow is: `open` (theirs) → inject 45 KB through their `eval` → save a reference
point (ours) → `click` (theirs) → change report (ours). **Five commands, no modification
to their tool.**

## The two reports, same browser, same action

Theirs, a text diff of the accessibility tree:

```
-- heading "Formulario" [level=2, ref=e1]      +- heading "Formulario" [level=2, ref=e4]
-- StaticText "--:--:--"                       +- StaticText "10:47:20"
-- button "Validar" [ref=e2]                   +- button "Validar" [ref=e5]
-- button "Enviar" [disabled, ref=e3]          +- button "Enviar" [ref=e6]
```

Ours:

```json
{ "changed": true, "changes": [
  { "kind": "state", "role": "button", "name": "Enviar" },
  { "kind": "style", "role": "button", "name": "Enviar" },
  { "kind": "moved", "role": "button", "name": "Validar" } ] }
```

**Being honest about the comparison**: their diff **does show** the `disabled` flip — it
disappears from the serialization. They do not miss it. The difference is the shape:

- They hand over **four changed lines**, three of which changed only because a reference
  was renumbered and one because the clock advanced. The caller has to work out which one
  matters.
- We hand over **the typed fact**: `state` on the button named "Enviar". That is directly
  assertable (`mustInclude: [{kind:'state', name:'Enviar'}]`) without anyone writing a
  parser.

**The clock dirties both reports** in this configuration. The difference is that ours can
be bounded with `ignore: ['#clock']`, which is exactly what phase C used to reach zero
wrong success reports.

## Strategic reading

1. **It stops being an either-or choice.** A team already using agent-browser can add the
   verification layer without migrating anything: their CLI to operate, our reader to
   decide whether the action worked.
2. **It is the cheapest distribution route we have.** It does not require adopting our
   daemon, our MCP server or our extension. It requires an `eval --stdin`.
3. **And it reinforces the framing**: what we add is not "another way to see the page" —
   they already have that — but **the layer that decides whether the intended effect
   happened**.

## A landmine found while automating this

The manual test worked first time and the script failed silently: Node's `execFile` **does
not accept the `input` option** (that belongs to `execFileSync`), so the injection never
happened and `typeof` returned `"undefined"`. You have to write to the child's stdin by
hand with `spawn`. A silent failure identical to the ones this project hunts in pages.

## Reproducing

```bash
npm install -g agent-browser
node packages/agent/experiment/e5-coexistence.mjs
```
