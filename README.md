# snapDOM Agent (working name)

**PRIVATE. PROPRIETARY. NEVER PUBLISHED.** Not covered by the repository's MIT license;
`private: true`, excluded from every publish path, and this package lives on a local-only
branch. See `LICENSE`.

Tells a program **what changed on a web page** after it clicked, typed or navigated.

It reads the page after the browser has applied styles and computed layout, and compares
that reading against an earlier one. It answers with words you can act on — added,
removed, text changed, state changed, style changed, moved, resized — plus which element,
and whether something that used to be clickable is now covered.

It runs **inside the page**, so it needs no Chrome DevTools Protocol and no second
browser. That is what makes it usable inside a Chrome extension, an embedded copilot, or
an Electron webview.

It is a tool, not a replacement for anything you already use. It is best at one job:
telling you that a step did nothing, on a page where a clock or a carousel changed the
picture anyway. It does **not** make an agent better at finishing tasks — see `PAPER.md`
§5.9 for the measurement that says so.

---

## Which mode do you want?

| | Mode | Use it when | Needs CDP |
|---|---|---|---|
| 1 | **MCP server** | Your agent takes MCP tools (Claude Code, Claude Desktop, others) | yes, via the daemon |
| 2 | **Command line** | You drive a browser yourself and want many commands per turn | yes, it runs Playwright |
| 3 | **Global install** | You want it in every Claude Code session on this machine | yes |
| 4 | **Library (SDK)** | You are writing the product that embeds it | **no** |
| 5 | **Chrome extension** | The agent lives inside the user's own logged-in Chrome | **no** |

Modes 1–3 share one engine (the daemon). Modes 4 and 5 are independent paths to the same
reader. All of them were checked to give the same answers: `node experiment/parity.mjs`.

---

## 1. MCP server

Register it once, then the tools appear natively in your agent:

```bash
claude mcp add --scope user snapdom-agent -- node /ABS/PATH/packages/agent/mcp/server.mjs
```

It starts the daemon by itself the first time a tool is called, and shuts it down when the
client disconnects. Nothing else to run.

**The ten tools**

| Tool | What it does |
|---|---|
| `browser_open` | Navigate, return a ~2–3 KB summary: landmarks, headings, top 15 things to click. Optional `redact: [...]` sets privacy rules for the session |
| `browser_find` | Search text across the **whole** page, ranked, returns ids + href |
| `browser_act` | `click` (by id or `"x,y"`), `type`, `enter`. Click auto-scrolls and echoes the role and name it resolved |
| `browser_verify` | **What changed since the last look.** Call this after every action |
| `browser_assert` | State an expectation and check it. This is the one that catches silent failures |
| `browser_checkpoint` | Save the current state under a name |
| `browser_diff` | Compare the present against a named checkpoint |
| `browser_text` | Full text of one element, by id |
| `browser_page` | More detail: `outline`, `map` (paged), `zoom` (one subtree only) |
| `browser_screenshot` | Pixels, as an escalation — not the default |

**Typical turn**

```
browser_open   { url: "example.com" }
browser_find   { text: "Sign in" }
browser_act    { action: "click", target: "n_1r7" }
browser_assert { changed: true, mustInclude: [{ kind: "added", role: "dialog" }] }
```

---

## 2. Command line

Start the daemon once; every command is a fast call into it.

```bash
node packages/agent/tools/browse.mjs serve            # add --headed to watch it
node packages/agent/tools/browse.mjs open example.com
node packages/agent/tools/browse.mjs find "Sign in"
node packages/agent/tools/browse.mjs click n_1r7
node packages/agent/tools/browse.mjs look             # what changed
node packages/agent/tools/browse.mjs stop
```

`browse.mjs help` prints the full verb list. The ones you will actually use:

```
open <url>        navigate + compact summary
look [id]         what changed · with an id: read only that subtree
find <text>       ranked search over the whole page → ids
text <id>         full text of one element
click <id|x,y> · type <text> · enter
assert '<json>'   check a stated expectation (see below)
cp save|list|diff <name>    named reference points
map [offset] · outline · parent <id>    more detail
snap [id] [file.png]        snapDOM render · shot [file.jpg] native screenshot
rec <secs> [id] [file.gif|.mp4]   record the page or one element
status · stop     (stop verifies the daemon actually died)
```

