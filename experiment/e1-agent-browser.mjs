/**
 * e1-agent-browser.mjs — TESTPLAN Fase E1: `vercel-labs/agent-browser` como cuarto
 * brazo determinista, sobre las MISMAS 19 fixtures con truth escrita a mano que ya
 * usan el oráculo, pixel-diff y a11y-diff en `bench-qa.mjs`.
 *
 * Es el rival más comparable que existe y nunca lo habíamos corrido: hasta ahora
 * solo lo teníamos fichado a nivel documental en docs/LANDSCAPE.md.
 *
 *   npm install -g agent-browser   (probado con 0.33.1)
 *   node packages/agent/experiment/e1-agent-browser.mjs
 *
 * JUSTICIA (regla del TESTPLAN: un benchmark que se gana haciendo trampa no sirve
 * ni para convencernos a nosotros). Se reportan DOS variantes:
 *
 *   as-is       — lo que su `diff snapshot -b <archivo>` imprime, sin tocar nada.
 *                 Es la vía explícita y documentada de su --help.
 *   ref-stripped— el mismo diff pero borrando ` ref=eN` de ambos lados antes de
 *                 comparar. Sus refs se RENUMERAN en cada snapshot (medido: una
 *                 página 100% estática diffea "3 additions, 3 removals"), así que
 *                 sin esta normalización el ruido de refs domina todo. Un consumidor
 *                 razonable haría este post-proceso; medir solo as-is sería injusto.
 *
 * Antes de escribir esto se agotaron las alternativas de configuración: flujo
 * in-session sin -b (peor: "4 additions, 0 unchanged" en página estática),
 * `--compact` (los refs igual cambian) y no existe flag para omitir refs.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const REPO = join(AGENT, '..', '..')
const CORPUS = join(AGENT, 'corpus')
const TMP = '/tmp/snapdom-e1'
await mkdir(TMP, { recursive: true })

const ab = (args) => run('agent-browser', args, { timeout: 120000, maxBuffer: 8 << 20 })
  .then((r) => r.stdout).catch((e) => `__ERR__ ${e.message}`)

// ── Fixtures: idénticas a bench-qa (mismo montaje que test/corpus.test.js) ───────────
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
async function buildFixture(name) {
  const page = await readFile(join(CORPUS, name, 'page.html'), 'utf8')
  const out = await esbuild.build({
    entryPoints: [join(CORPUS, name, 'mutate.js')],
    bundle: true, format: 'iife', globalName: '__mutateMod', write: false, platform: 'browser',
  })
  // modo MANUAL: el brazo controla el antes/después, igual que los brazos
  // competidores de bench-qa (window.__runMutation)
  const html = `<!doctype html><html><body>
<script>
const container = document.createElement('div')
container.style.cssText = 'width:900px;position:relative'
container.innerHTML = ${JSON.stringify(page).replace(/<\/script/gi, '<\\/script')}
document.body.appendChild(container)
${out.outputFiles[0].text}
const __frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
window.__runMutation = async () => {
  try { await __mutateMod.default(container, { frame: __frame }); window.__mutated = true }
  catch (e) { window.__mutateErr = String(e) }
}
</script></body></html>`
  await writeFile(join(TMP, `${name}.html`), html)
}

const PORT = 8393
const srv = createServer(async (req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '')
  let body = null
  try { body = await readFile(join(TMP, name), 'utf8') } catch { /* 404 */ }
  if (body === null) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(body)
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

// ── Comparación ──────────────────────────────────────────────────────────────────────
const stripRefs = (s) => s.replace(/\s*\[?ref=e\d+\]?/g, '').replace(/,\s*\]/g, ']').trimEnd()
// diff de líneas mínimo: ¿son distintos los conjuntos de líneas?
const lineDiffers = (a, b) => {
  const norm = (s) => s.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const A = norm(a), B = norm(b)
  if (A.length !== B.length) return true
  return A.some((l, i) => l !== B[i])
}

const names = (await readdir(CORPUS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const rows = []

for (const name of names) {
  await buildFixture(name)
  const url = `http://127.0.0.1:${PORT}/${name}.html`
  const expected = JSON.parse(await readFile(join(CORPUS, name, 'expected.json'), 'utf8'))

  await ab(['open', url])
  await new Promise((r) => setTimeout(r, 600))
  const before = await ab(['snapshot'])
  const beforeFile = join(TMP, `${name}.before.txt`)
  await writeFile(beforeFile, before)

  // dispara la mutación por su propio `eval` y espera a que asiente
  await ab(['eval', 'window.__runMutation()'])
  await new Promise((r) => setTimeout(r, 1200))

  // (1) su salida tal cual, vía la ruta documentada
  const diffOut = await ab(['diff', 'snapshot', '-b', beforeFile])
  const m = diffOut.match(/(\d+) additions?, (\d+) removals?/)
  const asIs = m ? (Number(m[1]) > 0 || Number(m[2]) > 0) : /__ERR__/.test(diffOut) ? null : false

  // (2) normalizado sin refs — el post-proceso caritativo
  const after = await ab(['snapshot'])
  const stripped = lineDiffers(stripRefs(before), stripRefs(after))

  rows.push({ name, truth: expected.changed, asIs, stripped, evidence: diffOut.length })
  console.log(`${name.padEnd(26)} truth=${String(expected.changed).padEnd(5)} as-is=${String(asIs).padEnd(5)} ref-stripped=${stripped}`)
}

srv.close()

// ── Reporte ──────────────────────────────────────────────────────────────────────────
const score = (key) => {
  const ok = rows.filter((r) => r[key] === r.truth).length
  const fp = rows.filter((r) => !r.truth && r[key] === true).length
  const miss = rows.filter((r) => r.truth && r[key] === false).length
  return { ok, fp, miss, noise: rows.filter((r) => !r.truth).length, real: rows.filter((r) => r.truth).length }
}
const a = score('asIs'), s = score('stripped')
console.log('\n| brazo | correctos | falsos positivos (ruido) | cambios perdidos |')
console.log('|---|---:|---:|---:|')
console.log(`| agent-browser \`diff snapshot\` (as-is) | ${a.ok}/${rows.length} | ${a.fp}/${a.noise} | ${a.miss}/${a.real} |`)
console.log(`| agent-browser + normalización sin refs | ${s.ok}/${rows.length} | ${s.fp}/${s.noise} | ${s.miss}/${s.real} |`)
console.log('\nReferencia (bench-qa.md, mismas fixtures): oráculo 19/19 · 0/8 FP · 0/11 perdidos ·')
console.log('pixel-diff 13/19 · 5/8 FP · 1/11 · a11y-tree 16/19 · 2/8 FP · 1/11')

await writeFile(join(AGENT, 'experiment/results/e1-agent-browser.json'), JSON.stringify({ rows, asIs: a, stripped: s }, null, 2) + '\n')
console.log('\n→ experiment/results/e1-agent-browser.json')

// The fixture server keeps the process alive on a lingering keep-alive socket:
// the run finishes, writes its results, and then hangs looking like a stuck benchmark
// (measured: >10 min on a run whose real work took 43 s). Exit on the result.
srv.closeAllConnections?.()
process.exit(0)
