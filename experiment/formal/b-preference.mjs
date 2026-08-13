/**
 * b-preference.mjs — TESTPLAN phase B: what the model REVEALS it prefers.
 *
 * The question: does the model itself prefer this tool over its usual ones? And above
 * all: FOR WHAT KIND OF TASK?
 *
 * The bias to avoid: the `agent-browse` skill TELLS Claude to use this tool. Measuring
 * with it on measures obedience, not preference. Here there is no skill, no instruction
 * to prefer either, and both channels are described in the same register.
 *
 * Both channels drive the SAME real browser (our daemon), so the choice is genuine:
 * either one can solve the task.
 *
 *   node experiment/formal/b-preference.mjs --arm free|pixels|oracle
 *
 * Measures: choice per STEP (not per task), accumulated tokens per turn (the crossover
 * point), success, and wall time.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { daemonFetch } from '../../tools/daemon-client.mjs'

const require_ = createRequire('/tmp/x.js')            // SDK instalado en /tmp
const Anthropic = require_('@anthropic-ai/sdk').default || require_('@anthropic-ai/sdk')
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..', '..')
const OUT = join(HERE, 'results')
await mkdir(OUT, { recursive: true })

const MODEL = 'claude-opus-5'
const argv = process.argv.slice(2)
const ARM = (argv[argv.indexOf('--arm') + 1] || 'free')
const NTASKS = Number(argv[argv.indexOf('--tasks') + 1]) || 99
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── LONG missions: the formal benchmark uses 2-8 action tasks where every arm arrives
// (119/120). This needs missions where the channel can actually matter.
// NOTE: the task prompts below are deliberately left in Spanish. They are the stimulus
// the recorded results were measured with — translating them would change the
// experiment and make `results/b-preference.md` unreproducible.
const TASKS = [
  { id: 'm1', kind: 'extracción acumulada',
    prompt: 'En https://news.ycombinator.com, armá una tabla con las 5 historias más comentadas de la portada: título y cantidad de comentarios. Devolvé la tabla en texto.' },
  { id: 'm2', kind: 'formulario + validación',
    prompt: 'En http://127.0.0.1:8399/app.html: escribí "sin-arroba" en el campo Email y hacé click en Suscribirme. Después decime si la suscripción se agregó realmente a la lista o no, y cómo lo comprobaste.' },
  { id: 'm3', kind: 'navegación profunda + fold',
    prompt: 'En https://es.wikipedia.org/wiki/Argentina, encontrá dentro del artículo el enlace a "Mar del Plata" y abrilo. Confirmá que llegaste diciendo la URL final.' },
  { id: 'm4', kind: 'ruido ambiental / verificación',
    prompt: 'En http://127.0.0.1:8399/app.html hacé click en el botón "Actualizar datos" y después decime si la aplicación cambió de estado o no. La página tiene un reloj y animaciones que se mueven solas: eso NO cuenta como cambio de estado.' },
  { id: 'm5', kind: 'SPA + hidratación',
    prompt: 'En http://127.0.0.1:8399/app.html hacé click en "Ver detalle" y decime si la navegación se completó de verdad (URL y contenido), o si quedó a medias.' },
  { id: 'm6', kind: 'recovering from a blocked action',
    prompt: 'En http://127.0.0.1:8399/app.html intentá comprar: hacé click en "Comprar ahora" y después confirmá si el carrito realmente subió a 1 item. Si no funcionó, explicá por qué.' },
]

// ── The two channels, described in the SAME register ────────────────────────────────
// No "recommended", "prefer", "cheaper": that would plant the answer.
const TOOLS = [
  { name: 'take_screenshot',
    description: 'Take a screenshot of the current browser viewport and return it as an image.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'read_page_text',
    description: 'Return the visible text of the current page as plain text.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'click_at',
    description: 'Click at the given viewport coordinates.',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'observe_page',
    description: 'Return a structured summary of the page: landmark regions, headings, and the interactive elements with their id, role, name and position. When a previous observation exists, also returns what changed since then, classified as added, removed, content, state, style, moved or resized, plus which elements became covered or visible.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'find_element',
    description: 'Search the whole page for elements matching a text, and return their id, role, name and link target.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'click_element',
    description: 'Click the element with the given id (from observe_page or find_element). Scrolls it into view first and echoes back the role and name of what was clicked.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'check_effect',
    description: 'Check whether the page changed since the last observation, and assert specific expectations about that change. Accepts: changed (boolean), exists (text that must be present), mustInclude (list of expected changes with kind/role/name), urlIncludes (substring of the expected URL). Returns pass/fail per check.',
    input_schema: { type: 'object', properties: {
      changed: { type: 'boolean' }, exists: { type: 'string' }, urlIncludes: { type: 'string' },
      mustInclude: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } } } },
    }, required: [] } },
  { name: 'navigate',
    description: 'Navigate the browser to a URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'type_text',
    description: 'Type text into the currently focused element.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'answer',
    description: 'Give the final answer to the task and finish.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]
const PIXEL_TOOLS = new Set(['take_screenshot', 'read_page_text', 'click_at'])
const ORACLE_TOOLS = new Set(['observe_page', 'find_element', 'click_element', 'check_effect'])
const toolsFor = (arm) => TOOLS.filter((t) =>
  arm === 'pixels' ? !ORACLE_TOOLS.has(t.name) : arm === 'oracle' ? !PIXEL_TOOLS.has(t.name) : true)

// ── The daemon: both channels over the SAME browser ─────────────────────────────────
const cmd = (c, args = []) => daemonFetch({
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true }),
}).then((r) => r.json()).catch((e) => ({ ok: false, text: String(e) }))

async function runTool(name, input) {
  switch (name) {
    case 'navigate': { const r = await cmd('open', [input.url]); return { text: (r.text || '').slice(0, 1500) } }
    case 'take_screenshot': {
      const path = `/tmp/b-shot-${Date.now()}.jpg`
      await cmd('shot', [path])
      const b64 = (await readFile(path)).toString('base64')
      return { image: b64 }
    }
    case 'read_page_text': { const r = await cmd('outline'); return { text: (r.text || '').slice(0, 12000) } }
    case 'click_at': { const r = await cmd('click', [`${input.x},${input.y}`]); return { text: r.text || 'clicked' } }
    case 'observe_page': { const r = await cmd('look'); return { text: (r.text || '').slice(0, 6000) } }
    case 'find_element': { const r = await cmd('find', [input.text]); return { text: (r.text || '').slice(0, 3000) } }
    case 'click_element': { const r = await cmd('click', [input.id]); return { text: (r.text || '').slice(0, 600) } }
    case 'check_effect': {
      const spec = { ...input, keepBaseline: true }
      const r = await cmd('assert', [JSON.stringify(spec)])
      return { text: (r.text || '').slice(0, 2000) }
    }
    case 'type_text': { const r = await cmd('type', [input.text]); return { text: r.text || 'typed' } }
    default: return { text: 'unknown tool' }
  }
}

// ── Un episodio ──────────────────────────────────────────────────────────────────────
const client = new Anthropic()
const SYSTEM = `You are operating a web browser to complete a task. You have several tools available; use whichever ones you judge appropriate. When you are done, call the answer tool with your final answer.`

async function episode(task, arm) {
  await cmd('open', ['about:blank'])
  const messages = [{ role: 'user', content: task.prompt }]
  const steps = []
  let turns = 0, tokensIn = 0, tokensOut = 0, answer = null
  const perTurn = []
  const t0 = Date.now()

  while (turns < 30) {
    turns++
    let resp
    try {
      resp = await client.messages.create({
        model: MODEL, max_tokens: 8000,
        output_config: { effort: 'high' },
        system: SYSTEM, tools: toolsFor(arm), messages,
      })
    } catch (e) {
      steps.push({ turn: turns, error: `${e.status || ''} ${String(e.message).slice(0, 120)}` })
      break
    }
    if (resp.stop_reason === 'refusal') { steps.push({ turn: turns, error: 'refusal' }); break }
    tokensIn += resp.usage.input_tokens + (resp.usage.cache_read_input_tokens || 0)
    tokensOut += resp.usage.output_tokens
    perTurn.push({ turn: turns, in: resp.usage.input_tokens, out: resp.usage.output_tokens, cumIn: tokensIn })

    messages.push({ role: 'assistant', content: resp.content })
    const calls = resp.content.filter((b) => b.type === 'tool_use')
    if (!calls.length) {
      answer = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
      break
    }
    const results = []
    for (const call of calls) {
      if (call.name === 'answer') { answer = call.input.text; results.push({ type: 'tool_result', tool_use_id: call.id, content: 'ok' }); continue }
      steps.push({ turn: turns, tool: call.name, channel: PIXEL_TOOLS.has(call.name) ? 'pixels' : ORACLE_TOOLS.has(call.name) ? 'oracle' : 'neutral' })
      const out = await runTool(call.name, call.input)
      results.push({
        type: 'tool_result', tool_use_id: call.id,
        content: out.image
          ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.image } }]
          : out.text,
      })
    }
    messages.push({ role: 'user', content: results })
    if (answer) break
  }
  return { task: task.id, kind: task.kind, arm, answer, steps, turns, tokensIn, tokensOut, perTurn, wallMs: Date.now() - t0 }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────
// the local app with the planted silent failures (m2/m4/m5/m6 use it)
const { createServer } = await import('node:http')
const APP = await readFile(join(AGENT, 'demo-qa/silent-failures.html'), 'utf8')
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(APP) })
await new Promise((r) => srv.listen(8399, '127.0.0.1', r))

const daemon = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore' })
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const results = []
for (const task of TASKS.slice(0, NTASKS)) {
  process.stdout.write(`▸ ${task.id} (${task.kind}) arm=${ARM}… `)
  const r = await episode(task, ARM)
  const px = r.steps.filter((s) => s.channel === 'pixels').length
  const or = r.steps.filter((s) => s.channel === 'oracle').length
  console.log(`${r.steps.length} steps · pixels ${px} / tool ${or} · ${(r.tokensIn / 1000).toFixed(0)}k in · ${(r.wallMs / 1000).toFixed(0)}s`)
  results.push(r)
  await writeFile(join(OUT, `b-preference-${ARM}.json`), JSON.stringify(results, null, 2) + '\n')
}

await new Promise((r) => { const s = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* ya murió */ }
srv.close()

