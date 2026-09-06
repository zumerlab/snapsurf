/**
 * parity.mjs — TESTPLAN phase A: do the four modes give the SAME answer?
 *
 * Each mode has its own gate (vitest for the library, GATE.md for MCP, gate.mjs for
 * the extension) and none of them cross. It bit us once already: the
 * falso-positivo de `navigated` en file:// existía en el daemon y no en la
 * companion, y apareció de casualidad en un demo run.
 *
 * Runs the SAME corpus fixtures (hand-written truth) through:
 *   S1 library    — inspect() directly in the page
 *   S2 daemon     — browse.mjs serve + open/look over HTTP
 *   S3 MCP        — browser_open + browser_verify over stdio
 *   S4 Companion  — extensión MV3 real + cliente extension allowlisted
 *
 * Compares `changed` and the set of kinds. A disagreement is a bug in ONE mode, and
 * the report has to say which.
 *
 *   node experiment/parity.mjs
 *
 * Every run owns a temporary daemon port/profile. S2 and S3 still run sequentially,
 * with a verified stop in between, but never touch a developer's live daemon.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const CORPUS = join(AGENT, 'corpus')
const TMP = await mkdtemp(join(tmpdir(), 'snapdom-parity-'))
await mkdir(TMP, { recursive: true })

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to reserve parity daemon port')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

if (!process.env.SNAPDOM_AGENT_PORT) process.env.SNAPDOM_AGENT_PORT = String(await freePort())
if (!process.env.SNAPDOM_AGENT_TOKEN_FILE) process.env.SNAPDOM_AGENT_TOKEN_FILE = join(TMP, 'daemon.token')
if (!process.env.SNAPDOM_AGENT_LOGDIR) process.env.SNAPDOM_AGENT_LOGDIR = join(TMP, 'logs')
const { daemonFetch } = await import('../tools/daemon-client.mjs')

// 4 real changes + 4 noise: agreement has to hold in both directions — all of them say
// "changed" and all of them say "the noise did not change anything".
const CASES = [
  { name: 'text-update', truth: true },
  { name: 'list-row-inserted', truth: true },
  { name: 'button-enabled', truth: true },
  { name: 'modal-overlay', truth: true },
  { name: 'live-timestamp', truth: false },
  { name: 'css-animation-running', truth: false },
  { name: 'scroll-only', truth: false },
  { name: 'residual-hover', truth: false },
]

// ── Fixtures: same setup as bench-qa and test/corpus.test.js ────────────────────────
// mutate.js files are real ES modules → bundle with esbuild, never inline by regex.
const esbuild = await import('esbuild')
const bundles = new Map()
let serve = null
async function bundleMutate(name) {
  if (!bundles.has(name)) {
    const out = await esbuild.build({
      entryPoints: [join(CORPUS, name, 'mutate.js')],
      bundle: true, format: 'iife', globalName: '__mutateMod', write: false, platform: 'browser',
    })
    bundles.set(name, out.outputFiles[0].text)
  }
  return bundles.get(name)
}

// La mutación dispara a +1500ms: toda superficie observa el baseline al abrir,
// waits, and reads again. One timing for all four.
async function wrapper(name) {
  const page = await readFile(join(CORPUS, name, 'page.html'), 'utf8')
  const bundle = await bundleMutate(name)
  const html = `<!doctype html><html><body>
<script>
const container = document.createElement('div')
container.style.cssText = 'width:900px;position:relative'
container.innerHTML = ${JSON.stringify(page).replace(/<\/script/gi, '<\\/script')}
document.body.appendChild(container)
${bundle}
const __frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
setTimeout(async () => {
  try { await __mutateMod.default(container, { frame: __frame }); window.__mutated = true }
  catch (e) { window.__mutateErr = String(e) }
}, 1500)
</script></body></html>`
  await writeFile(join(TMP, `${name}.html`), html)
  return serve(name)
}

// Fixtures are served over HTTP, not file://: `history.pushState` to a new path
// lanza SecurityError bajo origen opaco (file://), la URL no cambia y el caso SPA
// produced a FALSE `navigated` alarm. Found on this phase's first run.
const staticSrv = createServer(async (req, res) => {
  // leer ANTES de mandar headers: un 404 (favicon) después de writeHead(200)
  // throws ERR_HTTP_HEADERS_SENT and kills the runner at the end of the run
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '')
  let body = null
  try { body = await readFile(join(TMP, name), 'utf8') } catch { /* no existe */ }
  if (body === null) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(body)
})
let exitCode = 1
try {
await new Promise((resolve, reject) => {
  staticSrv.once('error', reject)
  staticSrv.listen(0, '127.0.0.1', resolve)
})
const staticAddress = staticSrv.address()
if (!staticAddress || typeof staticAddress === 'string') throw new Error('failed to bind parity fixture server')
serve = (name) => `http://127.0.0.1:${staticAddress.port}/${name}.html`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kindsOf = (changes) => [...new Set((changes || []).map((c) => c.kind))].sort().join('+') || '-'

// ── Extra fixtures: the two contracts the corpus does not cover ─────────────────────
// occlusion: `becameCovered` is one of the advantages we claim (reported in the map
// BEFORE the click, not as a post-click error) — it has to hold in all 4 modes.
// spa: `navigated` is where a daemon/extension divergence bit us once.
const EXTRA = {
  'overlay-covers': `<!doctype html><html><body>
<button id="target" style="position:absolute;top:100px;left:50px;width:200px;height:40px">Comprar ahora</button>
<script>setTimeout(() => {
  const o = document.createElement('div')
  o.setAttribute('role','dialog'); o.setAttribute('aria-label','Aviso de cookies')
  o.style.cssText = 'position:absolute;top:90px;left:40px;width:300px;height:80px;background:#fff;border:1px solid #000'
  o.textContent = 'Aceptamos cookies'
  document.body.appendChild(o)
}, 1500)</script></body></html>`,
  'spa-softnav': `<!doctype html><html><body>
<h1>Inicio</h1><div id="content"><a href="/x">un link</a></div>
<script>setTimeout(() => {
  history.pushState({}, '', '/parity-spa-probe')
  document.getElementById('content').innerHTML = '<p>contenido nuevo de la ruta</p>'
}, 1500)</script></body></html>`,
}
async function extraWrapper(name) {
  await writeFile(join(TMP, `${name}.html`), EXTRA[name])
  return serve(name)
}
const coveredOf = (delta) => ((delta && delta.becameCovered) || []).length

// ── S1: SDK directo ──────────────────────────────────────────────────────────────────
async function runSdk(urls) {
  const { chromium } = await import('playwright')
  const entry = join(TMP, 'sdk-entry.mjs')
  await writeFile(entry, `import { observe, buildUi } from '${join(AGENT, 'src/plugin.js')}'
window.__observe = observe
window.__buildUi = buildUi
`)
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser' })
  const sdk = built.outputFiles[0].text

  const browser = await chromium.launch()
  const out = {}
  try {
    for (const [name, url] of Object.entries(urls)) {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      await page.goto(url)
      await page.addScriptTag({ content: sdk })
      await page.waitForTimeout(300)
      // reference point → (the mutation fires by itself at +1500ms) → second reading
      const res = await page.evaluate(async () => {
        const first = await window.__observe(document.body, {})
        const cp = window.__buildUi(first, {}).checkpoint()
        await new Promise((r) => setTimeout(r, 2200))
        const second = await window.__observe(document.body, { previous: cp })
        const ui = window.__buildUi(second, {})
        const d = ui.actionabilityDelta || {}
        return {
          changed: !!ui.changed,
          changes: (ui.changes || []).map((c) => ({ kind: c.kind })),
          covered: (d.becameCovered || []).length,
        }
      })
      // navigated is not the library's business: modes that track a URL add it
      out[name] = { changed: res.changed, kinds: kindsOf(res.changes), covered: res.covered, navigated: null }
      await page.close()
    }
    return out
  } finally {
    await browser.close()
  }
}

// ── S2: the daemon over HTTP ────────────────────────────────────────────────────────
const daemonCmd = (cmd, args = []) =>
  daemonFetch({
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args, envelope: true }),
  }).then((r) => r.json())

