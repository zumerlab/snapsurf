#!/usr/bin/env node
/**
 * snapdom-agent MCP server — PLAN phase F1: the oracle as native tools for any MCP
 * client (Claude Code, Claude Desktop, other agents).
 *
 * Architecture: a thin translator over the browse.mjs daemon (HTTP :8377) — inherits
 * EVERYTHING the lab hardened: per-session JSONL logs, --readonly/--allow policies,
 * unique-or-absent selectors, faithful negatives, adaptive settle. If the daemon is
 * not running it spawns it (repo tree or the ~/.claude/snapdom-agent global install).
 *
 * MCP stdio protocol implemented by hand (JSON-RPC 2.0, one message per line):
 * zero dependencies. stdout is protocol ONLY; all logging goes to stderr.
 *
 * Register (once):  claude mcp add --scope user snapdom-agent -- node <path>/server.mjs
 *
 * Private development package; see the repository LICENSE.
 */
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { readFile, access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.SNAPDOM_AGENT_PORT || 8377)
// Canonical discovery path in the HOME directory — tmpdir() is per-process environment
// and left daemons published on islands other consumers never named (the measured
// 401→EADDRINUSE→20s deadlock, 2026-08-13). Legacy tmpdir path kept as READ fallback.
const TOKEN_FILE = process.env.SNAPDOM_AGENT_TOKEN_FILE || join(homedir(), '.claude', 'snapdom-agent', `daemon-${PORT}.token`)
const LEGACY_TOKEN_FILE = join(tmpdir(), `snapdom-agent-${process.getuid?.() ?? 'user'}-${PORT}.token`)
const log = (...a) => console.error('[snapdom-agent-mcp]', ...a)
let daemonAuthToken = process.env.SNAPDOM_AGENT_TOKEN || null

async function authToken() {
  if (daemonAuthToken) return daemonAuthToken
  try {
    const token = (await readFile(TOKEN_FILE, 'utf8')).trim()
    if (token) return token
  } catch { /* fall through to legacy */ }
  const token = (await readFile(LEGACY_TOKEN_FILE, 'utf8')).trim()
  if (!token) throw new Error(`daemon token is empty: ${TOKEN_FILE}`)
  return token
}