// ── Reporte ──────────────────────────────────────────────────────────────────────────
const allSteps = results.flatMap((r) => r.steps).filter((s) => s.tool)
const px = allSteps.filter((s) => s.channel === 'pixels').length
const or = allSteps.filter((s) => s.channel === 'oracle').length
console.log(`\n── Choice per STEP (arm=${ARM}) ──`)
console.log(`pixels: ${px} · tool: ${or} · neutral: ${allSteps.length - px - or} (total ${allSteps.length})`)
console.log('\n| task | kind | steps | pixels | tool | tokens in | s |')
console.log('|---|---|---:|---:|---:|---:|---:|')
for (const r of results) {
  const p = r.steps.filter((s) => s.channel === 'pixels').length
  const o = r.steps.filter((s) => s.channel === 'oracle').length
  console.log(`| ${r.task} | ${r.kind} | ${r.steps.filter((s) => s.tool).length} | ${p} | ${o} | ${(r.tokensIn / 1000).toFixed(1)}k | ${(r.wallMs / 1000).toFixed(0)} |`)
}
const costIn = results.reduce((s, r) => s + r.tokensIn, 0) / 1e6 * 5
const costOut = results.reduce((s, r) => s + r.tokensOut, 0) / 1e6 * 25
console.log(`\nestimated cost of this run: $${(costIn + costOut).toFixed(2)} (${MODEL})`)
console.log(`→ results/b-preference-${ARM}.json`)

// The fixture server keeps the process alive on a lingering keep-alive socket:
// the run finishes, writes its results, and then hangs looking like a stuck benchmark
// (measured: >10 min on a run whose real work took 43 s). Exit on the result.
srv.closeAllConnections?.()
process.exit(0)
