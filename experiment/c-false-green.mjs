/**
 * c-false-green.mjs — TESTPLAN Fase C: false-green diferencial.
 *
 * Ocho acciones que PARECEN haber funcionado, sobre `demo-qa/silent-failures.html`.
 * Tres canales de percepción responden "¿mi acción tuvo efecto?" y un juez
 * independiente —`window.__truth()`, que lee el estado real del DOM sin pasar por
 * ningún canal— dice qué pasó de verdad.
 *
 *   node packages/agent/experiment/c-false-green.mjs
 *
 * Métrica: FALSE GREEN = el canal sugiere que la acción funcionó cuando no funcionó.
 * (Y su simétrico, FALSE RED: sugiere que no pasó nada cuando sí pasó.)
 *
 * La página tiene ruido ambiental a propósito (reloj vivo + spinner + marquesina):
 * es la condición real que hace flaky a toda aserción visual.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const REPO = join(AGENT, '..', '..')
const TMP = '/tmp/snapdom-fasec'
await mkdir(TMP, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ab = (args) => run('agent-browser', args, { timeout: 60000, maxBuffer: 8 << 20 })
  .then((r) => r.stdout).catch((e) => `__ERR__ ${e.message}`)

// ── Las ocho fallas: qué acción, y qué dice la verdad ────────────────────────────────
const IGN = ['.marquee', '.marquee span', '#clock']
const CASES = [
  { id: 'f1', label: 'no-op puro', sel: '#f1', truthKey: 'f1',
    intent: { changed: true, ignore: IGN } },
  { id: 'f2', label: 'submit rechazado en silencio', sel: '#f2', truthKey: 'f2', pre: 'document.getElementById("f2-email").value = "sin-arroba"',
    intent: { mustInclude: [{ kind: 'added' }], ignore: IGN } },
  { id: 'f3', label: 'click interceptado por overlay', sel: '#f3', truthKey: 'f3',
    intent: { exists: 'Carrito: 1 items', ignore: IGN } },
  { id: 'f4', label: 'toast efímero (ya se fue)', sel: '#f4', truthKey: 'f4', settle: 900,
    intent: { exists: 'Borradores guardados: 1', ignore: IGN } },
  { id: 'f5', label: 'funciona pero fuera del viewport', sel: '#f5', truthKey: 'f5',
    intent: { mustInclude: [{ kind: 'added', name: 'fila agregada' }], ignore: IGN } },
  { id: 'f6', label: 'estado sin delta visual', sel: '#f6', truthKey: 'f6',
    intent: { mustInclude: [{ kind: 'state', name: 'Enviar' }], ignore: IGN } },
  { id: 'f7', label: 'doble efecto (insertó 2, no 1)', sel: '#f7', truthKey: 'f7',
    intent: { mustInclude: [{ kind: 'added' }], maxChanges: 2, ignore: IGN } },
  { id: 'f8', label: 'SPA a medio hidratar', sel: '#f8', truthKey: 'f8',
    intent: { urlIncludes: '/detalle/', exists: 'vista de detalle', ignore: IGN } },
]

const PAGE = await readFile(join(AGENT, 'demo-qa/silent-failures.html'), 'utf8')
await writeFile(join(TMP, 'app.html'), PAGE)
const PORT = 8396
const srv = createServer(async (req, res) => {
  // toda ruta sirve la app: F8 hace pushState a /detalle/42
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(await readFile(join(TMP, 'app.html'), 'utf8'))
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${PORT}/app.html`

// ── Canal 1: el oráculo (nuestro daemon) ─────────────────────────────────────────────
const daemon = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore' })
const cmd = (c, args = []) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true }),
}).then((r) => r.json()).catch((e) => ({ ok: false, text: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

// ── Canal 3: pixel-diff (mismo algoritmo perceptual que bench-qa) ────────────────────
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
const diffSrc = (await readFile(join(REPO, 'node_modules/@zumer/snapdiff/src/diff.js'), 'utf8')).replace(/^export /gm, '')
const pxBrowser = await chromium.launch()

// Click REAL por coordenadas: hace hit-testing, así que un overlay lo intercepta de
// verdad. `element.click()` programático lo atravesaría e invalidaría el caso F3.
const realClick = async (page, sel) => {
  // locator.click({force:true}) despacha un evento de mouse REAL en el centro del
  // elemento y auto-scrollea antes. `force` saltea los chequeos de accionabilidad de
  // Playwright, no el hit-testing del browser: si hay un overlay encima, el overlay
  // recibe el click (que es justo lo que F3 necesita).
  // mouse.click(box.x, box.y) NO servía: boundingBox da coordenadas de página y los
  // botones bajo el fold quedaban fuera del viewport, así que el click caía al vacío.
  const el = page.locator(sel)
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.click({ force: true, timeout: 5000 }).catch(() => {})
  return true
}

const rows = []

for (const c of CASES) {
  const settle = c.settle || 600

  // ── verdad independiente (juez): estado real, sin pasar por ningún canal ──────────
  const judgePage = await pxBrowser.newPage({ viewport: { width: 900, height: 700 } })
  await judgePage.goto(URL_)
  await judgePage.waitForTimeout(400)
  if (c.pre) await judgePage.evaluate(c.pre)
  await realClick(judgePage, c.sel)
  await judgePage.waitForTimeout(settle)
  const truth = await judgePage.evaluate((k) => window.__truth()[k], c.truthKey)
  // La verdad relevante para QA es si se cumplió la POSTCONDICIÓN pretendida.
  const reallyHappened = await judgePage.evaluate((k) => window.__intent()[k], c.truthKey)

  // ── canal pixel ──────────────────────────────────────────────────────────────────
  const pxPage = await pxBrowser.newPage({ viewport: { width: 900, height: 700 } })
  await pxPage.goto(URL_)
  await pxPage.waitForTimeout(400)
  if (c.pre) await pxPage.evaluate(c.pre)
  const before = await pxPage.screenshot()
  await realClick(pxPage, c.sel)
  await pxPage.waitForTimeout(settle)
  const after = await pxPage.screenshot()
  const px = await pxPage.evaluate(async ({ a, b, diffCode }) => {
    // misma invocación que el brazo pixel de bench-qa: diffPixels(da, db, out, w, h, {})
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

  // ── canal oráculo ────────────────────────────────────────────────────────────────
  await cmd('open', [URL_])
  if (c.pre) await cmd('eval' in {} ? 'eval' : 'find', []) // no-op: el pre se hace por click abajo
  // el pre (llenar el input) se aplica con el mismo mecanismo en ambos canales
  if (c.pre) await fetch('http://127.0.0.1:8377/cmd', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'find', args: ['Email'], envelope: true }),
  })
  const f = await cmd('find', [c.id === 'f2' ? 'Suscribirme' : c.id === 'f1' ? 'Actualizar datos'
    : c.id === 'f3' ? 'Comprar ahora' : c.id === 'f4' ? 'Guardar borrador'
      : c.id === 'f5' ? 'Agregar fila' : c.id === 'f6' ? 'Validar formulario'
        : c.id === 'f7' ? 'Agregar item' : 'Ver detalle'])
  const btnId = (f.text || '').match(/n_\w+/)?.[0]
  if (c.pre) {
    // llenar el email inválido por el mismo camino que usaría un agente
    const fe = await cmd('find', ['Email'])
    const inputId = (fe.text || '').match(/n_\w+/)?.[0]
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
  // tiene `ignore` exactamente para eso. Se mide con y sin remedio, igual que
  // agent-browser se mide as-is y normalizado.

  // ── canal agent-browser ──────────────────────────────────────────────────────────
  await ab(['open', URL_])
  await sleep(400)
  if (c.pre) await ab(['eval', 'document.getElementById("f2-email").value = "sin-arroba"'])
  const abBefore = await ab(['snapshot'])
  const bFile = join(TMP, `${c.id}.before.txt`)
  await writeFile(bFile, abBefore)
  await ab(['click', c.sel])   // su click real, no eval: misma vara que los demás
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
  console.log(`${c.id} ${c.label.padEnd(32)} verdad=${String(reallyHappened).padEnd(5)} oráculo=${String(oracleChanged).padEnd(5)} assert=${String(intentPass).padEnd(5)} ab-asis=${String(abAsIs).padEnd(5)} ab-strip=${String(abStripped).padEnd(5)} pixel=${(px.ratio * 100).toFixed(3)}%`)
}

await new Promise((r) => { const s = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* ya murió */ }
await pxBrowser.close()
srv.close()

