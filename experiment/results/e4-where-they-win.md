# E4 — Where agent-browser is ahead of us (an audit for our backlog)

2026-08-01 · agent-browser 0.33.1 · $0, all with the installed CLI · verified by running
it, not by reading the README.

A comparison where the other tool wins nothing is a comparison done badly. E1, E2 and
phase C measured where we are ahead. This measures the opposite, and it goes straight to
the backlog.

## What they have and we do not

| Capability | Them | Us |
|---|---|---|
| **Confirmation by action category** | `--confirm-actions <list>` → the action returns `confirmation_required` with an id; `confirm <id>` / `deny <id>` approve or reject it; **auto-deny after 60 s** | Only `--readonly`, all or nothing |
| **Declarative action policy** | `--action-policy <file.json>` | Does not exist |
| **Interactive confirmation** | `--confirm-interactive`, with **auto-deny when stdin is not a TTY** | Does not exist |
| **State restore with validation** | `--restore [name]` (cookies plus localStorage), `--restore-save auto\|always\|never`, and **three validators of the restored state**: `--restore-check-url`, `--restore-check-text`, `--restore-check-fn` | `cp` is a point of comparison, **not a restore** (a decision, not a bug) |
| **Auth vault** | `auth save/login/list`, `--password-stdin`, credential resolution through a plugin (`--credential-provider`), per-login selector overrides | Does not exist |
| **Multiple tabs** | `tab new\|list\|close\|<n>` | Does not exist |
| **Named sessions** | `session`, `session list` | One session per daemon |
| **Network interception** | `network route <url> --abort\|--body`, `unroute`, `requests --filter` | Only allowlist blocking (`--allow`) |
| **Observability** | DevTools trace, profiler, `console`, `errors`, a **dashboard** on `:4848` | JSONL plus profiling over the protocol |
| **Remote providers** | browserbase, kernel, browseruse, browserless, agentcore, iOS/Safari, plus plugins | Local Chromium only |
| **Emulation** | `viewport`, `device <name>`, `geo`, `offline`, `media dark\|light\|reduced-motion` | Does not exist |

## Verified by running it

**The confirmation gate is real, not a README promise.** With `--confirm-actions click`,
the click returns:

```
Confirmation required:
  click
  Run: agent-browser confirm r415975
  Or:  agent-browser deny r415975
```

and the action **does not run** until it is approved. That is the permission layer our
`--readonly` cannot express: we can only say "no clicks at all", not "this click, with
approval".

**A design detail worth copying**: `--allowed-domains` does not only restrict domains — it
also **refuses CDP, auto-connect, profiles, state replay, direct page providers, unsafe
launch arguments and iOS/Safari**. When they harden, they close the escape routes too. Our
`--allow` restricts the network and disables nothing else, so a user could believe they
are isolated when they are not.

**Indirect confirmation of E1**: their references do not survive between invocations —
`click @e1` after reopening the page gives `Unknown ref: e1`. I found that while fighting
this test, not while looking for it, which reinforces the E1 finding by an independent
route.

## Left unresolved

I wanted to measure whether a **typo in the category** (`--confirm-actions clik`) disables
the gate silently — the kind of silent failure our own contract hunts. The test came out
flaky because their references are volatile between invocations, and **I am leaving it
unanswered** rather than reporting a result I cannot stand behind. It is worth returning
to: if a typo opens the gate without warning, that is exactly the class of bug that cost
us a whole adversarial round to close.

## What goes to our backlog, and in what order

Following the agreed criterion — what serves the validated use case first:

1. **Confirmation by action category.** It is the closest thing to our own framing (a
   verification runtime): somebody running assertions will want to gate destructive
   actions. Our `--readonly` is far too coarse for that.
2. **Multiple tabs.** It shows up in real tasks (links that open a window; we hit this in
   the `claude-native` run) and we have nothing today.
3. **Viewport and device emulation.** Cheap, and necessary for responsive QA, which is the
   landing area we chose.
4. **Restore with validation** — the interesting part is not the restore, it is the
   `--restore-check-*` validators: restoring state and **verifying that the restored state
   is the right one** fits our postcondition thesis exactly.
5. Auth vault, remote providers, dashboard: **defer**. These are autonomy features, not
   the validated use case, and with no real user asking we do not pay for them.

## Honest reading

On product surface **they beat us comfortably**: permissions, sessions, tabs, auth,
emulation, network, observability and providers. Ours is smaller and newer.

The difference is still one of kind, not size. They built a very complete **harness for
operating a browser**; we built a **verification layer** they do not have (phase C: 0
wrong success reports against their 6). And E5 showed the two coexist in the same browser
through an `eval --stdin`. That reinforces the framing: do not compete on harness surface,
which is a losing race. Be the layer that decides whether the action worked, on top of
whatever harness the team already has.

---

## Addendum — the same lens, pointed at us (and a bug of our own, fixed)

The question I left unresolved about them — does a typo in the category silently disable
the gate? — I asked of **our own policy flags**. Result:

| Flag | Spelled correctly | With a typo |
|---|---|---|
| `--readonly` | `policy: readonly` · the destructive click **is denied** | `policy: (unrestricted)` · **the click runs** |
| `--allow` | `policy: allow=[example.com]` | `policy: (unrestricted)` |
| `--redact` | `policy: redact=1 rule(s)` | `policy: (unrestricted)` |

**All three failed silently.** `serve --readonl` started a completely unrestricted daemon,
without a single warning, and deleted the account on the test page. That is exactly the
silent failure the `assert` contract forbids — committed at the daemon's own startup,
where nobody had looked.

**Fixed**: an unknown flag is now a hard error and the daemon **does not start**.

```
⛔ unknown flag: --readonl
   known: --headed --readonly --allow --redact
   refusing to start — a typo in a policy flag would launch an UNRESTRICTED daemon.
```

Same for a flag missing its value (`--redact` with no terms). All four legitimate flags
and their combinations still work; the unit tests and the four-way parity check stayed
green after the change. (The unit-test count quoted in the original version of this note
was wrong: the suite is 50 tests, re-counted on 2026-08-01.)

**A note on method**: the shell lied to me along the way. `serve $1` inside a zsh function
passes `"--redact Secreto"` as **a single argument** — zsh does not word-split unquoted
expansions, unlike bash — which gave me four false "(unrestricted)" readings and nearly
made me report a bug in `--redact` that did not exist. Fixed with `"$@"`. Same pattern
again: **check the instrument before accusing the system.**