// ── Multi-server coexistence (finding 2026-08-13) ────────────────────────────────────
// Several MCP servers (CLI sessions, desktop app) share the single daemon port. A token
// mismatch means a LIVE daemon owned by another server — treating it as "down" spawned
// a child guaranteed to die in EADDRINUSE and burned 40×500ms into a mute timeout, per
// call. Instead re-read the token from the FIXED canonical 0600 same-uid file (the move
// to homedir now guarantees every same-uid process resolves it identically) and ADOPT
// the running daemon.
//
// SECURITY: the trust root is "only a same-uid reader of the 0600 token file is
// trusted". Adoption candidates are therefore ONLY the client-resolved TOKEN_FILE /
// LEGACY_TOKEN_FILE — NEVER a path named by the /owner response. /owner is an
// UNAUTHENTICATED card served by whatever holds the port; trusting a path it supplies
// would let a different-uid squatter point us at a world-readable file whose token it
// chose. /owner is used ONLY to name the owner in diagnostics and to tell "another
// snapdom daemon" apart from an alien/absent listener.
const AUTH_MISMATCH = /identity verification failed|response authentication failed/
// Classify the port holder in one request: an `owner` card (a genuine snapdom daemon,
// validated by its identity fields, not merely a numeric pid), `stale` (answers HTTP
// but not /owner — likely a pre-upgrade daemon), `alien` (answers but is not snapdom),
// or `down` (nothing accepted the connection).
async function ownerProbe() {
  let r
  try {
    r = await fetch(`http://127.0.0.1:${PORT}/owner`, { signal: AbortSignal.timeout(1500) })
  } catch { return { reach: 'down' } }
  if (r.status === 404) { await r.text().catch(() => {}); return { reach: 'stale' } }
  let o = null
  try { o = await r.json() } catch { return { reach: 'alien' } }
  if (o && o.daemon === 'snapdom-agent' && o.v === 1 && typeof o.pid === 'number') return { reach: 'owner', card: o }
  return { reach: 'alien' }
}
function foreignDaemonError(probe) {
  const c = probe && probe.card
  if (c) return new Error(`port ${PORT} is owned by another snapdom daemon (pid ${c.pid}, since ${c.startedAt}, log session ${c.logSession}) and its published token does not authenticate from here — stop it with \`node tools/browse.mjs stop\`, or set SNAPDOM_AGENT_PORT for this server`)
  if (probe && probe.reach === 'stale') return new Error(`port ${PORT} answers HTTP but not /owner — likely an older snapdom daemon; stop it with \`node tools/browse.mjs stop\`, or set SNAPDOM_AGENT_PORT for this server`)
  if (probe && probe.reach === 'down') return new Error(`daemon on port ${PORT} is not responding`)
  return new Error(`port ${PORT} is bound by a process that does not speak the snapdom daemon protocol — free the port or set SNAPDOM_AGENT_PORT for this server`)
}
// Concurrent MCP tool calls (rl.on('line') handlers are unserialized) all hit
// AUTH_MISMATCH at a handover. Serialize adoption behind ONE shared in-flight promise so
// only one trial runs; the rest await it and retry against the freshly-published global.
// The trial probes each candidate with an EXPLICIT token and writes daemonAuthToken only
// AFTER that token verifies — never leaving an unverified value in the global for another
// call to sign with.
let adoptionPromise = null
async function adoptRunningDaemon() {
  if (adoptionPromise) return adoptionPromise
  const attempt = adoptRunningDaemonOnce()
  adoptionPromise = attempt
  try { return await attempt }
  finally { if (adoptionPromise === attempt) adoptionPromise = null }
}
async function adoptRunningDaemonOnce() {
  const probe = await ownerProbe()
  const before = daemonAuthToken
  for (const file of [...new Set([TOKEN_FILE, LEGACY_TOKEN_FILE])]) {
    let token
    try { token = (await readFile(file, 'utf8')).trim() } catch { continue }
    if (!token || token === before) continue
    try {
      await cmdOnce('status', [], { internal: true, token })   // verify WITHOUT mutating the global
      daemonAuthToken = token                                   // publish only after it verifies
      log(`adopted running daemon${probe.card ? ` pid ${probe.card.pid} (since ${probe.card.startedAt})` : ''} via ${file}`)
      return true
    } catch { /* next candidate */ }
  }
  throw foreignDaemonError(probe)
}

