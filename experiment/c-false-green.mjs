/**
 * c-false-green.mjs — TESTPLAN Fase C: false-green diferencial.
 *
 * Eight actions that LOOK as if they worked, on `demo-qa/silent-failures.html`.
 * Three channels answer "did my action have an effect?", and an independent judge —
 * `window.__truth()`, which reads the real DOM state without going through any channel —
 * says what actually happened.
 *
 *   node experiment/c-false-green.mjs
 *
 * Metric: WRONG SUCCESS = the channel suggests the action worked when it did not.
 * (And its mirror, WRONG FAILURE: it suggests nothing happened when something did.)
 *
 * La página tiene ruido ambiental a propósito (reloj vivo + spinner + marquesina):
 * that is the real condition that makes every visual assertion flaky.
 */
/* global window, Image, document, diffPixels */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { setTimeout, clearTimeout } from 'node:timers'
import process from 'node:process'
import console from 'node:console'
import { daemonFetch } from '../tools/daemon-client.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const { resolveHost } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const childExited = (child) => child.exitCode !== null || child.signalCode !== null
const waitForChildExit = (child, timeoutMs) => {
  if (childExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { child.off('exit', done); resolve(childExited(child)) }, timeoutMs)
    child.once('exit', done)
  })
}

const closeServer = async (server) => {
  if (!server) return
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
}

const freeLoopbackPort = async () => {
  const reservation = createServer()
  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('failed to reserve isolated daemon port')
    return address.port
  } finally {
    await closeServer(reservation)
  }
}

const unique = randomBytes(10).toString('hex')
const RUNTIME = await mkdtemp(join(tmpdir(), 'snapdom-false-green-'))
const FIXTURE_FILE = join(RUNTIME, 'app.html')
const AB_CONFIG = join(RUNTIME, 'agent-browser.json')
const AB_SESSION = `snapdom-fg-${unique}`
const AB_NAMESPACE = `snapdom-fg-${unique}`

// A caller's agent-browser environment may opt into their real Chrome profile, a CDP
// endpoint, restore state, extensions, provider plugins, or a headed browser. None of
// those settings may participate in this benchmark. Keep HOME unchanged, use a specific
// empty config, and force a unique transient session/namespace restricted to loopback.
const AB_ENV = { ...process.env, TMPDIR: RUNTIME }
for (const key of Object.keys(AB_ENV)) {
  if (key.startsWith('AGENT_BROWSER_') || [
    'BROWSER_WS_ENDPOINT', 'CDP_ENDPOINT', 'CDP_ENDPOINT_URL', 'CDP_URL',
    'CHROME_EXECUTABLE', 'CHROME_PATH', 'CHROME_REMOTE_DEBUGGING_PORT',
    'CHROME_USER_DATA_DIR', 'PUPPETEER_EXECUTABLE_PATH',
  ].includes(key)) delete AB_ENV[key]
}

const abRun = (args) => run('agent-browser', [
  '--session', AB_SESSION,
  '--namespace', AB_NAMESPACE,
  '--config', AB_CONFIG,
  '--headed', 'false',
  '--allowed-domains', '127.0.0.1',
  '--idle-timeout', '30s',
  ...args,
], { cwd: RUNTIME, timeout: 60000, maxBuffer: 8 << 20, env: AB_ENV })
const ab = (args) => abRun(args).then((r) => r.stdout).catch((e) => `__ERR__ ${e.message}`)

// ── The eight failures: the action, and what the truth says ─────────────────────────
const IGN = ['.marquee', '.marquee span', '#clock']
const CASES = [
  { id: 'f1', label: 'plain no-op', sel: '#f1', truthKey: 'f1',
    intent: { changed: true, ignore: IGN } },
  { id: 'f2', label: 'submit rejected silently', sel: '#f2', truthKey: 'f2', pre: 'document.getElementById("f2-email").value = "sin-arroba"',
    intent: { mustInclude: [{ kind: 'added' }], ignore: IGN } },
  { id: 'f3', label: 'click swallowed by an overlay', sel: '#f3', truthKey: 'f3',
    intent: { exists: 'Carrito: 1 items', ignore: IGN } },
  { id: 'f4', label: 'notification already gone', sel: '#f4', truthKey: 'f4', settle: 900,
    intent: { exists: 'Borradores guardados: 1', ignore: IGN } },
  { id: 'f5', label: 'works, but out of view', sel: '#f5', truthKey: 'f5',
    intent: { mustInclude: [{ kind: 'added', name: 'fila agregada' }], ignore: IGN } },
  { id: 'f6', label: 'state change with no visual difference', sel: '#f6', truthKey: 'f6',
    intent: { mustInclude: [{ kind: 'state', name: 'Enviar' }], ignore: IGN } },
  { id: 'f7', label: 'double effect (inserted 2, not 1)', sel: '#f7', truthKey: 'f7',
    intent: { mustInclude: [{ kind: 'added' }], maxChanges: 2, ignore: IGN } },
  { id: 'f8', label: 'half-hydrated single-page navigation', sel: '#f8', truthKey: 'f8',
    intent: { urlIncludes: '/detalle/', exists: 'vista de detalle', ignore: IGN } },
]

