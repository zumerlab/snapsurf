/**
 * abis-verbs.mjs — TESTPLAN Fase A-bis: smoke de los verbos con cobertura CERO.
 *
 * Verificado antes de escribir esto: `rec` y `parent` no aparecen en ningún test,
 * gate ni benchmark; `snap`, `cp` y `map` solo figuran en mcp/server.mjs, que es la
 * implementación y no una prueba. Son features que estamos ofreciendo a consumidores
 * sin saber si funcionan en el bundle actual.
 *
 *   node packages/agent/experiment/abis-verbs.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir, stat, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
// `--daemon <path>`: run the same smoke against ANOTHER install of the daemon. The
// global install (~/.claude/snapdom-agent) was never exercised by any gate, and that
// is exactly where the sdk.js bundle went stale and broke find/text/assert.
const dArg = process.argv.indexOf('--daemon')
const BROWSE = dArg > -1 && process.argv[dArg + 1] ? process.argv[dArg + 1] : join(AGENT, 'tools/browse.mjs')
const TAG = dArg > -1 ? 'global' : 'repo'
const TMP = '/tmp/snapdom-abis'
await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Página con: una card con ≥2 actionables (para `parent`), muchos actionables (para
// `map`), un elemento animado (para `rec`) y una región concreta (para `snap`).
const PAGE = `<!doctype html><html><body style="font-family:system-ui">
<div id="card" style="border:1px solid #ccc;padding:12px;width:300px">
  <h3 id="title">Producto destacado</h3>
  <span id="price">$ 1.234</span>
  <a href="/detalle/9">Ver detalle</a>
  <button id="buy">Comprar</button>
</div>
<div id="anim" style="width:80px;height:80px;background:#4a7dff;animation:mv 1s linear infinite"></div>
<style>@keyframes mv { from { transform: translateX(0) } to { transform: translateX(200px) } }</style>
<div id="many"></div>
<script>
const m = document.getElementById('many')
for (let i = 0; i < 60; i++) {
  const b = document.createElement('button'); b.textContent = 'accion ' + i; m.appendChild(b)
}
</script></body></html>`
await writeFile(join(TMP, 'page.html'), PAGE)

const PORT = 8395
const srv = createServer(async (req, res) => {
  const n = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '')
  let body = null
  try { body = await readFile(join(TMP, n), 'utf8') } catch { /* 404 */ }
  if (body === null) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(body)
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${PORT}/page.html`

console.log(`daemon under test: ${BROWSE}`)
const daemon = spawn(process.execPath, [BROWSE, 'serve'], { stdio: 'ignore' })
const cmd = (c, args = []) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true }),
}).then((r) => r.json()).catch((e) => ({ ok: false, text: String(e), error: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const results = []
const check = (verb, name, pass, detail = '') => {
  results.push({ verb, name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} [${verb}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const sizeOf = async (p) => { try { return (await stat(p)).size } catch { return 0 } }

await cmd('open', [URL_])

// ── parent ───────────────────────────────────────────────────────────────────────────
const fPrice = await cmd('find', ['1.234'])
const priceId = (fPrice.text || '').match(/n_\w+/)?.[0]
check('parent', 'find localiza el precio dentro de la card', !!priceId, priceId || fPrice.text?.slice(0, 60))
if (priceId) {
  const par = await cmd('parent', [priceId])
  const t = par.text || ''
  // debe subir a un contenedor con >=2 actionables: tiene que ver el link Y el botón
  const climbed = /Ver detalle/.test(t) && /Comprar/.test(t)
  check('parent', 'sube a la card con ≥2 actionables (ve link y botón)', climbed, climbed ? 'ok' : t.slice(0, 100).replace(/\n/g, ' '))
}

// ── map (paginación) ─────────────────────────────────────────────────────────────────
const m0 = await cmd('map', ['0'])
const m40 = await cmd('map', ['40'])
const ids = (s) => [...new Set([...(s || '').matchAll(/n_\w+/g)].map((x) => x[0]))]
const p0 = ids(m0.text), p40 = ids(m40.text)
check('map', 'la primera página devuelve entradas', p0.length > 0, `${p0.length} ids`)
check('map', 'el offset devuelve entradas distintas', p40.length > 0 && p40.some((i) => !p0.includes(i)), `${p40.length} ids, ${p40.filter((i) => !p0.includes(i)).length} nuevos`)
const dup = p0.filter((i) => p40.includes(i))
check('map', 'no duplica entre páginas', dup.length === 0, dup.length ? `${dup.length} repetidos` : 'sin solapamiento')

// ── snap (píxeles de una región) ─────────────────────────────────────────────────────
const cardFind = await cmd('find', ['Producto destacado'])
const cardId = (cardFind.text || '').match(/n_\w+/)?.[0]
const snapPath = join(TMP, 'card.png')
const snapRes = await cmd('snap', [cardId || 'n_1r1', snapPath])
const snapSize = await sizeOf(snapPath)
check('snap', 'genera un archivo de imagen no vacío', snapSize > 1000, `${snapSize} bytes · ${(snapRes.text || '').slice(0, 60)}`)

// ── cp (checkpoints con nombre) ──────────────────────────────────────────────────────
const cpSave = await cmd('cp', ['save', 'base'])
check('cp', 'save crea un checkpoint con nombre', !!cpSave.ok && !/error/i.test(cpSave.text || ''), (cpSave.text || '').slice(0, 60))
const cpList = await cmd('cp', ['list'])
check('cp', 'list muestra el checkpoint guardado', /base/.test(cpList.text || ''), (cpList.text || '').slice(0, 60))
// mutar la página y comprobar que el diff contra el checkpoint lo ve
await cmd('click', ['n_1r1'])
await fetch(`http://127.0.0.1:8377/cmd`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'find', args: ['Comprar'], envelope: true }),
})
const cpDiff = await cmd('cp', ['diff', 'base'])
check('cp', 'diff contra el checkpoint responde sin error', !!cpDiff.ok, (cpDiff.text || '').slice(0, 80).replace(/\n/g, ' '))

