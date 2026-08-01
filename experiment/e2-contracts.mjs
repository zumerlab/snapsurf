/**
 * e2-contracts.mjs — TESTPLAN Fase E2: los tres contratos donde AFIRMAMOS ventaja,
 * puestos a prueba contra `vercel-labs/agent-browser` con la misma página.
 *
 *   C1 oclusión  — ¿avisa que el elemento quedó tapado ANTES de que le hagas click?
 *                  (nosotros: proactivo en el mapa · ellos, según su doc: error
 *                  reactivo post-click)
 *   C2 identidad — ¿sobreviven sus refs @eN a un remount de React o a una lista
 *                  reordenada? Ellos documentan que NO son estables; nosotros
 *                  medimos los n_xxx deterministas para el mismo DOM. Se verifican
 *                  LAS DOS mitades: la suya y la nuestra.
 *   C3 SPA       — qué reporta cada uno tras una navegación blanda.
 *
 *   node packages/agent/experiment/e2-contracts.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const REPO = join(AGENT, '..', '..')
const TMP = '/tmp/snapdom-e2'
await mkdir(TMP, { recursive: true })
const ab = (args) => run('agent-browser', args, { timeout: 60000, maxBuffer: 8 << 20 })
  .then((r) => r.stdout).catch((e) => `__ERR__ ${e.message}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Páginas de prueba ────────────────────────────────────────────────────────────────
const PAGES = {
  // C1: un botón real que a los 1200ms queda tapado por un banner de cookies
  occlusion: `<!doctype html><html><body style="margin:0">
<button id="buy" style="position:absolute;top:120px;left:60px;width:220px;height:44px">Comprar ahora</button>
<script>setTimeout(() => {
  const o = document.createElement('div')
  o.setAttribute('role','dialog'); o.setAttribute('aria-label','Banner de cookies')
  o.style.cssText = 'position:absolute;top:100px;left:40px;width:320px;height:90px;background:#eee;border:2px solid #333;z-index:9'
  o.textContent = 'Usamos cookies. Aceptar / Rechazar'
  document.body.appendChild(o)
}, 1200)</script></body></html>`,

  // C2a: remount — el MISMO botón, destruido y recreado idéntico (lo que hace React)
  remount: `<!doctype html><html><body>
<div id="host"><button id="save">Guardar</button><button>Cancelar</button></div>
<script>setTimeout(() => {
  const host = document.getElementById('host')
  const html = host.innerHTML
  host.innerHTML = ''            // destruye
  host.innerHTML = html          // recrea idéntico
}, 1200)</script></body></html>`,

  // C2b: lista reordenada — los mismos items, distinto orden
  reorder: `<!doctype html><html><body>
<ul id="list"><li><a href="/a">Alfa</a></li><li><a href="/b">Beta</a></li><li><a href="/c">Gamma</a></li></ul>
<script>setTimeout(() => {
  const l = document.getElementById('list')
  l.insertBefore(l.children[2], l.children[0])   // Gamma pasa al frente
}, 1200)</script></body></html>`,

  // C3: navegación SPA
  spa: `<!doctype html><html><body>
<h1>Listado</h1><div id="c"><p>items del listado</p></div>
<script>setTimeout(() => {
  history.pushState({}, '', '/detalle/7')
  document.getElementById('c').innerHTML = '<p>vista de detalle</p>'
}, 1200)</script></body></html>`,
}

const PORT = 8394
for (const [k, v] of Object.entries(PAGES)) await writeFile(join(TMP, `${k}.html`), v)
const srv = createServer(async (req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '')
  let body = null
  try { body = await readFile(join(TMP, name), 'utf8') } catch { /* 404 */ }
  if (body === null) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(body)
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const url = (k) => `http://127.0.0.1:${PORT}/${k}.html`

