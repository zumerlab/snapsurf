/**
 * d-third-party.mjs — TESTPLAN Fase D: benchmark de TERCEROS.
 *
 * Nuestro benchmark formal da 119/120 con tareas que escribimos nosotros — y ese 100%
 * sugiere que son fáciles, no que el canal sea superior (los benchmarks públicos miden
 * ~30% de éxito real). Esta fase corre tareas que NO escribimos, juzgadas con criterios
 * que NO escribimos.
 *
 * Fuente: `iMeanAI/Mind2Web-Live` (WebCanvas) — tareas sobre sitios VIVOS con "key
 * nodes" anotados. Se usa el subconjunto cuyos key nodes son 100% evaluables por URL
 * (`url_included_match` / `url_exactly_match`): 23 de las primeras 40 tareas. Los
 * matchers de element-path quedan fuera a propósito — evaluarlos requeriría replicar
 * su harness de DOM, y prefiero un subconjunto chico y objetivo a uno grande y opinable.
 *
 *   node packages/agent/experiment/formal/d-third-party.mjs --arm oracle|pixels [--tasks N]
 *
 * Métrica: key nodes completados / key nodes totales, por brazo. Es la métrica de
 * WebCanvas, no una nuestra.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire('/tmp/x.js')
const Anthropic = require_('@anthropic-ai/sdk').default || require_('@anthropic-ai/sdk')
const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..', '..')
const OUT = join(HERE, 'results')
await mkdir(OUT, { recursive: true })
const MODEL = 'claude-opus-5'
const argv = process.argv.slice(2)
const ARM = argv[argv.indexOf('--arm') + 1] || 'oracle'
const NTASKS = Number(argv[argv.indexOf('--tasks') + 1]) || 8
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Tareas y criterios de terceros ───────────────────────────────────────────────────
const raw = await fetch('https://datasets-server.huggingface.co/rows?dataset=iMeanAI%2FMind2Web-Live&config=default&split=test&offset=0&length=40').then((r) => r.json())
const all = raw.rows.map((r) => r.row).map((r) => ({
  ...r, evaluation: typeof r.evaluation === 'string' ? JSON.parse(r.evaluation) : r.evaluation,
}))
const TASKS = all.filter((t) => t.evaluation.every((e) => e.match_function_name.startsWith('url')))
  .filter((t) => t.evaluation.every((e) => e.match_function_name !== 'url_semantic_match'))
  .slice(0, NTASKS)
console.log(`${TASKS.length} tareas de terceros (key nodes 100% evaluables por URL)\n`)

// ── El agente: mismos dos canales que la Fase B ──────────────────────────────────────
const TOOLS = [
  { name: 'navigate', description: 'Navigate the browser to a URL.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'take_screenshot', description: 'Take a screenshot of the current browser viewport and return it as an image.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'read_page_text', description: 'Return the visible text of the current page as plain text.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'click_at', description: 'Click at the given viewport coordinates.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'observe_page', description: 'Return a structured summary of the page: landmark regions, headings, and the interactive elements with their id, role, name and position, plus what changed since the last observation.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'find_element', description: 'Search the whole page for elements matching a text, and return their id, role, name and link target.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'click_element', description: 'Click the element with the given id. Scrolls it into view and echoes the role and name of what was clicked.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'type_text', description: 'Type text into the currently focused element.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'press_enter', description: 'Press the Enter key.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'answer', description: 'Give the final answer and finish.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]
const PIXEL = new Set(['take_screenshot', 'read_page_text', 'click_at'])
const ORACLE = new Set(['observe_page', 'find_element', 'click_element'])
const toolsFor = (arm) => TOOLS.filter((t) => arm === 'pixels' ? !ORACLE.has(t.name) : !PIXEL.has(t.name))

const visited = []
const cmd = async (c, args = []) => {
  const r = await fetch('http://127.0.0.1:8377/cmd', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: c, args, envelope: true }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, text: String(e) }))
  if (r.url) visited.push(r.url)
  return r
}

async function runTool(name, input) {
  switch (name) {
    case 'navigate': { const r = await cmd('open', [input.url]); return { text: (r.text || '').slice(0, 1500) } }
    case 'take_screenshot': {
      const p = `/tmp/d-shot-${Date.now()}.jpg`; await cmd('shot', [p])
      return { image: (await readFile(p)).toString('base64') }
    }
    case 'read_page_text': { const r = await cmd('outline'); return { text: (r.text || '').slice(0, 12000) } }
    case 'click_at': { const r = await cmd('click', [`${input.x},${input.y}`]); return { text: (r.text || '').slice(0, 400) } }
    case 'observe_page': { const r = await cmd('look'); return { text: (r.text || '').slice(0, 6000) } }
    case 'find_element': { const r = await cmd('find', [input.text]); return { text: (r.text || '').slice(0, 3000) } }
    case 'click_element': { const r = await cmd('click', [input.id]); return { text: (r.text || '').slice(0, 500) } }
    case 'type_text': { const r = await cmd('type', [input.text]); return { text: r.text || 'typed' } }
    case 'press_enter': { const r = await cmd('enter'); return { text: (r.text || '').slice(0, 300) } }
    default: return { text: 'unknown' }
  }
}

// ── El juez es de ELLOS: sus key nodes, sus match functions ──────────────────────────
const scoreKeyNodes = (evaluation, urls) => evaluation.map((node) => {
  const ref = (node.content.url || node.content.reference_answer || '').toLowerCase()
  const hit = node.match_function_name === 'url_exactly_match'
    ? urls.some((u) => u.toLowerCase().replace(/\/$/, '') === ref.replace(/\/$/, ''))
    : urls.some((u) => u.toLowerCase().includes(ref.replace(/^https?:\/\//, '').replace(/\/$/, '')))
  return { matcher: node.match_function_name, ref, hit }
})

const client = new Anthropic()
const SYSTEM = 'You are operating a web browser to complete a task. Use whichever tools you judge appropriate. Call answer when done.'

const daemon = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'serve'], { stdio: 'ignore' })
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const results = []
for (const task of TASKS) {
  visited.length = 0
  await cmd('open', ['about:blank'])
  const messages = [{ role: 'user', content: task.task }]
  let turns = 0, tokensIn = 0, tokensOut = 0, answer = null, steps = 0
  const t0 = Date.now()
  while (turns < 25) {
    turns++
    let resp
    try {
      resp = await client.messages.create({ model: MODEL, max_tokens: 8000, output_config: { effort: 'high' }, system: SYSTEM, tools: toolsFor(ARM), messages })
    } catch (e) { break }
    if (resp.stop_reason === 'refusal') break
    tokensIn += resp.usage.input_tokens; tokensOut += resp.usage.output_tokens
    messages.push({ role: 'assistant', content: resp.content })
    const calls = resp.content.filter((b) => b.type === 'tool_use')
    if (!calls.length) { answer = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join(''); break }
    const out = []
    for (const c of calls) {
      if (c.name === 'answer') { answer = c.input.text; out.push({ type: 'tool_result', tool_use_id: c.id, content: 'ok' }); continue }
      steps++
      const r = await runTool(c.name, c.input)
      out.push({ type: 'tool_result', tool_use_id: c.id, content: r.image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.image } }] : r.text })
    }
    messages.push({ role: 'user', content: out })
    if (answer) break
  }
  const nodes = scoreKeyNodes(task.evaluation, visited)
  const done = nodes.filter((n) => n.hit).length
  results.push({ index: task.index, task: task.task, arm: ARM, keyNodes: nodes.length, completed: done, nodes, steps, tokensIn, tokensOut, wallMs: Date.now() - t0, answer: (answer || '').slice(0, 300), urls: [...new Set(visited)].slice(0, 12) })
  console.log(`[${task.index}] ${done}/${nodes.length} key nodes · ${steps} pasos · ${(tokensIn / 1000).toFixed(0)}k · ${((Date.now() - t0) / 1000).toFixed(0)}s — ${task.task.slice(0, 60)}`)
  await writeFile(join(OUT, `d-third-party-${ARM}.json`), JSON.stringify(results, null, 2) + '\n')
}

await new Promise((r) => { const s = spawn(process.execPath, [join(AGENT, 'tools/browse.mjs'), 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* ya murió */ }

const totN = results.reduce((s, r) => s + r.keyNodes, 0)
const totD = results.reduce((s, r) => s + r.completed, 0)
const full = results.filter((r) => r.completed === r.keyNodes).length
console.log(`\n── ${ARM} ──`)
console.log(`key nodes completados: ${totD}/${totN} (${(100 * totD / totN).toFixed(0)}%)`)
console.log(`tareas con TODOS los key nodes: ${full}/${results.length}`)
console.log(`costo: $${(results.reduce((s, r) => s + r.tokensIn, 0) / 1e6 * 5 + results.reduce((s, r) => s + r.tokensOut, 0) / 1e6 * 25).toFixed(2)}`)
console.log(`→ results/d-third-party-${ARM}.json`)