// A REAL click: it goes through hit-testing, so an overlay genuinely intercepts it. A
// programmatic `element.click()` would pass straight through and invalidate case F3.
const realClick = async (page, sel) => {
  // locator.click({force:true}) dispatches a REAL mouse event at the element's centre and
  // scrolls to it first. `force` skips Playwright's own actionability checks, not the
  // browser's hit-testing: if an overlay is on top, the overlay gets the click, which is
  // exactly what F3 needs.
  // mouse.click(box.x, box.y) did NOT work: boundingBox gives page coordinates, so buttons
  // below the fold fell outside the viewport and the click landed on nothing.
  const el = page.locator(sel)
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.click({ force: true, timeout: 5000 }).catch(() => {})
  return true
}

const rows = []
let srv = null
let daemon = null
let daemonPort = null
let daemonRequest = null
let pxBrowser = null
let abTouched = false
let daemonSpawnError = null
let primaryError = null
const cleanupErrors = []
const savedClientEnv = new Map([
  ['SNAPSURF_TOKEN', process.env.SNAPSURF_TOKEN],
  ['SNAPSURF_TOKEN_FILE', process.env.SNAPSURF_TOKEN_FILE],
])
let clientEnvChanged = false

try {
  const PAGE = await readFile(join(AGENT, 'demo-qa/silent-failures.html'), 'utf8')
  const diffSrc = (await readFile(join(REPO, 'node_modules/@zumer/snapdiff/src/diff.js'), 'utf8')).replace(/^export /gm, '')
  await writeFile(FIXTURE_FILE, PAGE, { mode: 0o600 })
  await writeFile(AB_CONFIG, '{}\n', { mode: 0o600 })

  srv = createServer(async (_req, res) => {
    // toda ruta sirve la app: F8 hace pushState a /detalle/42
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(await readFile(FIXTURE_FILE, 'utf8'))
  })
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', resolve)
  })
  const fixtureAddress = srv.address()
  if (!fixtureAddress || typeof fixtureAddress === 'string') throw new Error('failed to bind isolated fixture server')
  const URL_ = `http://127.0.0.1:${fixtureAddress.port}/app.html`

  // ── Channel 1: our reader (our daemon) ────────────────────────────────────────────
  do daemonPort = await freeLoopbackPort()
  while (daemonPort === 8377)
  const tokenFile = join(RUNTIME, 'daemon.token')
  const logDir = join(RUNTIME, 'daemon-logs')
  process.env.SNAPSURF_TOKEN_FILE = tokenFile
  delete process.env.SNAPSURF_TOKEN
  clientEnvChanged = true
  const daemonEnv = {
    ...process.env,
    SNAPSURF_PORT: String(daemonPort),
    SNAPSURF_TOKEN_FILE: tokenFile,
    SNAPSURF_LOGDIR: logDir,
  }
  delete daemonEnv.SNAPSURF_TOKEN

  daemon = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], {
    stdio: 'ignore',
    env: daemonEnv,
  })
  daemon.once('error', (error) => { daemonSpawnError = error })
  daemonRequest = async (c, args = []) => {
    const response = await daemonFetch({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: c, args, envelope: true }),
    }, daemonPort)
    return { response, payload: await response.json() }
  }
  const cmd = (c, args = []) => daemonRequest(c, args)
    .then(({ payload }) => payload)
    .catch((error) => ({ ok: false, text: String(error) }))

  let daemonReady = false
  for (let i = 0; i < 40; i++) {
    const status = await cmd('status')
    if (status.ok) { daemonReady = true; break }
    if (childExited(daemon)) break
    await sleep(500)
  }
  if (!daemonReady) throw new Error(`isolated daemon failed to start on ${daemonPort}${daemonSpawnError ? `: ${daemonSpawnError.message}` : ''}`)

  // ── Channel 3: pixel comparison (same perceptual algorithm as bench-qa) ───────────
  const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
  pxBrowser = await chromium.launch({ headless: true })

  for (const c of CASES) {
    const settle = c.settle || 600

    // ── independent truth (the judge): real state, through no channel ──────────────
    const judgePage = await pxBrowser.newPage({ viewport: { width: 900, height: 700 } })
    await judgePage.goto(URL_)
    await judgePage.waitForTimeout(400)
    if (c.pre) await judgePage.evaluate(c.pre)
    await realClick(judgePage, c.sel)
    await judgePage.waitForTimeout(settle)
    const truth = await judgePage.evaluate((k) => window.__truth()[k], c.truthKey)
    // The truth that matters for QA is whether the intended POSTCONDITION happened.
    const reallyHappened = await judgePage.evaluate((k) => window.__intent()[k], c.truthKey)

    // ── pixel channel ──────────────────────────────────────────────────────────────
    const pxPage = await pxBrowser.newPage({ viewport: { width: 900, height: 700 } })
    await pxPage.goto(URL_)
    await pxPage.waitForTimeout(400)
    if (c.pre) await pxPage.evaluate(c.pre)
    const before = await pxPage.screenshot()
    await realClick(pxPage, c.sel)
    await pxPage.waitForTimeout(settle)
    const after = await pxPage.screenshot()
    const px = await pxPage.evaluate(async ({ a, b, diffCode }) => {
      // same call as bench-qa's pixel arm: diffPixels(da, db, out, w, h, {})
      // sobre datos crudos. Mi primera versión pasaba ImageData y devolvía undefined→0.
      (0, eval)(diffCode)
      const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64 })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const w = ia.width, h = ia.height
      const raw = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h
        const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data }
      const da = raw(ia), db = raw(ib)
      const out = new Uint8ClampedArray(da.length)
      const r = diffPixels(da, db, out, w, h, {})
      return { ratio: r.diff / r.total, diff: r.diff }
    }, { a: before.toString('base64'), b: after.toString('base64'), diffCode: diffSrc })
    await pxPage.close(); await judgePage.close()

    // ── our channel ────────────────────────────────────────────────────────────────
    await cmd('open', [URL_])
    if (c.pre) await cmd('eval' in {} ? 'eval' : 'find', []) // no-op: the setup happens through the click below
    // the setup (filling the input) uses the same mechanism in both channels
    if (c.pre) await cmd('find', ['Email'])
    const f = await cmd('find', [c.id === 'f2' ? 'Suscribirme' : c.id === 'f1' ? 'Actualizar datos'
      : c.id === 'f3' ? 'Comprar ahora' : c.id === 'f4' ? 'Guardar borrador'
        : c.id === 'f5' ? 'Agregar fila' : c.id === 'f6' ? 'Validar formulario'
          : c.id === 'f7' ? 'Agregar item' : 'Ver detalle'])
    const btnId = (f.text || '').match(/\bn_[A-Za-z0-9_-]+\b/)?.[0]
    if (c.pre) {
      // fill the invalid email the same way an agent would
      const fe = await cmd('find', ['Email'])
      const inputId = (fe.text || '').match(/\bn_[A-Za-z0-9_-]+\b/)?.[0]
      if (inputId) { await cmd('click', [inputId]); await cmd('type', ['sin-arroba']) }
    }
    if (btnId) await cmd('click', [btnId])
    await sleep(settle)
    // ORDEN: primero el assert (keepBaseline no consume), después el look. Al revés,
    // `look` consumía el baseline y el assert comparaba post-click contra post-click.
    const intent = await cmd('assert', [JSON.stringify({ ...c.intent, keepBaseline: true })])
    const intentPass = /^PASS/.test(intent.text || '')
    const intentText = (intent.text || '').slice(0, 220).replace(/\n/g, ' ')
    const look = await cmd('look')
    const oracleChanged = !!(look.meta && look.meta.changed)
    const oracleText = (look.text || '').slice(0, 200).replace(/\n/g, ' ')
    // configuración documentada: la marquesina es movimiento decorativo, y el producto
    // has `ignore` for exactly that. Measured with and without the remedy, just like
    // agent-browser se mide as-is y normalizado.

    // ── agent-browser channel ──────────────────────────────────────────────────────
    abTouched = true
    await ab(['open', URL_])
    await sleep(400)
    if (c.pre) await ab(['eval', 'document.getElementById("f2-email").value = "sin-arroba"'])
    const abBefore = await ab(['snapshot'])
    const bFile = join(RUNTIME, `${c.id}.before.txt`)
    await writeFile(bFile, abBefore)
    await ab(['click', c.sel])   // their real click, not eval: the same yardstick as the others
    await sleep(settle)
    const abDiff = await ab(['diff', 'snapshot', '-b', bFile])
    const m = abDiff.match(/(\d+) additions?, (\d+) removals?/)
    const abAsIs = m ? (Number(m[1]) > 0 || Number(m[2]) > 0) : null
    const abAfter = await ab(['snapshot'])
    const strip = (s) => s.replace(/\s*\[?ref=e\d+\]?/g, '').replace(/,\s*\]/g, ']').trimEnd()
    const norm = (s) => strip(s).split('\n').map((l) => l.trimEnd()).filter(Boolean)
    const A = norm(abBefore), B = norm(abAfter)
    const abStripped = A.length !== B.length || A.some((l, i) => l !== B[i])

    rows.push({
      id: c.id, label: c.label, truth: reallyHappened, truthDetail: truth,
      oracle: oracleChanged, oracleText, intentPass, intentText,
      abAsIs, abStripped,
      pixelRatio: px.ratio, pixel: px.ratio > 0.0005,
    })
    console.log(`${c.id} ${c.label.padEnd(32)} truth=${String(reallyHappened).padEnd(5)} raw=${String(oracleChanged).padEnd(5)} assert=${String(intentPass).padEnd(5)} ab-asis=${String(abAsIs).padEnd(5)} ab-strip=${String(abStripped).padEnd(5)} pixel=${(px.ratio * 100).toFixed(3)}%`)
  }

  // ── Métrica: false green / false red ───────────────────────────────────────────────
  const tally = (key) => {
    const fg = rows.filter((r) => !r.truth && r[key] === true).length     // says yes, it did not happen
    const fr = rows.filter((r) => r.truth && r[key] === false).length     // says no, it did happen
    return { fg, fr, ok: rows.filter((r) => r[key] === r.truth).length }
  }
  const o = tally('oracle'), oi = tally('intentPass'), a1 = tally('abAsIs'), a2 = tally('abStripped'), p = tally('pixel')
  console.log('\n| channel | right | WRONG SUCCESS | wrong failure |')
  console.log('|---|---:|---:|---:|')
  console.log(`| Raw "did anything change?" | ${o.ok}/${rows.length} | **${o.fg}** | ${o.fr} |`)
  console.log(`| **Stated expectation, checked** | **${oi.ok}/${rows.length}** | **${oi.fg}** | ${oi.fr} |`)
  console.log(`| agent-browser as-is | ${a1.ok}/${rows.length} | **${a1.fg}** | ${a1.fr} |`)
  console.log(`| agent-browser, references normalized | ${a2.ok}/${rows.length} | **${a2.fg}** | ${a2.fr} |`)
  console.log(`| Screenshot (pixel comparison) | ${p.ok}/${rows.length} | **${p.fg}** | ${p.fr} |`)

  await writeFile(join(AGENT, 'experiment/results/c-false-green.json'), JSON.stringify({ rows, tally: { oracle: o, intentAssert: oi, abAsIs: a1, abStripped: a2, pixel: p } }, null, 2) + '\n')
  console.log('\n→ experiment/results/c-false-green.json')
} catch (error) {
  primaryError = error
} finally {
  if (abTouched) {
    try { await abRun(['close']) } catch (error) { cleanupErrors.push(new Error(`agent-browser cleanup failed: ${error.message || error}`)) }
  }

  if (pxBrowser) {
    try { await pxBrowser.close() } catch (error) { cleanupErrors.push(new Error(`Playwright cleanup failed: ${error.message || error}`)) }
  }

  if (daemon && !childExited(daemon)) {
    let stopError = null
    try {
      const stopped = await daemonRequest?.('stop')
      if (!stopped?.response.ok || stopped.payload?.ok === false) {
        stopError = new Error(stopped?.payload?.text || `HTTP ${stopped?.response.status}`)
      }
    } catch (error) {
      stopError = error
    }

    let exited = await waitForChildExit(daemon, 2500)
    if (!exited && daemon.pid) {
      try { process.kill(daemon.pid, 'SIGTERM') } catch { /* already gone */ }
      exited = await waitForChildExit(daemon, 1000)
    }
    if (!exited && daemon.pid) {
      try { process.kill(daemon.pid, 'SIGKILL') } catch { /* already gone */ }
      exited = await waitForChildExit(daemon, 1000)
    }
    if (!exited) cleanupErrors.push(new Error(`isolated daemon leaked on port ${daemonPort}`))
    else if (stopError) cleanupErrors.push(new Error(`authenticated daemon stop failed before forced cleanup: ${stopError.message || stopError}`))
  }

  try { await closeServer(srv) } catch (error) { cleanupErrors.push(new Error(`fixture server cleanup failed: ${error.message || error}`)) }

  if (clientEnvChanged) {
    for (const [key, value] of savedClientEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  try { await rm(RUNTIME, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(new Error(`temporary runtime cleanup failed: ${error.message || error}`)) }
}

if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'benchmark and cleanup failed')
if (primaryError) throw primaryError
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'benchmark cleanup failed')
