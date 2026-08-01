/**
 * parity.mjs — TESTPLAN Fase A: ¿las cuatro superficies contestan lo MISMO?
 *
 * Cada superficie tiene su propio gate (vitest para el SDK, GATE.md para el MCP,
 * gate.mjs para la companion) y ninguno cruza. Ya nos mordió una vez: el
 * falso-positivo de `navigated` en file:// existía en el daemon y no en la
 * companion, y apareció de casualidad en un demo run.
 *
 * Corre las MISMAS fixtures del corpus (truth escrita a mano) por:
 *   S1 SDK        — inspect() directo en la página
 *   S2 CLI daemon — browse.mjs serve + open/look por HTTP
 *   S3 MCP        — browser_open + browser_verify por stdio
 *   S4 Companion  — extensión MV3 real + postMessage
 *
 * Compara `changed` y el conjunto de kinds. Discrepancia = bug de UNA superficie,
 * y el reporte tiene que decir cuál.
 *
 *   node packages/agent/experiment/parity.mjs
 *
 * LANDMINE: el puerto 8377 es compartido — S2 levanta su daemon y S3 hace que el
 * servidor MCP levante el suyo. Corren SECUENCIALES, con stop verificado entre medio.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const REPO = join(AGENT, '..', '..')
const CORPUS = join(AGENT, 'corpus')
const TMP = '/tmp/snapdom-parity'
await mkdir(TMP, { recursive: true })

// 4 cambios reales + 4 de ruido: la paridad tiene que valer en ambos sentidos
// (todas dicen "cambió" y todas dicen "no cambió por el ruido").
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

// ── Fixtures: mismo montaje que bench-qa y que test/corpus.test.js ───────────────────
// mutate.js son módulos ES reales → bundlear con esbuild (nunca inline por regex).
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
const bundles = new Map()
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
// espera, y vuelve a observar. Un solo timing para las cuatro.
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
  const file = join(TMP, `${name}.html`)
  await writeFile(file, html)
  return pathToFileURL(file).href
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kindsOf = (changes) => [...new Set((changes || []).map((c) => c.kind))].sort().join('+') || '-'

// ── S1: SDK directo ──────────────────────────────────────────────────────────────────
async function runSdk(urls) {
  const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
  const entry = join(TMP, 'sdk-entry.mjs')
  await writeFile(entry, `import { observe, buildUi } from '${join(AGENT, 'src/plugin.js')}'
window.__observe = observe
window.__buildUi = buildUi
`)
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser' })
  const sdk = built.outputFiles[0].text

  const browser = await chromium.launch()
  const out = {}
  for (const [name, url] of Object.entries(urls)) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(url)
    await page.addScriptTag({ content: sdk })
    await page.waitForTimeout(300)
    // baseline → (la mutación cae sola a +1500ms) → segunda observación con previous
    const res = await page.evaluate(async () => {
      const first = await window.__observe(document.body, {})
      const cp = window.__buildUi(first, {}).checkpoint()
      await new Promise((r) => setTimeout(r, 2200))
      const second = await window.__observe(document.body, { previous: cp })
      const ui = window.__buildUi(second, {})
      return { changed: !!ui.changed, changes: (ui.changes || []).map((c) => ({ kind: c.kind })) }
    })
    out[name] = { changed: res.changed, kinds: kindsOf(res.changes) }
    await page.close()
  }
  await browser.close()
  return out
}

// ── S2: CLI daemon por HTTP ──────────────────────────────────────────────────────────
const daemonCmd = (cmd, args = []) =>
  fetch('http://127.0.0.1:8377/cmd', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args, envelope: true }),
  }).then((r) => r.json())

async function runDaemon(urls) {
  const srv = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore', detached: false })
  for (let i = 0; i < 40; i++) {
    try { await daemonCmd('status'); break } catch { await sleep(500) }
  }
  const out = {}
  for (const [name, url] of Object.entries(urls)) {
    await daemonCmd('open', [url])
    await sleep(2200)
    const look = await daemonCmd('look')
    const meta = look.meta || {}
    // el texto del look es la superficie que lee un humano/LLM; los kinds salen de ahí
    const kinds = [...new Set([...(look.text || '').matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]))].sort().join('+') || '-'
    out[name] = { changed: !!meta.changed, kinds }
  }
  await new Promise((r) => { const s = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
  try { srv.kill() } catch { /* ya murió */ }
  await sleep(1200)
  return out
}