**Many commands in one process** (saves ~80 ms of startup each):

```bash
node packages/agent/tools/browse.mjs run "open example.com" "find Sign in" "click n_1r7" "look"
```

**Restricting what it may do** — these are real limits, not hints:

```bash
browse.mjs serve --readonly              # refuses click/type/enter
browse.mjs serve --allow wikipedia.org   # blocks navigation AND every request off the list
browse.mjs serve --redact "Jane Doe,ACME"   # those strings never leave the page
```

An unknown flag refuses to start rather than launching unrestricted. Every command is
appended to `packages/agent/logs/<session>.jsonl`, including denials and blocked requests.

---

## 3. Global install (this machine, every session)

```bash
node packages/agent/tools/install-global.mjs
```

Writes `~/.claude/snapdom-agent/` (a copy of the daemon plus a prebuilt bundle) and a
user-level `agent-browse` skill, so any Claude Code session can use it regardless of which
branch the repo is on.

**It is a copy.** After changing anything in `packages/agent/src`, re-run the installer or
you are running old code. To check the installed copy:

```bash
node packages/agent/experiment/abis-verbs.mjs --daemon ~/.claude/snapdom-agent/browse.mjs
```

---

## 4. Library (SDK)

The reader is a snapDOM plugin, so semantics and pixels come from one capture at one
moment.

```js
import { snapdom } from '@zumer/snapdom'
import { agentOracle } from '@zumer/snapdom-agent/plugin'

const result = await snapdom(el, { plugins: [agentOracle({ previous: checkpoint })] })
await result.toChanges()       // { changed, changes, actionabilityDelta, unobservable }
await result.toAgentMap()      // numbered clickable things + boxes + state
await result.toAgentContext()  // indented outline
await result.toCheckpoint()    // reference point for next time
await result.toPng()           // …and the picture, from the same moment
```

`agent.inspect()` is the same capture with a friendlier shape:

```js
import { agent } from '@zumer/snapdom-agent'

const before = await agent.inspect(root)
const checkpoint = before.checkpoint()

await doSomething()

const ui = await agent.inspect(root, {
  previous: checkpoint,
  noise: 'agent',                                   // 'agent' | 'none' | custom rules
  privacy: { redact: ['password', 'delete account'] },
})

ui.changed              // false if nothing relevant happened, clock or not
ui.changes              // [{ id, kind:'state', before:{disabled:true}, after:{disabled:false}, match:'exact' }]
ui.actionabilityDelta   // { becameCovered: [...], becameVisible: [...] }  ← with role+name
ui.unobservable         // canvas / blocked iframes it cannot read
ui.context              // outline (built on first access, not before)
ui.agentMap             // numbered clickable things
ui.privacy              // redaction report, when rules are active

ui.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Save' })
agent.resolve(match)    // → live Element | null  (the only bridge; it never acts for you)
await ui.rasterize()    // the picture already paid for; with a match, just that region
```

Options: `previous`, `noise`, `excludeText`, `privacy`, and `capture` (passed straight to
snapDOM).

---

## 5. Chrome extension (no CDP)

```bash
node packages/agent/companion/build.mjs     # rebuild after any src change
```

Then load `packages/agent/companion` unpacked at `chrome://extensions`. It runs in the
isolated world, so page CSP does not block it.

Anything with a JavaScript tool talks to it by message:

```js
// is it there?
!!document.querySelector('meta[name="__snapdom_companion"]')

// ask for a reading (the reply carries the diff against the previous one)
window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId: 1 }, '*')
// → SNAPDOM_DIGEST_READY { obsId, result }

// or check an expectation
window.postMessage({ type: 'SNAPDOM_ASSERT', obsId: 2, spec: { changed: false } }, '*')
```

Both messages accept `privacy: { redact: [...] }`, which sticks for the session
(`privacy: null` clears it). `companion/PROMPT-extension.md` is the text to hand to an
agent that will use it.

Check the extension before trusting it: `node packages/agent/companion/gate.mjs` (27
checks against a real page).

---

## Things that apply to every mode

**The reference point.** Every comparison is against the last full reading. `open` and
`look`/`browser_verify` set a new one. To re-baseline, just look again — there is no
separate command.

