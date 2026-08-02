/**
 * e1-agent-browser.mjs — TESTPLAN Fase E1: `vercel-labs/agent-browser` como cuarto
 * deterministic arm, over the SAME 19 fixtures with hand-written truth already used by
 * our reader, the pixel comparison and the accessibility-tree diff in `bench-qa.mjs`.
 *
 * It is the most comparable public tool and we had never run it: until now
 * solo lo teníamos fichado a nivel documental en docs/LANDSCAPE.md.
 *
 *   npm install -g agent-browser   (tested with 0.33.1)
 *   node packages/agent/experiment/e1-agent-browser.mjs
 *
 * FAIRNESS (a TESTPLAN rule: a benchmark won by cheating does not even convince us).
 * Two variants are reported:
 *
 *   as-is       — what their `diff snapshot -b <file>` prints, untouched.
 *                 Es la vía explícita y documentada de su --help.
 *   ref-stripped— the same diff with ` ref=eN` removed from both sides before
 *                 comparing. Their references are RENUMBERED on every snapshot
 *                 (measured: a fully static page diffs as "3 additions, 3 removals"), so
 *                 sin esta normalización el ruido de refs domina todo. Un consumidor
 *                 any reasonable caller would post-process this; reporting only as-is
 *                 would be unfair.
 *
 * Before writing this, the configuration alternatives were exhausted: an in-session
 * in-session sin -b (peor: "4 additions, 0 unchanged" en página estática),
 * `--compact` (references still change), and there is no flag to omit references.
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

// ── Fixtures: identical to bench-qa (same setup as test/corpus.test.js) ─────────────
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
async function buildFixture(name) {
  const page = await readFile(join(CORPUS, name, 'page.html'), 'utf8')
  const out = await esbuild.build({
    entryPoints: [join(CORPUS, name, 'mutate.js')],
    bundle: true, format: 'iife', globalName: '__mutateMod', write: false, platform: 'browser',
  })
  // MANUAL mode: the arm controls before and after, like the other arms
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
// minimal line diff: are the sets of lines different?
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

  // fire the mutation through their own `eval` and wait for it to settle
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
console.log('\nReference (bench-qa.md, same fixtures): this tool 19/19 · 0/8 false alarms · 0/11 missed ·')
console.log('pixel-diff 13/19 · 5/8 FP · 1/11 · a11y-tree 16/19 · 2/8 FP · 1/11')

await writeFile(join(AGENT, 'experiment/results/e1-agent-browser.json'), JSON.stringify({ rows, asIs: a, stripped: s }, null, 2) + '\n')
console.log('\n→ experiment/results/e1-agent-browser.json')

// The fixture server keeps the process alive on a lingering keep-alive socket:
// the run finishes, writes its results, and then hangs looking like a stuck benchmark
// (measured: >10 min on a run whose real work took 43 s). Exit on the result.
srv.closeAllConnections?.()
process.exit(0)