async function runDaemon(urls) {
  const srv = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore', detached: false })
  const out = {}
  try {
    for (let i = 0; i < 40; i++) {
      try { await daemonCmd('status'); break } catch { await sleep(500) }
    }
    for (const [name, url] of Object.entries(urls)) {
      await daemonCmd('open', [url])
      await sleep(2200)
      const look = await daemonCmd('look')
      const meta = look.meta || {}
      // the printed text is what a human or model reads; the kinds come from there
      const text = look.text || ''
      const kinds = [...new Set([...text.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]))].sort().join('+') || '-'
      const cov = text.match(/became covered: (.+)$/m)
      out[name] = {
        changed: !!meta.changed, kinds,
        covered: cov ? cov[1].split(' · ').length : 0,
        navigated: !!meta.navigated,
      }
    }
    return out
  } finally {
    await Promise.race([
      new Promise((resolve) => {
        const stop = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' })
        stop.once('error', resolve)
        stop.once('exit', resolve)
      }),
      sleep(5000),
    ])
    if (srv.exitCode === null) srv.kill('SIGTERM')
  }
}

// ── S3: MCP over stdio ──────────────────────────────────────────────────────────────
async function runMcp(urls) {
  const srv = spawn(process.execPath, [join(AGENT, 'mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] })
  const exited = new Promise((resolve) => srv.once('exit', resolve))
  const pending = new Map()
  let id = 1
  createInterface({ input: srv.stdout }).on('line', (l) => {
    try { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id) } catch { /* ruido */ }
  })
  const call = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
  const out = {}
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } })
    for (const [name, url] of Object.entries(urls)) {
      await call('tools/call', { name: 'browser_open', arguments: { url } })
      await sleep(2200)
      const v = await call('tools/call', { name: 'browser_verify', arguments: {} })
      const sc = v.result?.structuredContent || {}
      const text = v.result?.content?.[0]?.text || ''
      const kinds = [...new Set([...text.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]))].sort().join('+') || '-'
      const cov = text.match(/became covered: (.+)$/m)
      out[name] = {
        changed: !!sc.changed, kinds,
        covered: cov ? cov[1].split(' · ').length : 0,
        navigated: !!sc.navigated,
      }
    }
    return out
  } finally {
    if (srv.exitCode === null) srv.stdin.end()
    const clean = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
    if (!clean && srv.exitCode === null) srv.kill('SIGTERM')
    await Promise.race([exited, sleep(3000)])
  }
}