const hmac = (token, message) => createHmac('sha256', token).update(message).digest('hex')
const safeEqual = (actual, expected) => {
  const a = Buffer.from(String(actual || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── Daemon: locate and auto-spawn ────────────────────────────────────────────────────
async function browsePath() {
  const candidates = [
    join(HERE, 'browse.mjs'),                                      // global self-contained copy
    join(HERE, '..', 'tools', 'browse.mjs'),                       // repo (agent-lab)
    join(process.env.HOME || '', '.claude', 'snapdom-agent', 'browse.mjs'), // global
  ]
  for (const p of candidates) {
    try { await access(p); return p } catch { /* next */ }
  }
  throw new Error('browse.mjs not found (agent-lab branch checked out, or install-global run?)')
}

// Daemon envelope v1: {ok, text, error, epoch, url, meta} — a machine contract
// instead of parsed prose (codex-mcp ask).
async function cmd(name, args = [], { internal = false, sessionId } = {}) {
  try {
    return await cmdOnce(name, args, { internal, sessionId })
  } catch (e) {
    // An auth mismatch mid-session means the port changed owners (our child died and
    // another server's daemon took over). Adopt once and retry; adoption throwing the
    // named-owner error is the honest terminal state, never a mute retry loop.
    if (!AUTH_MISMATCH.test(String(e && e.message || e))) throw e
    await adoptRunningDaemon()
    return cmdOnce(name, args, { internal, sessionId })
  }
}

async function cmdOnce(name, args = [], { internal = false, sessionId, token } = {}) {
  // token may be passed explicitly by the adoption trial to verify a candidate WITHOUT
  // mutating the shared daemonAuthToken; every other caller resolves it from the global.
  if (!token) token = await authToken()
  // Prove the listener knows the private token before sending a URL, typed text or
  // privacy rule. Merely signing the later request would still hand its clear body to a
  // process that pre-bound the port, even though that process could not forge a reply.
  const challenge = randomBytes(16).toString('hex')
  const authResponse = await fetch(`http://127.0.0.1:${PORT}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: challenge }),
  })
  await authResponse.text()
  if (!authResponse.ok || !safeEqual(authResponse.headers.get('x-snapdom-auth'), hmac(token, `auth-v1\n${challenge}`))) {
    throw new Error('daemon identity verification failed')
  }
  const body = JSON.stringify({ cmd: name, args, envelope: true, internal, sessionId })
  const nonce = randomBytes(16).toString('hex')
  const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-snapdom-nonce': nonce,
      'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`),
    },
    body,
  })
  const wire = await res.text()
  if (!safeEqual(res.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${wire}`))) {
    throw new Error('daemon response authentication failed')
  }
  let env
  try { env = JSON.parse(wire) } catch { throw new Error(`invalid daemon response (${res.status}): ${wire.slice(0, 160)}`) }
  if (!env || env.v !== 1 || typeof env.ok !== 'boolean') {
    throw new Error('invalid daemon envelope')
  }
  if (!res.ok || !env.ok) throw new Error(env.error || `daemon request failed (${res.status})`)
  if (typeof env.sessionId !== 'string' || typeof env.epoch !== 'number' || typeof env.meta !== 'object' || env.meta === null) {
    throw new Error('invalid daemon success envelope')
  }
  return env
}

// The daemon speaks CLI dialect ("run look", "map <offset>") — a blind MCP client
// may invent nonexistent tools from those hints (codex-mcp caught this). Translate
// to MCP tool names at the edge.
function mcpDialect(text) {
  return (text || '')
    .replaceAll('run look to see what changed', 'call browser_verify to see what changed')
    .replaceAll('run look (or enter to submit)', 'call browser_verify (or browser_act enter to submit)')
    .replaceAll('run look first', 'call browser_verify first')
    .replaceAll('run open/look first', 'call browser_open / browser_verify first')
    .replaceAll('— run look', '— call browser_verify')
    .replaceAll('(zoom with look <id>)', '(zoom with browser_page {view:"zoom", id})')
    .replaceAll('(detail: outline · map <offset> · find <text> · look <id>)', '(detail: browser_page {view:"outline"|"map"} · browser_find · browser_page {view:"zoom", id})')
    .replaceAll('the rest via find/map', 'the rest via browser_find or browser_page {view:"map"}')
    .replaceAll('the rest via find', 'the rest via browser_find')
    .replaceAll('re-run find', 're-run browser_find')
    .replaceAll('use find', 'use browser_find')
    .replaceAll('the map/find', 'the digest/browser_find')
    .replaceAll('see cp list', 'see browser_checkpoint list')
    .replaceAll('next look baseline', 'next browser_verify baseline')
}

// Daemon ownership (codex-mcp CI blocker: an orphaned serve with PPID 1): if WE
// spawned it, it is our non-detached child and we kill it on EOF/SIGINT/SIGTERM.
// If it was already running (the user's), we leave it alone.
let spawnedDaemon = null
let daemonStartPromise = null
let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (!spawnedDaemon) process.exit(code)
  const pid = spawnedDaemon.pid
  // Two measured landmines behind this shape (both produced codex-mcp's PPID-1
  // orphan): (1) ChildProcess.kill() returns true WITHOUT delivering here — use
  // process.kill(pid); (2) a signal followed by immediate process.exit is NOT
  // delivered either — the sender must outlive the send. So: TERM, wait, KILL
  // if still alive, then exit.
  try { process.kill(pid, 'SIGTERM') } catch { process.exit(code) }
  log('shutdown: SIGTERM to daemon', pid)
  setTimeout(() => {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); log('shutdown: SIGKILL to daemon', pid) } catch { /* already dead */ }
    process.exit(code)
  }, 400)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.stdin.on('end', () => shutdown(0))
process.stdin.on('close', () => shutdown(0))
// Belt and braces for clients that die without closing our stdin: 15 idle servers from
// one afternoon of dead sessions were observed squatting (finding 2026-08-13). Being
// reparented to init IS the signal the client is gone — no client, no reason to live.
setInterval(() => { if (process.ppid === 1) { log('parent gone (ppid 1) — exiting'); shutdown(0) } }, 30_000).unref()

async function ensureDaemonOnce() {
  // internal: the liveness probe before every tool call must not pollute the JSONL
  // (codex v5: 13 zero-ms status entries made per-verb suite reconstruction noisy)
  // The probe (with cmd's built-in adoption) distinguishes the three states that were
  // previously one mute "spawn it": daemon ours/adoptable → serve; daemon foreign and
  // unadoptable → named-owner error (spawning would only die in EADDRINUSE); port
  // closed → spawn.
  try { await cmd('status', [], { internal: true }); return } catch (e) {
    if (String(e && e.message || e).startsWith('port ' + PORT)) throw e   // named-owner diagnosis
    /* connection refused → spawn it */
  }
  const p = await browsePath()
  log('spawning daemon (own child):', p)
  const ownedToken = randomBytes(32).toString('hex')
  daemonAuthToken = ownedToken
  const child = spawn(process.execPath, [p, 'serve'], {
    stdio: 'ignore',
    env: { ...process.env, SNAPDOM_AGENT_TOKEN: ownedToken },
  })
  spawnedDaemon = child
  // Never let an older/failed child erase ownership of a newer one. This identity
  // guard also makes future restart logic safe.
  child.on('exit', () => {
    if (spawnedDaemon === child) {
      spawnedDaemon = null
      if (daemonAuthToken === ownedToken) daemonAuthToken = process.env.SNAPDOM_AGENT_TOKEN || null
    }
  })
  let lastForeign = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { await cmdOnce('status', [], { internal: true }); return } catch (err) {
      // Our child cannot 401 us (it holds ownedToken): a mismatch here means another
      // server won the port race. Try to adopt the winner — but a mismatch can also be
      // the winner's OWN bind-to-publish gap (it answers /auth with its token before its
      // token file lands), so adoption failing here is TRANSIENT: remember the named
      // error and keep polling; the winner publishes within a few ms. Only if the whole
      // budget expires do we surface it — never burn the loop, never abort early on a gap.
      if (AUTH_MISMATCH.test(String(err && err.message || err))) {
        try { await adoptRunningDaemon(); return } catch (adoptErr) { lastForeign = adoptErr }
        continue
      }
      // Child died before serving (port still closed): report its exit instead of a
      // generic timeout — this is how a broken launch (missing browser build, bad
      // install) surfaces as a diagnosis rather than 20 more seconds of silence.
      if (child.exitCode !== null && (await ownerProbe()).reach === 'down') {
        throw new Error(`daemon child exited with code ${child.exitCode} before serving — run \`node ${p} serve\` manually to see why`)
      }
    }
  }
  // Budget exhausted. If a foreign owner was seen along the way, its named error is the
  // honest diagnosis; otherwise the child simply never came up.
  throw lastForeign || new Error(`daemon did not respond within 20s (child pid ${child.pid}, exit code ${child.exitCode}) — run \`node ${p} serve\` manually to see why`)
}