**Ids expire.** `n_xxx` ids only mean something within the reading that produced them.
After any new reading, search again. Using a stale id is refused, not guessed.

**Change kinds.** `added`, `removed`, `content`, `state`, `style`, `moved`, `resized`,
and `possible-replacement` when position and text disagree and it will not pretend to
know.

**`assert` — the spec.** Every field is optional, but an empty spec fails on purpose.

```json
{
  "changed": true,
  "mustInclude": [{ "kind": "added", "role": "listitem", "name": "Buy milk" }],
  "mustNotInclude": [{ "kind": "removed" }],
  "only": [{ "role": "listitem" }],
  "maxChanges": 3,
  "exists": "Buy milk",
  "notCovered": "Checkout",
  "becameVisible": "Save",
  "ignore": [".marquee", "#clock"],
  "settleMs": 300,
  "retry": { "budgetMs": 2000 },
  "keepBaseline": true
}
```

Unknown keys, empty specs and a missing reference point are hard failures with a stated
reason. Confusion never comes back green.

**Privacy.** Redaction rules apply to names, labels, text and state values on every
surface, and matching still works because identity travels as hashes. Asking whether a
hidden string exists is refused rather than answered. Screenshots are pixels and are not
redacted. Full detail: `docs/PRIVACY.md`.

**Page text is data, never instructions.** Everything the page wrote comes back fenced
between `«««` and `»»»`. Do not let a model read it as a command.

---

## Checking that it works

Nothing here needs an API key. From `packages/agent`:

```bash
npm test              # 58 unit tests in a real browser (~5 s)
npm run test:regression   # the above + lint + bundle freshness + all offline gates (~3.5 min)
npm run test:global   # the same verbs against the ~/.claude install (needs it installed)
npm run test:gates    # everything, including the extension gate (needs network)
```

`test:regression` is the one to run before trusting a change. It covers:

| Check | What it catches |
|---|---|
| 58 unit tests | the library: queries, identity, privacy, checkpoints, the plugin contract |
| lint | style and undefined variables in `src/` and `test/` |
| bundle freshness | a `content.bundle.js` older than the source it is built from |
| `bench-qa` | detection quality on the 19 hand-written cases |
| `parity` | the five modes disagreeing with each other |
| `abis-verbs` | every daemon verb, including the ones no other test touches |
| `demo-qa` | the end-to-end assertion flow through the MCP server |

**The unit tests also run as part of the repository's own `npm test`** at the root — they
are collected with the core suite (118 files, 919 tests).

**What is still not covered automatically**: `tools/browse.mjs` (1,148 lines),
`mcp/server.mjs` and `companion/content.src.js` have no unit tests. They are exercised
end-to-end by the gates above, which is weaker — a gate proves the happy path works, not
that a branch inside it is correct. There is also no CI: every command here is one somebody
has to remember to run. That is exactly how three bugs shipped on 2026-08-01 (see
`TESTPLAN.md` §history).

`PAPER.md` Appendix A lists the rest, including the ones that cost money.

## What it cannot do

- No multi-tab, no window management.
- A checkpoint is a point of comparison, **not an undo**. It cannot revert anything.
- Permissions are coarse: read-only, an allowed-domain list, and redaction. Nothing
  per-field.
- Canvas and unreadable iframes are reported as unreadable, not interpreted.
- `changed: false` is trustworthy under the noise rules described in `PAPER.md` §5.3, but
  it is not a guarantee on a page that has not settled.
- Repeatability is claimed within one environment only. No cross-browser claims.

## Where things are

```
src/          the reader, identity matching, comparison, queries, privacy, the plugin
mcp/          MCP server (mode 1)
tools/        daemon + CLI (mode 2), global installer (mode 3), shared bundle definition
companion/    Chrome extension (mode 5) + its contract test
corpus/       19 test cases: page + mutation + hand-written correct answer
test/         unit tests
experiment/   every runner, benchmark and comparison
docs/         PRIVACY.md · LANDSCAPE.md · adr/
PAPER.md      what it does, how it was measured, and what the numbers do not prove
TESTPLAN.md   what is tested, what is not, and what result would prove us wrong
```