// ── rec (grabación) ──────────────────────────────────────────────────────────────────
for (const [file, label] of [['clip.gif', 'GIF'], ['clip.mp4', 'MP4']]) {
  const p = join(TMP, file)
  const t0 = Date.now()
  const r = await cmd('rec', ['2', '', p])
  const ms = Date.now() - t0
  const sz = await sizeOf(p)
  check('rec', `graba ${label} del body (2s)`, sz > 1000, `${sz} bytes en ${ms}ms · ${(r.text || r.error || '').slice(0, 70).replace(/\n/g, ' ')}`)
}
// scopeado a un elemento — re-find inmediato: los ids expiran por observación
const freshFind = await cmd('find', ['Producto destacado'])
const freshId = (freshFind.text || '').match(/n_\w+/)?.[0]
if (freshId) {
  const p = join(TMP, 'card.gif')
  const r = await cmd('rec', ['2', freshId, p])
  const sz = await sizeOf(p)
  check('rec', 'graba scopeado a UN elemento', sz > 500, `${sz} bytes · ${(r.text || r.error || '').slice(0, 70).replace(/\n/g, ' ')}`)
}
// caso documentado: una navegación aborta la grabación (el elemento muere con el documento)
await writeFile(join(TMP, 'other.html'), '<!doctype html><html><body><h1>otra pagina</h1></body></html>')
const navAbort = await Promise.all([
  cmd('rec', ['4', '', join(TMP, 'aborted.gif')]),
  (async () => { await sleep(800); return cmd('open', [`http://127.0.0.1:${PORT}/other.html`]) })(),
])
const abortMsg = (navAbort[0].text || navAbort[0].error || '')
const abortedSize = await sizeOf(join(TMP, 'aborted.gif'))
check('rec', 'una navegación durante la grabación NO rompe el daemon', !!(await cmd('status')).ok,
  `archivo: ${abortedSize} bytes · mensaje: ${abortMsg.slice(0, 60).replace(/\n/g, ' ')}`)

// ── text / redact: los verbos que dependen de window.__agentRedact ───────────────────
// Un bundle sin `redactString` deja `__agentRedact` undefined y estos tiran
// "is not a function" DENTRO de la página: el daemon arranca, `open` funciona, y solo
// se rompen find/text/assert. Es el fallo mudo que rompió el install global.
await cmd('open', [URL_])
const fTitle = await cmd('find', ['Producto destacado'])
check('find', 'find responde sin excepción en la página', !!fTitle.ok && /n_\w+/.test(fTitle.text || ''),
  (fTitle.text || fTitle.error || '').slice(0, 70).replace(/\n/g, ' '))
const titleId = (fTitle.text || '').match(/n_\w+/)?.[0]
if (titleId) {
  const t = await cmd('text', [titleId])
  check('text', 'text devuelve el texto del nodo', !!t.ok && /Producto/.test(t.text || ''),
    (t.text || t.error || '').slice(0, 70).replace(/\n/g, ' '))
}
const setRules = await cmd('redact', ['Producto destacado'])
check('redact', 'las reglas se aceptan en runtime', !!setRules.ok, (setRules.text || setRules.error || '').slice(0, 60))
const redacted = await cmd('open', [URL_])
const leaks = /Producto destacado/.test(redacted.text || '')
check('redact', 'el término no aparece en el digest', !!redacted.ok && !leaks,
  leaks ? 'FUGA: el término salió literal' : 'sin fuga')
check('redact', '[redacted] visible (no descarte silencioso)', /\[redacted\]/.test(redacted.text || ''),
  (redacted.text || '').includes('[redacted]') ? 'placeholder presente' : 'no aparece el placeholder')
const probe = await cmd('assert', [JSON.stringify({ exists: 'Producto destacado' })])
check('redact', 'probing de un término oculto falla fuerte', /blocked by privacy rule/.test(probe.text || ''),
  (probe.text || '').split('\n')[1]?.slice(0, 70) || '')
await cmd('redact', ['off'])

// ── cierre ───────────────────────────────────────────────────────────────────────────
await new Promise((r) => { const s = spawn(process.execPath, [BROWSE, 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* ya murió */ }
srv.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks OK`)
if (failed.length) console.log('FALLAN: ' + failed.map((f) => `[${f.verb}] ${f.name}`).join(' · '))
await writeFile(join(AGENT, `experiment/results/abis-verbs${TAG === 'repo' ? '' : '-' + TAG}.json`), JSON.stringify(results, null, 2) + '\n')
process.exit(failed.length ? 1 : 0)
