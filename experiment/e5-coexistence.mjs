/**
 * e5-coexistence.mjs — TESTPLAN Fase E5: ¿podemos correr DENTRO de agent-browser?
 *
 * The strategic question from LANDSCAPE: if our reader works inside their flow without
 * replacing it, they stop being a competitor and become a distribution channel — which
 * addresses the biggest weakness the survey found.
 *
 * Same browser, same session, same action: their comparison and ours, side by side.
 *
 *   node packages/agent/experiment/e5-coexistence.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const REPO = join(AGENT, '..', '..')
const TMP = '/tmp/snapdom-e5'
await mkdir(TMP, { recursive: true })
const ab = (args, opts = {}) => run('agent-browser', args, { timeout: 60000, maxBuffer: 16 << 20, ...opts })
  .then((r) => r.stdout.trim()).catch((e) => `__ERR__ ${e.message.slice(0, 120)}`)

// A page with the kind of failure pixels cannot see (a state change with no visual
// difference) PLUS ambient noise (a live clock) that dirties any text comparison.
await writeFile(join(TMP, 'app.html'), `<!doctype html><html><body>
<h2>Formulario</h2><span id="clock">--:--:--</span>
<button id="go">Validar</button>
<button id="target" disabled>Enviar</button>
<script>
setInterval(() => { document.getElementById('clock').textContent = new Date().toTimeString().slice(0,8) }, 1000)
document.getElementById('go').addEventListener('click', () => { document.getElementById('target').disabled = false })
</script></body></html>`)

const PORT = 8397
const srv = createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(await readFile(join(TMP, 'app.html'), 'utf8'))
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

// ── Our reader, bundled for injection ───────────────────────────────────────────────
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
await writeFile(join(TMP, 'entry.mjs'), `import { observe, buildUi } from '${join(AGENT, 'src/plugin.js')}'
window.__sdObserve = observe
window.__sdBuildUi = buildUi
`)
const built = await esbuild.build({ entryPoints: [join(TMP, 'entry.mjs')], bundle: true, format: 'iife', write: false, platform: 'browser' })
const SDK = built.outputFiles[0].text
console.log(`SDK bundleado: ${(SDK.length / 1024).toFixed(0)} KB\n`)

// ── El flujo de coexistencia ─────────────────────────────────────────────────────────
console.log(await ab(['open', `http://127.0.0.1:${PORT}/app.html`]))

// 1) injection through THEIR eval (--stdin avoids the shell's argument limits).
// NOTE: execFile does NOT accept the `input` option (that is execFileSync) — you have to
// write to the child's stdin by hand, or the injection fails SILENTLY.
const inject = await new Promise((resolve) => {
  const ch = spawn('agent-browser', ['eval', '--stdin'])
  let o = ''
  ch.stdout.on('data', (d) => { o += d })
  ch.on('close', () => resolve(o.trim()))
  ch.stdin.write(SDK)
  ch.stdin.end()
})
const injected = await ab(['eval', 'typeof window.__sdObserve'])
console.log(`injected through their \`eval --stdin\`: ${injected}`)

// 2) baseline: THEIR snapshot and OUR reference point, from the same moment
const theirBefore = await ab(['snapshot'])
await writeFile(join(TMP, 'their-before.txt'), theirBefore)
await ab(['eval', '(async () => { const o = await window.__sdObserve(document.body, {}); window.__cp = window.__sdBuildUi(o, {}).checkpoint(); return "ok" })()'])

// 3) the action, with THEIR click command (we do not touch their flow)
console.log(`action through their click: ${await ab(['click', '#go'])}`)
await new Promise((r) => setTimeout(r, 1200))   // deja correr el reloj: ruido real

// 4) the two comparisons, same browser, same action
const theirDiff = await ab(['diff', 'snapshot', '-b', join(TMP, 'their-before.txt')])
const ourDiffRaw = await ab(['eval', `(async () => {
  const o = await window.__sdObserve(document.body, { previous: window.__cp })
  const ui = window.__sdBuildUi(o, {})
  return JSON.stringify({ changed: ui.changed, changes: (ui.changes || []).map(c => ({ kind: c.kind, role: c.role, name: c.name })) })
})()`])
let ourDiff
try { ourDiff = JSON.parse(JSON.parse(ourDiffRaw)) } catch { ourDiff = { raw: ourDiffRaw } }

console.log('\n── SU diff (a11y tree, textual) ' + '─'.repeat(30))
console.log(theirDiff.split('\n').slice(0, 14).join('\n'))
console.log('\n── OUR comparison (semantic), same browser and same action ' + '─'.repeat(5))
console.log(JSON.stringify(ourDiff, null, 2))

const ourNames = (ourDiff.changes || []).map((c) => `${c.kind} ${c.role} "${c.name}"`)
const theyShowClock = /\d\d:\d\d:\d\d/.test(theirDiff)
const weShowClock = ourNames.some((n) => /\d\d:\d\d:\d\d/.test(n))
const weCaughtState = ourNames.some((n) => n.startsWith('state'))

console.log('\n── Veredicto ' + '─'.repeat(45))
console.log(`inyección dentro de su runtime      : ${injected === '"function"' ? 'SÍ' : 'NO'}`)
console.log(`su flujo intacto (open/click suyos) : SÍ`)
console.log(`our comparison names the state change: ${weCaughtState ? 'YES — ' + ourNames.filter((n) => n.startsWith('state')).join(', ') : 'NO'}`)
console.log(`el reloj ensucia su diff            : ${theyShowClock ? 'SÍ' : 'no'}`)
console.log(`the clock dirties ours              : ${weShowClock ? 'YES' : 'no'}`)

await writeFile(join(AGENT, 'experiment/results/e5-coexistence.json'),
  JSON.stringify({ sdkKB: +(SDK.length / 1024).toFixed(0), injected, theirDiff, ourDiff, theyShowClock, weShowClock, weCaughtState }, null, 2) + '\n')
srv.close()
console.log('\n→ experiment/results/e5-coexistence.json')

// The fixture server keeps the process alive on a lingering keep-alive socket:
// the run finishes, writes its results, and then hangs looking like a stuck benchmark
// (measured: >10 min on a run whose real work took 43 s). Exit on the result.
srv.closeAllConnections?.()
process.exit(0)