// ── S4: companion MV3 real ───────────────────────────────────────────────────────────
async function runCompanion(urls) {
  const { chromium } = await import('playwright')
  const PROFILE = await mkdtemp(join(tmpdir(), 'snapdom-parity-companion-'))
  const EXT = join(AGENT, 'companion')
  const CLIENT = join(EXT, 'gate-client')
  const CLIENT_ID = 'caajdlhkjophkdagpdchjbllohjojgml'
  let ctx = null
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium', viewport: { width: 800, height: 600 },
      args: [`--disable-extensions-except=${EXT},${CLIENT}`, `--load-extension=${EXT},${CLIENT}`],
    })
    if (!ctx.serviceWorkers().some((w) => new URL(w.url()).host === CLIENT_ID)) {
      const wake = await ctx.newPage()
      await wake.goto(`chrome-extension://${CLIENT_ID}/worker.js`).catch(() => {})
      await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null)
      await wake.close()
    }
    const clientWorker = ctx.serviceWorkers().find((w) => new URL(w.url()).host === CLIENT_ID)
    if (!clientWorker) throw new Error('parity gate-client service worker did not start')

    const out = {}
    for (const [name, url] of Object.entries(urls)) {
      const page = await ctx.newPage()
      await page.goto(url)
      await page.waitForTimeout(400)
      const tabId = await clientWorker.evaluate((targetUrl) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === targetUrl)?.id), page.url())
      if (!Number.isInteger(tabId)) throw new Error(`could not resolve companion tab for ${name}`)
      const ask = (request) => clientWorker.evaluate(
        ({ id, request }) => globalThis.snapdomGateAsk(id, request),
        { id: tabId, request },
      )
      await ask({ type: 'SNAPDOM_OBSERVE', obsId: `${name}-baseline` })
      await page.waitForTimeout(2200)
      const envelope = await ask({ type: 'SNAPDOM_OBSERVE', obsId: `${name}-after` })
      if (envelope?.error) throw new Error(`companion ${name}: ${envelope.error}`)
      const r2 = envelope?.result
      out[name] = {
        changed: !!r2?.changed, kinds: kindsOf(r2?.changes),
        covered: coveredOf(r2?.actionabilityDelta),
        navigated: !!r2?.navigated,
      }
      await page.close()
    }
    return out
  } finally {
    await ctx?.close()
    await rm(PROFILE, { recursive: true, force: true })
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────
const urls = {}
for (const c of CASES) urls[c.name] = await wrapper(c.name)
for (const name of Object.keys(EXTRA)) urls[name] = await extraWrapper(name)

console.log('S1 SDK…');       const s1 = await runSdk(urls)
console.log('S2 CLI daemon…'); const s2 = await runDaemon(urls)
console.log('S3 MCP…');        const s3 = await runMcp(urls)
console.log('S4 companion…');  const s4 = await runCompanion(urls)

const surfaces = { S1: s1, S2: s2, S3: s3, S4: s4 }
console.log('\n| fixture | truth | S1 SDK | S2 CLI | S3 MCP | S4 extension | agree |')
console.log('|---|:---:|---|---|---|---|:---:|')
let disagreements = 0
let wrong = 0
for (const c of CASES) {
  const cells = Object.values(surfaces).map((s) => s[c.name] || { changed: null, kinds: '?' })
  const changedSet = new Set(cells.map((x) => String(x.changed)))
  const kindsSet = new Set(cells.map((x) => x.kinds))
  const agree = changedSet.size === 1
  const kindsAgree = kindsSet.size === 1
  if (!agree) disagreements++
  if (cells.some((x) => x.changed !== c.truth)) wrong++
  const mark = agree ? (kindsAgree ? '✅' : '⚠️ kinds') : '❌'
  console.log(`| ${c.name} | ${c.truth} | ${cells.map((x) => `${x.changed} (${x.kinds})`).join(' | ')} | ${mark} |`)
}
// ── Extra contracts: occlusion (all 4) and navigated (the 3 that track a URL) ───────
console.log('\n| contract | S1 SDK | S2 CLI | S3 MCP | S4 extension | agree |')
console.log('|---|---|---|---|---|:---:|')
const occ = Object.values(surfaces).map((s) => (s['overlay-covers'] || {}).covered)
const occAgree = occ.every((n) => n > 0)
if (!occAgree) disagreements++
console.log(`| becameCovered (an overlay covers a button) | ${occ.map((n) => `${n} covered`).join(' | ')} | ${occAgree ? '✅' : '❌'} |`)

// S1 does not take part: the library returns the comparison, the modes track the URL
const navCells = ['S2', 'S3', 'S4'].map((k) => (surfaces[k]['spa-softnav'] || {}).navigated)
const navAgree = navCells.every((v) => v === true)
if (!navAgree) disagreements++
console.log(`| navigated after pushState | n/a (by design) | ${navCells.map(String).join(' | ')} | ${navAgree ? '✅' : '❌'} |`)

console.log(`\nDisagreements on \`changed\`: ${disagreements}/${CASES.length} · cases contradicting the truth in some mode: ${wrong}/${CASES.length}`)
console.log(disagreements === 0 && wrong === 0
  ? 'MODES AGREE — all four give the same answers on this corpus'
  : 'MODES DISAGREE — identify WHICH mode diverges before showing this to anyone')
exitCode = disagreements === 0 && wrong === 0 ? 0 : 1
} finally {
  staticSrv.closeAllConnections?.()
  if (staticSrv.listening) await new Promise((resolve) => staticSrv.close(resolve))
  await rm(TMP, { recursive: true, force: true })
}
process.exitCode = exitCode