async function ensureDaemon() {
  // MCP clients may issue several tool calls as soon as the server advertises itself.
  // Without a singleton startup, each call observed a closed port and spawned its own
  // daemon; the EADDRINUSE loser then cleared the winner reference, orphaning it when
  // stdio closed. One in-flight liveness/startup attempt is shared by every caller.
  if (daemonStartPromise) return daemonStartPromise
  const attempt = ensureDaemonOnce()
  daemonStartPromise = attempt
  try {
    return await attempt
  } finally {
    if (daemonStartPromise === attempt) daemonStartPromise = null
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'browser_open',
    description: 'Navigate to a URL and get the semantic DIGEST (~2-3KB): landmark regions with ids, headings with their section, and the top-15 RANKED actionables with hrefs. Ids (n_xxx) expire on every new observation. A `top` entry with `placeholder: true` is an EMPTY form field whose name is its placeholder — a prompt, never data from the site. Every observation reports `authState` and `cookiesForOrigin`: this tool drives ITS OWN isolated per-session BrowserContext, cookie jar and storage. `authState` is conservatively `unknown`; a cookie count is evidence, not proof of identity, because authentication can also live in storage, bearer state or the URL. For a task that needs the real signed-in session from another browser, this is the wrong instrument. If the site answered with a bot-mitigation interstitial, structuredContent carries `blocked: true` and `challenge` {vendor, reason, status, signal, and `vendors` when more than one is detected — vendors chain, and a confidently wrong name is worse than unknown for per-vendor retry routing}: the content was WITHHELD, which is a different answer from a page that has little on it — fall back to another fetcher rather than recording an empty result. A request that never reached an HTTP response returns `failure` {layer: dns|tls|transport|http, code, hostUp} instead of a thrown string — a DNS or certificate failure is neither a block nor an empty page. The open waits (bounded) for window.onload AND briefly watches the fresh document for timer-delayed first paints (entry ads armed via setTimeout at parse time), so late overlays/modals enter the FIRST digest; if the document is STILL not complete, structuredContent carries `loading` {readyState, waitedMs} and the prose says so — treat the digest as a truthful walk of an UNFINISHED page and re-observe before trusting completeness. Returns `digest` in structuredContent (marks/heads/top) as well as prose — read the field, do not parse the text. After a SAME-ORIGIN navigation, structuredContent may also carry `carried`: which strong-identity elements (data-testid / authored accessible names) persisted from the previous page and how their state/content moved (the cart badge "1"→"2"), plus only-before/only-after COUNTS of page-specific content — those counts are "different page", never removals/additions. Optional `redact`: session privacy rules — any name/label/text/state string containing a listed term leaves every observation as [redacted], and each observation carries an attestation that the policy ran (`policyRevision`, `rulesActive`) — never hit counts, which would tell you whether and how often the hidden term occurs. Raw form values are never returned; sensitive categories use coarse change signals and declare same-bucket uncertainty.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, waitForChallenge: { type: 'number', description: 'ms to wait for a bot-mitigation interstitial to clear by itself (capped at 30000). Many do within a few seconds. Omitted = do not wait, just report.' }, digest: { type: 'string', enum: ['full', 'compact'], description: 'compact = the extraction profile: no bbox, no section, and the prose collapses to one line because the digest is already in structuredContent. Halves the per-page cost for a sweep that reads fields and never clicks.' }, url: { type: 'string', description: 'URL (https implied; file:/data: accepted)' }, redact: { type: 'array', items: { type: 'string' }, description: 'Session privacy rules: strings to redact from every observation from now on (replaces any previous rules)' } }, required: ['url'] },
    run: async ({ url, redact, digest, waitForChallenge, sessionId }) =>
      // Rules as JSON, in the SAME call as the navigation. It used to be two calls with
      // the rules joined by commas, which meant (1) two concurrent MCP requests could read
      // under each other's policy, and (2) a rule containing a comma was split in two.
      // Both are F3 round findings.
      cmd('open', [...(Array.isArray(redact) ? [url, '--redact-json', JSON.stringify(redact)] : [url]), ...(digest === 'compact' ? ['--compact'] : []), ...(waitForChallenge ? ['--wait-challenge', String(waitForChallenge)] : [])], { sessionId }),
  },
  {
    name: 'browser_find',
    description: 'Search text across the WHOLE page (not just the visible part) and get RANKED matches in structuredContent: `id`, `role`, `name`, `text` (same string, honest label), `href` (mailto:/tel: pass through intact) and `truncated` when a value was cut. The right tool to locate something specific on long pages — do not ask for the full outline.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, text: { type: 'string' } }, required: ['text'] },
    run: async ({ text, sessionId }) => cmd('find', text.split(/\s+/), { sessionId }),
  },
  {
    name: 'browser_parent',
    description: 'Climb from a find/digest match to the CARD around it (the nearest container with ≥2 actionables) and observe just that subtree: the way from "found the price text" to "here is the clickable title next to it". Returns the card with fresh ids; the global look baseline stays untouched. When the card carries no prose beyond its actionables and the page splits the logical card across sibling rows (HN-style tables), structuredContent also carries `siblingRowText` — the metadata row BESIDE the card, as declared text, never merged into the card ids. The right follow-up when browser_find located an inner node and you need its actionable context — never infer the card by id arithmetic.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, id: { type: 'string', description: 'id of the inner node (from find/digest/map)' } }, required: ['id'] },
    run: async ({ id, sessionId }) => cmd('parent', [id], { sessionId }),
  },
  {
    name: 'browser_act',
    description: 'Act on the page: click (by id from the digest/find, or "x,y"), type (into the focused element — click it first), or enter. Click auto-scrolls and CONFIRMS role/name of the resolved element: read that echo before continuing. After acting, call browser_verify.',
    // FLAT schema on purpose: a top-level oneOf union broke real clients (Codex CLI
    // projected the branches as complete signatures and lost `target`/`text`, so click
    // calls failed validation before ever reaching this server). Per-action
    // requirements are enforced fail-loud in run() instead.
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'enter'], description: 'click REQUIRES target; type REQUIRES text; enter needs neither' },
        target: { type: 'string', description: 'REQUIRED for click: id n_xxx from the digest/find, or "x,y"' },
        text: { type: 'string', description: 'REQUIRED for type: the text to type into the focused element' },
        sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' },
      },
      required: ['action'],
    },
    run: async ({ action, target, text, sessionId }) => {
      if (action === 'click') {
        if (!target) throw new Error('click requires target (id or "x,y")')
        return cmd('click', [target], { sessionId })
      }
      if (action === 'type') {
        if (!text) throw new Error('type requires text')
        return cmd('type', text.split(/\s+/), { sessionId })
      }
      if (action === 'enter') return cmd('enter', [], { sessionId })
      throw new Error('action must be click, type or enter')
    },
  },
  {
    name: 'browser_verify',
    description: 'WHAT CHANGED since the last observation — the verification of your action. Returns changed (a faithful negative: if your click did nothing it says so instead of letting you believe you acted), the list of changes with kind (added/removed/state/style/moved) role and name, and what became covered or visible. Possible replacements also carry `beforeName`, so the prior and current identities are both explicit. Call it after EVERY action instead of comparing screenshots. structuredContent carries `changed`, `changes` (list of {kind, role, name, beforeName?, id}) and `changesTotal` — read those rather than parsing the prose. Reading aids: `changes` lists signal first and omits folded wrapper nodes of an ADDED subtree (identity-free generic wrappers only — authored names never fold; `foldedWrappers` counts them and `changesTotal` is the full diff count), and `geometryOnly: true` flags a diff that is ONLY moved/resized AND changed no actionability — a scope reflow (scrollbar, container resize) you can skim past. After a same-origin navigation, `carried` reports the strong-identity elements that persisted across pages and their state/content transitions (see browser_open).',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' } } },
    run: async ({ sessionId } = {}) => cmd('look', [], { sessionId }),
  },
  {
    name: 'browser_checkpoint',
    description: 'Save the currently observed state as a NAMED baseline (before a risky action). NOT undo: a comparison point for browser_diff.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, name: { type: 'string' } }, required: ['name'] },
    run: async ({ name, sessionId }) => cmd('cp', ['save', name], { sessionId }),
  },
  {
    name: 'browser_diff',
    description: 'Diff the current state against a checkpoint saved with browser_checkpoint: everything that changed since that known point. Note: the next browser_verify baseline becomes the current state.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, name: { type: 'string' } }, required: ['name'] },
    run: async ({ name, sessionId }) => cmd('cp', ['diff', name], { sessionId }),
  },
  {
    name: 'browser_assert',
    description: 'Deterministic QA assertion built ON the diff — the replacement for fragile visual assertions. Checks any combination of: url (substring of the current URL), changed (expect the diff since the last observation to be true/false — the faithful negative makes "my action did nothing" ASSERTABLE), mustInclude ([{kind, role, name}] entries that must appear in the diff; kind ∈ added/removed/content/state/style/moved/resized — a framework re-render that REPLACES a node reports kind `possible-replacement`, and added/removed matchers accept it with STRICT side reading: an added matcher matches the after-side name/role, a removed matcher matches ONLY the before-side name/role (never the after side; selector specs never match through the alias), and the check result says "found (via possible-replacement — identity ambiguous)" instead of a plain green), exists (text findable anywhere on the page), notCovered (text whose best match must not be occluded). FAIL-LOUD CONTRACT: unknown spec keys, empty specs and missing baselines are hard pass:false with a reason — confusion never looks green. Returns structured {pass, hasBaseline, attempts, checks[], changes[]}; the diff evidence (with state from/to) travels with every result. Also: mustNotInclude (assert side-effect ABSENCE), maxChanges, becameVisible/becameCovered (actionability deltas), mustInclude entries accept selector and to:{state:value} (directional state — assert the menu IS open), settleMs and retry:{budgetMs} re-walk against the SAME baseline until pass or budget (CSS transitions land mid-flight). exists searches accessible names AND page text. It consumes the diff baseline at the END unless keepBaseline:true. SPA soft navs: results with a baseline include navigated:true + baselineUrl when the URL moved since the baseline was taken — that diff spans two pages of one document; re-observe on settled content (non-zero, stable actionables) before trusting change-based checks.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' },
        url: { type: 'string', description: 'substring the current URL must contain' },
        changed: { type: 'boolean', description: 'expected value of the diff since the last observation' },
        mustInclude: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, nameExact: { type: 'string' }, selector: { type: 'string' }, to: { type: 'object' } } },
          description: 'changes that must appear in the diff (selector = exact; to = expected state after, e.g. {expanded:true})',
        },
        mustNotInclude: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, selector: { type: 'string' } } },
          description: 'changes that must NOT appear (assert absence of side-effects)',
        },
        only: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, selector: { type: 'string' } } },
          description: 'causal scoping: EVERY change must match one of these matchers',
        },
        ignore: { type: 'array', items: { type: 'string' }, description: 'CSS selectors whose subtree changes are excluded (e.g. the agent toolbar)' },
        maxChanges: { type: 'number', description: 'diff must contain at most N changes (after ignore)' },
        becameVisible: { type: 'string', description: 'an actionable matching this text must have become visible' },
        becameCovered: { type: 'string', description: 'an actionable matching this text must have become covered' },
        settleMs: { type: 'number', description: 'wait before the first walk' },
        retry: { type: 'object', properties: { budgetMs: { type: 'number' }, intervalMs: { type: 'number' } }, description: 're-walk against the SAME baseline until pass or budget' },
        exists: { type: 'string', description: 'text that must be findable on the page' },
        notCovered: { type: 'string', description: 'text whose best match must not be occluded' },
        keepBaseline: { type: 'boolean', description: 'do not consume the diff baseline (peek mode — safe to retry)' },
      },
    },
    // Routing metadata belongs in the envelope, never inside the assertion spec: the
    // daemon intentionally rejects unknown spec keys, so serialising sessionId there
    // made every session-scoped browser_assert fail its own fail-loud contract.
    run: async ({ sessionId, ...spec } = {}) => cmd('assert', [JSON.stringify(spec)], { sessionId }),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll WITHOUT acting: by element id (to center), to "top"/"bottom", or to an absolute y in pixels. The one legitimate reason: dense listings hydrate their content lazily on scroll and the semantic walk honestly sees only the DOM that exists — scroll, then browser_verify to see what appeared. Ids from the current observation remain valid (scrolling does not re-observe). Includes a bounded settle for the lazy loaders.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'id n_xxx, "top", "bottom", or a y offset in pixels' }, sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' } }, required: ['target'] },
    run: async ({ target, sessionId }) => cmd('scroll', [target], { sessionId }),
  },
  {
    name: 'browser_text',
    description: 'Full visible text of ONE node (by id) — to extract numbers, titles or exact values without interpreting pixels. Returns `text` in structuredContent, with `truncated: true` and `totalChars` when the value was cut (the prose carries the same ⚠ marker) — a cut value must be escalated, not recorded.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, id: { type: 'string' } }, required: ['id'] },
    run: async ({ id, sessionId }) => cmd('text', [id], { sessionId }),
  },
  {
    name: 'browser_page',
    description: 'Expanded views when the digest is not enough: outline (full structure trimmed to 12KB), map with offset (pages actionables beyond the top), or zoom with id (observes ONLY that subtree — the detail of a region/card; renews ids, global baseline untouched). Explicit escalation — digest first. Returns `outline` in structuredContent for view:"outline", with `truncated` when trimmed.',
    // FLAT schema on purpose — same client-portability reason as browser_act: union
    // branches lost the conditional fields in real clients. zoom's id requirement is
    // enforced fail-loud in run().
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['outline', 'map', 'zoom'], description: 'zoom REQUIRES id; map takes an optional offset' },
        offset: { type: 'number', description: 'map only: start index' },
        id: { type: 'string', description: 'REQUIRED for zoom: region/element id' },
        sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' },
      },
      required: ['view'],
    },
    run: async ({ view, offset, id, sessionId }) => {
      if (view === 'outline') return cmd('outline', [], { sessionId })
      if (view === 'zoom') {
        if (!id) throw new Error('zoom requires id')
        return cmd('look', [id], { sessionId })
      }
      return cmd('map', [String(offset || 0)], { sessionId })
    },
  },
  {
    name: 'browser_session_open',
    description: 'Open an independent browsing session and get its `sessionId`. Each session owns a private BrowserContext, cookie/storage jar, popup tree, observation counter and ids, so several sweeps run AT THE SAME TIME without invalidating or authenticating each other. Pass the returned sessionId on every call belonging to that sweep. Close it with browser_session_close when done.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => cmd('session', ['open']),
  },
  {
    name: 'browser_session_close',
    description: 'Close a session opened with browser_session_open and free its complete context, including every popup it created. Sessions also close themselves after 10 minutes idle, so a crashed run does not leak pages.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    run: async ({ sessionId }) => cmd('session', ['close', sessionId]),
  },
  {
    name: 'browser_session_list',
    description: 'List the live sessions with their current URL, observation number and idle time.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => cmd('session', ['list']),
  },
  {
    name: 'browser_screenshot',
    description: 'Pixels as ESCALATION, not default: snapdom render of the viewport, or of one element (scrolled to center) when you pass an id. Only when the doubt is genuinely visual (layout, color, overlap) — for what changed there is browser_verify.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'optional: the session this call belongs to (from browser_session_open). Omitted uses the shared default session.' }, id: { type: 'string', description: 'optional: element to center' } } },
    run: async ({ id, sessionId }) => {
      // One private directory per call avoids same-millisecond collisions between MCP
      // sessions and, unlike the old predictable /tmp file, leaves no screenshots on
      // disk after the response has been encoded.
      const dir = await mkdtemp(join(tmpdir(), 'snapdom-mcp-'))
      const file = join(dir, 'capture.png')
      try {
        const env = await cmd('snap', id ? [id, file] : [file], { sessionId })
        const data = (await readFile(file)).toString('base64')
        return { ...env, image: { data, mimeType: 'image/png' } }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  },
]

// MCP clients are not required to enforce the advertised JSON Schema before sending a
// tools/call. Validate at the authority boundary too: an absent/typoed browser_act action
// previously fell through to Enter and could submit a form while the request was invalid.
function schemaErrors(schema, value, path = '$') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (schema.type) {
    const validType = schema.type === 'object'
      ? !!value && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array'
        ? Array.isArray(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === schema.type
    if (!validType) {
      errors.push(`${path} must be ${schema.type}`)
      return errors
    }
  }
  // The hand-written schemas historically omit `type: object` at their roots. Their
  // properties/required shape still implies an object; do not let null, arrays or strings
  // bypass `required` and reach a mutating tool implementation.
  if ((schema.properties || schema.required) && (!value || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(`${path} must be object`)
    return errors
  }
  if (Array.isArray(schema.required) && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`)
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...schemaErrors(childSchema, value[key], `${path}.${key}`))
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((entry, index) => errors.push(...schemaErrors(schema.items, entry, `${path}[${index}]`)))
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => schemaErrors(branch, value, path).length === 0).length
    if (matches !== 1) errors.push(`${path} must match exactly one allowed shape`)
  }
  return errors
}

// ── MCP stdio (JSON-RPC 2.0, one message per line) ───────────────────────────────────
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyErr = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'snapdom-agent', version: '0.1.0' },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return replyErr(id, -32602, `unknown tool: ${params?.name}`)
    try {
      const toolArguments = params && Object.prototype.hasOwnProperty.call(params, 'arguments')
        ? params.arguments
        : {}
      const invalid = schemaErrors(tool.inputSchema, toolArguments)
      if (invalid.length) {
        return reply(id, {
          content: [{ type: 'text', text: `invalid arguments: ${invalid.join('; ')}` }],
          isError: true,
        })
      }
      await ensureDaemon()
      const env = await tool.run(toolArguments)
      const content = [{ type: 'text', text: mcpDialect(env.text) }]
      if (env.image) content.push({ type: 'image', data: env.image.data, mimeType: env.image.mimeType })
      // structuredContent: the fields an integrator must never parse out of prose
      // (changed, matches, resolved, epoch, url…) — codex-mcp's central ask
      // assert fields ALSO at the root: the tool description promises
      // {pass, hasBaseline, checks…} and a literal client looked one level too
      // deep to find them under .assert (codex v5). Nested copy stays for compat.
      return reply(id, {
        content,
        structuredContent: { v: 1, ok: env.ok, sessionId: env.sessionId, epoch: env.epoch, url: env.url, ...env.meta, ...(env.meta && env.meta.assert ? env.meta.assert : {}) },
        isError: !env.ok,
      })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true })
    }
  }
  if (id !== undefined) replyErr(id, -32601, `unsupported method: ${method}`)
})

log('ready (stdio)')
