/**
 * agent-browse — the oracle as MY browsing harness (Claude Code dogfooding).
 *
 * A long-lived daemon holds one Playwright page with the agent SDK injected on every
 * navigation; a thin CLI talks to it over localhost HTTP. The whole point is the
 * observation economics the experiments measured: navigate by reading 19-token diffs
 * (`look`) and full-page `find`, and only pay for pixels (`shot`/`snap`) when unsure.
 *
 *   node packages/agent/tools/browse.mjs serve [--headed]     # start daemon (:8377)
 *   node packages/agent/tools/browse.mjs open <url>           # navigate + first outline
 *   node packages/agent/tools/browse.mjs look                 # what changed since last look
 *   node packages/agent/tools/browse.mjs find <text…>         # search WHOLE page → ids
 *   node packages/agent/tools/browse.mjs click <id|x,y>       # click (auto-scrolls to id)
 *   node packages/agent/tools/browse.mjs type <text…>         # type into focused element
 *   node packages/agent/tools/browse.mjs enter                # press Enter
 *   node packages/agent/tools/browse.mjs shot <file.jpg>      # native screenshot → file
 *   node packages/agent/tools/browse.mjs snap <file.png>      # snapdom render (product path)
 *   node packages/agent/tools/browse.mjs status | stop
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const PORT = 8377
const [, , CMD, ...ARGS] = process.argv

// ── Client mode: every command except `serve` is one HTTP call ───────────────────────
if (CMD !== 'serve') {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: CMD, args: ARGS }),
    })
    process.stdout.write(await res.text())
    process.exit(res.ok ? 0 : 1)
  } catch {
    console.error(`daemon no está corriendo — arrancalo con:\n  node packages/agent/tools/browse.mjs serve`)
    process.exit(1)
  }
}

// ── Daemon mode ──────────────────────────────────────────────────────────────────────
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))

const entry = join(HERE, 'sdk-entry.mjs')
await writeFile(entry, `import { observe, buildUi, agentOracle } from '${join(REPO, 'packages/agent/src/plugin.js')}'
import { snapdom } from '${join(REPO, 'src/api/snapdom.js')}'
window.__agentObserve = observe
window.__agentBuildUi = buildUi
window.__agentOracle = agentOracle
window.__snapdom = snapdom
`)
const SDK = (await esbuild.build({
  entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false,
  platform: 'browser', absWorkingDir: REPO,
})).outputFiles[0].text

const browser = await chromium.launch({ headless: !ARGS.includes('--headed') })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  bypassCSP: true,
  locale: 'es-AR',
})
// Re-injected by the browser itself on EVERY navigation — no re-injection dance.
await context.addInitScript({ content: SDK })
let page = await context.newPage()
// Sites open items in _blank popups — follow the newest page so click targets that
// spawn tabs don't strand the harness on the old one.
context.on('page', (p) => {
  p.waitForLoadState('domcontentloaded').catch(() => {})
  page = p
})

// ── In-page protocol (same shapes the realloop experiments validated) ────────────────
const observe = (previous) => {
  // Walk-only (§lite): an agent with a mission needs semantics every turn but pixels
  // almost never — the full capture cost per look was Codex's top complaint (20s on
  // wikipedia). Pixels are requested explicitly and SCOPED via `snap <id>`.
  const ui = window.__agentBuildUi(window.__agentObserve(document.body, previous ? { previous } : {}), {})
  window.__lastUi = ui
  window.__lastCp = ui.checkpoint()
  return {
    context: ui.context,
    mapTotal: ui.agentMap.map.length,
    map: ui.agentMap.map.slice(0, 40).map((e) => ({ id: e.id, r: e.r, n: e.n, b: e.b, c: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined })),
    changed: ui.changed,
    changes: ui.changes && ui.changes.slice(0, 40),
    delta: ui.actionabilityDelta,
    unobservable: ui.unobservable.length,
  }
}
const inFind = (query) => {
  const ui = window.__lastUi
  if (!ui) return []
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const q = norm(query)
  const out = []
  const seen = new Set()
  for (const e of ui.agentMap.map) {
    if (norm(e.n).includes(q) && out.length < 12) { out.push({ id: e.id, r: e.r, n: e.n, b: e.b }); seen.add(e.id) }
  }
  for (const id of ui.__snapshot.order) {
    if (out.length >= 12) break
    const n = ui.__snapshot.nodes.get(id)
    if (!seen.has(id) && n.text && norm(n.text).includes(q)) out.push({ id: n.id, r: n.role, n: n.name || n.text.slice(0, 50), b: n.bbox })
  }
  return out
}
const inLocate = (id) => {
  const ui = window.__lastUi
  const el = ui && ui.__snapshot.elements.get(id)
  if (!el) return null
  let r = el.getBoundingClientRect()
  if (r.bottom < 0 || r.top > window.innerHeight) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect() }
  const n = ui.__snapshot.nodes.get(id)
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    role: n && n.role, name: n && (n.name || (n.text || '').slice(0, 40)) }
}

// ── Rendering for a model reader: compact text, ids inline ───────────────────────────
const STRUCTURAL = /\[(button|link|textbox|searchbox|checkbox|radio|combobox|slider|spinbutton|switch|tab|menuitem|option|heading|navigation|main|banner|search|form|contentinfo|img)\]|#/
function trimOutline(context, budget = 12000) {
  if (context.length <= budget) return context
  const lines = context.split('\n').map((l) => STRUCTURAL.test(l) ? l : l.replace(/"([^"]{40})[^"]*"/, '"$1…"'))
  const depth = (l) => (l.match(/^ */)[0].length / 2) | 0
  const keep = new Array(lines.length).fill(false)
  const stack = []
  for (let i = 0; i < lines.length; i++) {
    stack[depth(lines[i])] = i
    stack.length = depth(lines[i]) + 1
    if (STRUCTURAL.test(lines[i])) for (const a of stack) keep[a] = true
  }
  let s = lines.filter((_, i) => keep[i]).join('\n')
  let note = `${lines.length - s.split('\n').length} líneas no interactivas omitidas`
  if (s.length > budget) { s = s.slice(0, budget); note = 'outline INCOMPLETO' }
  return s + `\n…[recortado: ${note} — usá find]`
}
const fmtMap = (o) => o.map.map((e) => `  ${e.id} ${e.r}${e.n ? ` "${e.n.slice(0, 60)}"` : ''} [${e.b.join(',')}]${e.c ? ` ⊘tapado por ${e.c}` : ''}`).join('\n')
const fmtFirst = (o, url) => `URL: ${url}\nactionables: ${o.mapTotal} (primeros 40 abajo; el resto vía find) · regiones no observables: ${o.unobservable}\n\nOUTLINE:\n${trimOutline(o.context)}\n\nMAPA:\n${fmtMap(o)}`
const fmtLook = (o, url) => {
  if (o.changed === undefined) return fmtFirst(o, url) // navigation happened: fresh page
  if (!o.changed) return `URL: ${url}\nsin cambios desde el último look (regiones no observables: ${o.unobservable})`
  const ch = o.changes.map((c) => `  ${c.kind} ${c.role || ''}${c.name ? ` "${String(c.name).slice(0, 50)}"` : ''} ${c.id || ''}`).join('\n')
  const d = o.delta || {}
  const vis = (d.becameVisible || []).map((r) => r.name || r.role).slice(0, 10)
  const cov = (d.becameCovered || []).map((r) => r.name || r.role).slice(0, 10)
  return `URL: ${url}\nCAMBIOS (${o.changes.length}):\n${ch}${vis.length ? `\naparecieron: ${vis.join(' · ')}` : ''}${cov.length ? `\nquedaron tapados: ${cov.join(' · ')}` : ''}`
}

