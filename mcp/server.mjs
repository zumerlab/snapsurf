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
 * NOT FOR PUBLICATION — private packages/agent workspace.
 */
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8377
const log = (...a) => console.error('[snapdom-agent-mcp]', ...a)

// ── Daemon: locate and auto-spawn ────────────────────────────────────────────────────
async function browsePath() {
  const candidates = [
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
async function cmd(name, args = []) {
  const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: name, args, envelope: true }),
  })
  const env = await res.json()
  if (!env.ok && env.error) throw new Error(env.error)
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

async function ensureDaemon() {
  try { await cmd('status'); return } catch { /* spawn it */ }
  const p = await browsePath()
  log('spawning daemon (own child):', p)
  spawnedDaemon = spawn(process.execPath, [p, 'serve'], { stdio: 'ignore' })
  spawnedDaemon.on('exit', () => { spawnedDaemon = null })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { await cmd('status'); return } catch { /* not yet */ }
  }
  throw new Error('daemon did not respond within 20s')
}

// ── Tools ────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'browser_open',
    description: 'Navigate to a URL and get the semantic DIGEST (~2-3KB): landmark regions with ids, headings with their section, and the top-15 RANKED actionables with hrefs. Ids (n_xxx) expire on every new observation.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL (https implied; file:/data: accepted)' } }, required: ['url'] },
    run: async ({ url }) => cmd('open', [url]),
  },
  {
    name: 'browser_find',
    description: 'Search text across the WHOLE page (not just the visible part) and get RANKED matches: clickable id, role, full text, bbox and a navigable href. The right tool to locate something specific on long pages — do not ask for the full outline.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => cmd('find', text.split(/\s+/)),
  },
  {
    name: 'browser_act',
    description: 'Act on the page: click (by id from the digest/find, or "x,y"), type (into the focused element — click it first), or enter. Click auto-scrolls and CONFIRMS role/name of the resolved element: read that echo before continuing. After acting, call browser_verify.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'enter'] },
        target: { type: 'string', description: 'id n_xxx or "x,y" (click only)' },
        text: { type: 'string', description: 'text to type (type only)' },
      },
      required: ['action'],
      oneOf: [
        { properties: { action: { const: 'click' } }, required: ['action', 'target'] },
        { properties: { action: { const: 'type' } }, required: ['action', 'text'] },
        { properties: { action: { const: 'enter' } }, required: ['action'] },
      ],
    },
    run: async ({ action, target, text }) => {
      if (action === 'click') {
        if (!target) throw new Error('click requires target (id or "x,y")')
        return cmd('click', [target])
      }
      if (action === 'type') {
        if (!text) throw new Error('type requires text')
        return cmd('type', text.split(/\s+/))
      }
      return cmd('enter')
    },
  },
  {
    name: 'browser_verify',
    description: 'WHAT CHANGED since the last observation — the verification of your action. Returns changed (a faithful negative: if your click did nothing it says so instead of letting you believe you acted), the list of changes with kind (added/removed/state/style/moved) role and name, and what became covered or visible. Call it after EVERY action instead of comparing screenshots.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => cmd('look'),
  },
  {
    name: 'browser_checkpoint',
    description: 'Save the currently observed state as a NAMED baseline (before a risky action). NOT undo: a comparison point for browser_diff.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async ({ name }) => cmd('cp', ['save', name]),
  },
  {
    name: 'browser_diff',
    description: 'Diff the current state against a checkpoint saved with browser_checkpoint: everything that changed since that known point. Note: the next browser_verify baseline becomes the current state.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: async ({ name }) => cmd('cp', ['diff', name]),
  },
  {
    name: 'browser_assert',
    description: 'Deterministic QA assertion built ON the diff — the replacement for fragile visual assertions. Checks any combination of: url (substring of the current URL), changed (expect the diff since the last observation to be true/false — the faithful negative makes "my action did nothing" ASSERTABLE), mustInclude ([{kind, role, name}] entries that must appear in the diff; kind ∈ added/removed/content/state/style/moved/resized), exists (text findable anywhere on the page), notCovered (text whose best match must not be occluded). FAIL-LOUD CONTRACT: unknown spec keys, empty specs and missing baselines are hard pass:false with a reason — confusion never looks green. Returns structured {pass, hasBaseline, attempts, checks[], changes[]}; the diff evidence (with state from/to) travels with every result. Also: mustNotInclude (assert side-effect ABSENCE), maxChanges, becameVisible/becameCovered (actionability deltas), mustInclude entries accept selector and to:{state:value} (directional state — assert the menu IS open), settleMs and retry:{budgetMs} re-walk against the SAME baseline until pass or budget (CSS transitions land mid-flight). exists searches accessible names AND page text. It consumes the diff baseline at the END unless keepBaseline:true.',
    inputSchema: {
      type: 'object',
      properties: {
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
    run: async (args) => cmd('assert', [JSON.stringify(args)]),
  },
  {
    name: 'browser_text',
    description: 'Full visible text of ONE node (by id) — to extract numbers, titles or exact values without interpreting pixels.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => cmd('text', [id]),
  },
  {
    name: 'browser_page',
    description: 'Expanded views when the digest is not enough: outline (full structure trimmed to 12KB), map with offset (pages actionables beyond the top), or zoom with id (observes ONLY that subtree — the detail of a region/card; renews ids, global baseline untouched). Explicit escalation — digest first.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['outline', 'map', 'zoom'] },
        offset: { type: 'number', description: 'map only: start index' },
        id: { type: 'string', description: 'zoom only: region/element id' },
      },
      required: ['view'],
      oneOf: [
        { properties: { view: { const: 'outline' } }, required: ['view'] },
        { properties: { view: { const: 'map' } }, required: ['view'] },
        { properties: { view: { const: 'zoom' } }, required: ['view', 'id'] },
      ],
    },
    run: async ({ view, offset, id }) => {
      if (view === 'outline') return cmd('outline')
      if (view === 'zoom') {
        if (!id) throw new Error('zoom requires id')
        return cmd('look', [id])
      }
      return cmd('map', [String(offset || 0)])
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Pixels as ESCALATION, not default: snapdom render of the viewport, or of one element (scrolled to center) when you pass an id. Only when the doubt is genuinely visual (layout, color, overlap) — for what changed there is browser_verify.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'optional: element to center' } } },
    run: async ({ id }) => {
      const file = `/tmp/snapdom-mcp-${Date.now()}.png`
      const env = await cmd('snap', id ? [id, file] : [file])
      const data = (await readFile(file)).toString('base64')
      return { ...env, image: { data, mimeType: 'image/png' } }
    },
  },
]

// ── MCP stdio (JSON-RPC 2.0, un mensaje por línea) ───────────────────────────────────
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
      await ensureDaemon()
      const env = await tool.run(params?.arguments || {})
      const content = [{ type: 'text', text: mcpDialect(env.text) }]
      if (env.image) content.push({ type: 'image', data: env.image.data, mimeType: env.image.mimeType })
      // structuredContent: the fields an integrator must never parse out of prose
      // (changed, matches, resolved, epoch, url…) — codex-mcp's central ask
      return reply(id, {
        content,
        structuredContent: { v: 1, ok: env.ok, epoch: env.epoch, url: env.url, ...env.meta },
        isError: !env.ok,
      })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true })
    }
  }
  if (id !== undefined) replyErr(id, -32601, `unsupported method: ${method}`)
})

log('ready (stdio)')