// ── Métrica: false green / false red ─────────────────────────────────────────────────
const tally = (key) => {
  const fg = rows.filter((r) => !r.truth && r[key] === true).length     // dice que sí, no pasó
  const fr = rows.filter((r) => r.truth && r[key] === false).length     // dice que no, sí pasó
  return { fg, fr, ok: rows.filter((r) => r[key] === r.truth).length }
}
const o = tally('oracle'), oi = tally('intentPass'), a1 = tally('abAsIs'), a2 = tally('abStripped'), p = tally('pixel')
console.log('\n| canal | aciertos | FALSE GREEN | false red |')
console.log('|---|---:|---:|---:|')
console.log(`| Oráculo (look crudo) | ${o.ok}/${rows.length} | **${o.fg}** | ${o.fr} |`)
console.log(`| **Oráculo: assert de la postcondición** | **${oi.ok}/${rows.length}** | **${oi.fg}** | ${oi.fr} |`)
console.log(`| agent-browser as-is | ${a1.ok}/${rows.length} | **${a1.fg}** | ${a1.fr} |`)
console.log(`| agent-browser sin refs | ${a2.ok}/${rows.length} | **${a2.fg}** | ${a2.fr} |`)
console.log(`| Screenshot (pixel-diff) | ${p.ok}/${rows.length} | **${p.fg}** | ${p.fr} |`)

await writeFile(join(AGENT, 'experiment/results/c-false-green.json'), JSON.stringify({ rows, tally: { oracle: o, intentAssert: oi, abAsIs: a1, abStripped: a2, pixel: p } }, null, 2) + '\n')
console.log('\n→ experiment/results/c-false-green.json')