// ── Command handlers ─────────────────────────────────────────────────────────────────
const settle = (ms = 1500) => page.waitForTimeout(ms)
const HANDLERS = {
  async open([url]) {
    await page.goto(url.startsWith('http') ? url : 'https://' + url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await settle(3500)
    return fmtFirst(await page.evaluate(observe, null), page.url())
  },
  async look() {
    const prev = await page.evaluate(() => window.__lastCp || null)
    return fmtLook(await page.evaluate(observe, prev), page.url())
  },
  async find(args) {
    const matches = await page.evaluate(inFind, args.join(' '))
    return matches.length
      ? matches.map((m) => `${m.id} ${m.r}${m.n ? ` "${String(m.n).slice(0, 60)}"` : ''} [${m.b.join(',')}]`).join('\n')
      : 'sin resultados'
  },
  async click([target]) {
    let point = null
    if (/^\d+,\d+$/.test(target)) { const [x, y] = target.split(',').map(Number); point = { x, y } }
    else point = await page.evaluate(inLocate, target)
    if (!point) return `no pude resolver "${target}" — usá un id del mapa/find o x,y`
    const what = point.role ? ` sobre ${point.role}${point.name ? ` "${point.name}"` : ''}` : ''
    await page.mouse.click(point.x, point.y)
    await settle()
    return `click en (${point.x},${point.y})${what} · URL: ${page.url()} — corré look para ver qué cambió`
  },
  async type(args) {
    await page.keyboard.insertText(args.join(' '))
    await settle(400)
    return 'tipeado — corré look (o enter para enviar)'
  },
  async enter() {
    await page.keyboard.press('Enter')
    await settle(2000)
    return `enter · URL: ${page.url()} — corré look`
  },
  async text([id]) {
    const t = await page.evaluate((nid) => {
      const el = window.__lastUi && window.__lastUi.__snapshot.elements.get(nid)
      return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600) : null
    }, id)
    return t === null ? `id desconocido: ${id}` : t || '(sin texto)'
  },
  async shot([file]) {
    const path = file || '/tmp/agent-browse-shot.jpg'
    await page.screenshot({ type: 'jpeg', quality: 80, path })
    return `screenshot nativo → ${path}`
  },
  async snap(args) {
    // snap [id] [file] — with an id, capture ONLY that element, expanded to an ancestor
    // until the crop carries enough context to read (the mission-driven capture: the
    // agent asks for the region it cares about, never the whole page).
    let [target, file] = args
    if (target && /\.(png|jpg)$/.test(target)) { file = target; target = null }
    const path = file || '/tmp/agent-browse-snap.png'
    const src = await page.evaluate(async (nid) => {
      if (nid) {
        const el = window.__lastUi && window.__lastUi.__snapshot.elements.get(nid)
        if (!el) return null
        // Mission-driven pixels: scroll the element to the CENTER, then capture the
        // viewport around it. (A tight rect clip would be nicer, but rect-clip over
        // deep lazy/content-visibility regions renders partially blank — real product
        // bug, documented in FIELD.md; clip:'viewport' is the 10/10-proven path.)
        el.scrollIntoView({ block: 'center' })
        await new Promise((r) => setTimeout(r, 400))
        const result = await window.__snapdom(document.body, { clip: 'viewport' })
        return (await result.toPng()).src
      }
      const result = await window.__snapdom(document.body, { clip: 'viewport' })
      return (await result.toPng()).src
    }, target || null)
    if (!src) return `id desconocido: ${target}`
    await writeFile(path, Buffer.from(src.split(',')[1], 'base64'))
    return `render snapdom de ${target ? `${target} + ancestro de contexto` : 'viewport'} → ${path}`
  },
  async status() {
    return `daemon ok · URL: ${page.url()}`
  },
  async stop() {
    setTimeout(() => process.exit(0), 100)
    return 'daemon detenido'
  },
}

const { createServer } = await import('node:http')
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    try {
      const { cmd, args = [] } = JSON.parse(body || '{}')
      if (!HANDLERS[cmd]) throw new Error(`comando desconocido: ${cmd}`)
      res.end(await HANDLERS[cmd](args) + '\n')
    } catch (e) {
      res.statusCode = 500
      res.end(String(e).split('\n')[0] + '\n')
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`agent-browse daemon en http://127.0.0.1:${PORT} (${ARGS.includes('--headed') ? 'headed' : 'headless'})`))