// ── Nuestro lado: daemon propio ──────────────────────────────────────────────────────
const daemon = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore' })
const cmd = (c, args = []) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true }),
}).then((r) => r.json()).catch((e) => ({ ok: false, text: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const out = []
const record = (contract, ours, theirs, verdict) => {
  out.push({ contract, ours, theirs, verdict })
  console.log(`\n■ ${contract}\n   nosotros : ${ours}\n   ellos    : ${theirs}\n   → ${verdict}`)
}

// ── C1 · Oclusión ────────────────────────────────────────────────────────────────────
await cmd('open', [url('occlusion')])
await sleep(1800)
const look = await cmd('look')
const oursOcc = /became covered/.test(look.text || '')
  ? `becameCovered reportado: ${(look.text.match(/became covered: (.+)/) || [])[1]}`
  : 'NO reportó oclusión'

await ab(['open', url('occlusion')])
const abBefore = await ab(['snapshot'])
await sleep(1800)
const abAfter = await ab(['snapshot'])
// ¿su snapshot dice de alguna forma que el botón quedó tapado/no clickeable?
const mentionsCovered = /covered|obscured|hidden|intercept|occlud/i.test(abAfter)
const stillListsButton = /Comprar ahora/.test(abAfter)
const theirsOcc = mentionsCovered
  ? 'su snapshot marca el elemento como tapado'
  : `sin señal de oclusión (el botón sigue listado como accionable: ${stillListsButton})`
// y el click: ¿avisa o lo intenta igual?
const abClick = await ab(['click', 'button'])
const theirsClick = /__ERR__|error|intercept|not clickable/i.test(abClick)
  ? `su click FALLA reactivamente: ${abClick.slice(0, 90).replace(/\n/g, ' ')}`
  : `su click no se queja: ${abClick.slice(0, 60).replace(/\n/g, ' ')}`
record('C1 oclusión (¿aviso ANTES del click?)', oursOcc, `${theirsOcc} · ${theirsClick}`,
  oursOcc.startsWith('becameCovered') && !mentionsCovered
    ? 'VENTAJA NUESTRA confirmada: proactivo vs sin señal previa'
    : 'revisar — el resultado no confirma la afirmación')

// ── C2 · Identidad ante remount y reorder ────────────────────────────────────────────
for (const [page, label] of [['remount', 'remount (nodo destruido y recreado idéntico)'], ['reorder', 'lista reordenada']]) {
  await cmd('open', [url(page)])
  const f1 = await cmd('find', [page === 'remount' ? 'Guardar' : 'Gamma'])
  const id1 = (f1.text || '').match(/n_\w+/)?.[0]
  await sleep(1800)
  await cmd('look')
  const f2 = await cmd('find', [page === 'remount' ? 'Guardar' : 'Gamma'])
  const id2 = (f2.text || '').match(/n_\w+/)?.[0]
  const oursStable = id1 && id2 && id1 === id2

  await ab(['open', url(page)])
  const s1 = await ab(['snapshot'])
  const ref1 = s1.match(new RegExp(`${page === 'remount' ? 'Guardar' : 'Gamma'}[^\\n]*ref=(e\\d+)`))?.[1]
  await sleep(1800)
  const s2 = await ab(['snapshot'])
  const ref2 = s2.match(new RegExp(`${page === 'remount' ? 'Guardar' : 'Gamma'}[^\\n]*ref=(e\\d+)`))?.[1]
  const theirsStable = ref1 && ref2 && ref1 === ref2

  record(`C2 identidad · ${label}`,
    `n_xxx ${id1} → ${id2} · ${oursStable ? 'ESTABLE' : 'cambió'}`,
    `@ref ${ref1} → ${ref2} · ${theirsStable ? 'ESTABLE' : 'cambió'}`,
    oursStable && !theirsStable ? 'VENTAJA NUESTRA confirmada'
      : oursStable && theirsStable ? 'empate: ambos estables'
        : !oursStable && !theirsStable ? 'ninguno estable — nuestra afirmación NO se sostiene acá'
          : 'ELLOS estables y nosotros no — hallazgo en contra')
}

// ── C3 · SPA ─────────────────────────────────────────────────────────────────────────
await cmd('open', [url('spa')])
await sleep(1800)
const spaLook = await cmd('look')
const oursSpa = (spaLook.meta && spaLook.meta.navigated)
  ? `navigated:true + baselineUrl (${spaLook.meta.baselineUrl || '?'})`
  : 'no señaló la navegación blanda'

await ab(['open', url('spa')])
const spaBefore = await ab(['snapshot'])
await writeFile(join(TMP, 'spa-before.txt'), spaBefore)
await sleep(1800)
const spaDiff = await ab(['diff', 'snapshot', '-b', join(TMP, 'spa-before.txt')])
const theirsSpa = /url|navigat|route/i.test(spaDiff)
  ? 'su diff menciona el cambio de URL'
  : 'su diff muestra el cambio de contenido pero NO señala que la URL cambió'
record('C3 navegación SPA', oursSpa, theirsSpa,
  oursSpa.startsWith('navigated:true') ? 'VENTAJA NUESTRA: el cruce de página es explícito' : 'revisar')

// ── Cierre ───────────────────────────────────────────────────────────────────────────
await new Promise((r) => { const s = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* ya murió */ }
srv.close()
await writeFile(join(AGENT, 'experiment/results/e2-contracts.json'), JSON.stringify(out, null, 2) + '\n')
console.log('\n→ experiment/results/e2-contracts.json')

// The fixture server keeps the process alive on a lingering keep-alive socket:
// the run finishes, writes its results, and then hangs looking like a stuck benchmark
// (measured: >10 min on a run whose real work took 43 s). Exit on the result.
srv.closeAllConnections?.()
process.exit(0)