// ── S3: MCP por stdio ────────────────────────────────────────────────────────────────
async function runMcp(urls) {
  const srv = spawn(process.execPath, [join(AGENT, 'mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let id = 1
  createInterface({ input: srv.stdout }).on('line', (l) => {
    try { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id) } catch { /* ruido */ }
  })
  const call = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } })
  const out = {}
  for (const [name, url] of Object.entries(urls)) {
    await call('tools/call', { name: 'browser_open', arguments: { url } })
    await sleep(2200)
    const v = await call('tools/call', { name: 'browser_verify', arguments: {} })
    const sc = v.result?.structuredContent || {}
    const text = v.result?.content?.[0]?.text || ''
    const kinds = [...new Set([...text.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]))].sort().join('+') || '-'
    out[name] = { changed: !!sc.changed, kinds }
  }
  srv.kill()
  await sleep(1500)
  return out
}

// ── S4: companion MV3 real ───────────────────────────────────────────────────────────
async function runCompanion(urls) {
  const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
  const PROFILE = '/tmp/parity-companion-profile'
  await rm(PROFILE, { recursive: true, force: true })
  const EXT = join(AGENT, 'companion')
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium', viewport: { width: 800, height: 600 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  const out = {}
  for (const [name, url] of Object.entries(urls)) {
    const page = await ctx.newPage()
    await page.goto(url)
    await page.waitForTimeout(400)
    const ask = (msg) => page.evaluate(async (m) => {
      const obsId = Date.now() + Math.random()
      const res = new Promise((r) => {
        const h = (e) => {
          if (e.data && e.data.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) { removeEventListener('message', h); r(e.data.result) }
        }
        addEventListener('message', h)
        setTimeout(() => r(null), 30000)
      })
      window.postMessage({ ...m, obsId }, '*')
      return await res
    }, msg)
    await ask({ type: 'SNAPDOM_OBSERVE' }) // baseline
    await page.waitForTimeout(2200)
    const r2 = await ask({ type: 'SNAPDOM_OBSERVE' })
    out[name] = { changed: !!(r2 && r2.changed), kinds: kindsOf(r2 && r2.changes) }
    await page.close()
  }
  await ctx.close()
  return out
}

// ── Run ──────────────────────────────────────────────────────────────────────────────
const urls = {}
for (const c of CASES) urls[c.name] = await wrapper(c.name)

console.log('S1 SDK…');       const s1 = await runSdk(urls)
console.log('S2 CLI daemon…'); const s2 = await runDaemon(urls)
console.log('S3 MCP…');        const s3 = await runMcp(urls)
console.log('S4 companion…');  const s4 = await runCompanion(urls)

const surfaces = { S1: s1, S2: s2, S3: s3, S4: s4 }
console.log('\n| fixture | truth | S1 SDK | S2 CLI | S3 MCP | S4 comp | paridad |')
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
console.log(`\nDesacuerdos de \`changed\`: ${disagreements}/${CASES.length} · casos que contradicen la truth en alguna superficie: ${wrong}/${CASES.length}`)
console.log(disagreements === 0 && wrong === 0
  ? 'PARIDAD OK — las cuatro superficies son el mismo oráculo sobre este corpus'
  : 'PARIDAD ROJA — hay que identificar QUÉ superficie diverge antes de mostrar esto a un tercero')
process.exit(disagreements === 0 && wrong === 0 ? 0 : 1)
