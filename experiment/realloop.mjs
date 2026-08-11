/**
 * REAL-SITE agent loop — the decisive product experiment (act → observe → act on live
 * pages, not fixtures). Three arms per task:
 *
 *   A  screenshot only        (what agents do today)
 *   B  oracle only            (outline+agentMap first turn, changes+map after)
 *   C  screenshot + oracle
 *
 *   node experiment/realloop.mjs --dry           # free: validates every
 *        task's golden path + measures each arm's first-turn payload + prints a budget
 *   node experiment/realloop.mjs [--reps 2] [--model claude-sonnet-5]
 *        [--steps 5] [--tasks id,id]                            # paid run
 *
 * Success is a URL predicate checked in the page — never the model's own claim.
 * Clicks are raw coordinate clicks (`mouse.click`), so hitting a covered element
 * misses, exactly like a real in-page agent.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 *
 * NOTE: the fixture page copy, the task goals and the model prompts below are
 * deliberately in Spanish. They are the stimulus the recorded results were measured
 * with — translating them would change the experiment and make the numbers in
 * EXPERIMENT.md unreproducible.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { usd, PRICES } from './cost.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, hostSnapdom, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def
}
const DRY = flag('dry', false) === true
const REPS = Number(flag('reps', 2))
const MODEL = String(flag('model', 'claude-sonnet-5'))
const MAX_STEPS = Number(flag('steps', 5))
const ONLY = flag('tasks', '') ? String(flag('tasks', '')).split(',') : null
// A: native screenshot · B: oracle · C: native screenshot + oracle ·
// D: snapdom-rendered screenshot + oracle from the SAME capture (the embedded-agent
//    configuration: no native capture API anywhere, one call yields pixels+semantics)
const ARMS = String(flag('arms', 'A,B,C')).split(',')
const KEY = process.env.ANTHROPIC_API_KEY
if (!KEY && !DRY) { console.error('[realloop] ANTHROPIC_API_KEY required (or --dry).'); process.exit(1) }

/** Golden path steps prove each task is completable by script before a model pays for
 *  it; the model never sees them. */
const TASKS = [
  {
    id: 'wikipedia-borges',
    url: 'https://es.wikipedia.org/wiki/Portada',
    goal: 'Llegá al artículo de Wikipedia sobre Jorge Luis Borges usando el buscador.',
    success: (url) => /\/wiki\/Jorge_Luis_Borges/.test(url),
    golden: [{ fill: ['#searchInput, input[name="search"]', 'Jorge Luis Borges'] }, { press: 'Enter' }, { settle: 3000 }],
  },
  {
    id: 'wikipedia-nav',
    url: 'https://es.wikipedia.org/wiki/Argentina',
    goal: 'Navegá al artículo sobre la ciudad de Buenos Aires siguiendo un enlace del artículo.',
    success: (url) => /\/wiki\/Buenos_Aires/.test(url),
    golden: [{ click: '#mw-content-text a[href$="/wiki/Buenos_Aires"]' }, { settle: 3000 }],
  },
  {
    id: 'ebay-guitar',
    url: 'https://www.ebay.com/',
    goal: 'Buscá "acoustic guitar" y llegá a la página de resultados.',
    success: (url) => /_nkw=|\/sch\//.test(url),
    golden: [{ fill: ['input[name="_nkw"]', 'acoustic guitar'] }, { press: 'Enter' }, { settle: 3000 }],
  },
  {
    id: 'pydocs-tutorial',
    url: 'https://docs.python.org/3/',
    goal: 'Buscá "tutorial" con el cuadro de búsqueda y llegá a los resultados.',
    success: (url) => /docs\.python\.org\/.*search\.html\?q=/.test(url),
    golden: [{ typeInto: ['form.inline-search input[name="q"]', 'tutorial'] }, { press: 'Enter' }, { settle: 3000 }],
  },
  {
    id: 'npm-snapdom',
    url: 'https://www.npmjs.com/',
    goal: 'Buscá el paquete "snapdom" y llegá a la página de resultados.',
    success: (url) => /npmjs\.com\/search/.test(url),
    golden: [{ typeInto: ['input[name="q"]', 'snapdom'] }, { press: 'Enter' }, { settle: 3000 }],
  },
].filter((t) => !ONLY || ONLY.includes(t.id))

// ── Observations per arm ─────────────────────────────────────────────────────────────
// Protocol lessons from the first paid run (EXPERIMENT.md): a blind cut of the outline
// dropped the target link and sank two arms. The outline now trims prose but never an
// interactive line; the model can `find` over the FULL page; ids are clickable (with
// auto-scroll); a navigation resets the protocol to a fresh first turn.
const CONTEXT_BUDGET = 14000 // chars
const MAP_CAP = 120

const inPageObserve = async (previous) => {
  const ui = await window.__agentInspect(document.body, previous ? { previous } : {})
  window.__lastUi = ui
  window.__lastCp = ui.checkpoint()
  const map = ui.agentMap.map
    .slice(0, 120)
    .map((e) => ({ id: e.id, role: e.r, name: e.n, bbox: e.b, ...(e.covered ? { covered: true, coveredBy: e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role) } : {}) }))
  return {
    context: ui.context,
    map,
    mapTotal: ui.agentMap.map.length,
    changed: ui.changed,
    changes: ui.changes && ui.changes.slice(0, 60),
    delta: ui.actionabilityDelta,
    unobservable: ui.unobservable,
  }
}

/** Arm D: pixels AND semantics from ONE snapdom capture — the embedded-agent path.
 *  `clip: 'viewport'` renders exactly what a native screenshot would show, and the
 *  oracle walk runs in the same task as the clone, so image and semantics describe the
 *  same instant by construction. */
const inPageSnap = async (previous) => {
  const oracle = window.__agentOracle(previous ? { previous } : {})
  const result = await window.__snapdom(document.body, { plugins: [oracle], clip: 'viewport' })
  const img = await result.toPng()
  const ui = oracle.ui
  window.__lastUi = ui
  window.__lastCp = ui.checkpoint()
  const map = ui.agentMap.map
    .slice(0, 120)
    .map((e) => ({ id: e.id, role: e.r, name: e.n, bbox: e.b, ...(e.covered ? { covered: true, coveredBy: e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role) } : {}) }))
  return {
    src: img.src,
    context: ui.context,
    map,
    mapTotal: ui.agentMap.map.length,
    changed: ui.changed,
    changes: ui.changes && ui.changes.slice(0, 60),
    delta: ui.actionabilityDelta,
    unobservable: ui.unobservable,
  }
}

/** Search the WHOLE page (uncapped map + text nodes) — the escape hatch for anything the
 *  bounded outline/map left out. Free: runs in-page, no model tokens. */
const inPageFind = (query) => {
  const ui = window.__lastUi
  if (!ui) return { query, matches: [] }
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const q = norm(query)
  const out = []
  const seen = new Set()
  for (const e of ui.agentMap.map) {
    if (norm(e.n).includes(q)) {
      out.push({ id: e.id, role: e.r, name: e.n, bbox: e.b, ...(e.covered ? { covered: true } : {}) })
      seen.add(e.id)
      if (out.length >= 12) break
    }
  }
  if (out.length < 12) {
    for (const id of ui.__snapshot.order) {
      const n = ui.__snapshot.nodes.get(id)
      if (seen.has(id) || !n.text) continue
      if (norm(n.text).includes(q)) {
        out.push({ id: n.id, role: n.role, name: n.name || n.text.slice(0, 50), bbox: n.bbox })
        if (out.length >= 12) break
      }
    }
  }
  return { query, matches: out }
}

/** Resolve a node id to a clickable viewport point, scrolling it into view if needed. */
const inPageLocate = (id) => {
  const ui = window.__lastUi
  const el = ui && ui.__snapshot.elements.get(id)
  if (!el) return null
  let r = el.getBoundingClientRect()
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    el.scrollIntoView({ block: 'center' })
    r = el.getBoundingClientRect()
  }
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
}

/** Trim to budget without ever dropping an interactive/structural line: prose text is
 *  shortened first, then non-interactive lines go (keeping kept lines' ancestors), and
 *  what was dropped is DECLARED, with `find` as the way back. */
const STRUCTURAL = /\[(button|link|textbox|searchbox|checkbox|radio|combobox|slider|spinbutton|switch|tab|menuitem|option|heading|navigation|main|banner|search|form|contentinfo|img)\]|#/
function trimOutline(context, budget) {
  if (context.length <= budget) return context
  let lines = context.split('\n').map((l) => STRUCTURAL.test(l) ? l : l.replace(/"([^"]{40})[^"]*"/, '"$1…"'))
  if (lines.join('\n').length <= budget) return lines.join('\n')
  const depth = (l) => (l.match(/^ */)[0].length / 2) | 0
  const keep = new Array(lines.length).fill(false)
  const stack = []
  for (let i = 0; i < lines.length; i++) {
    const d = depth(lines[i])
    stack[d] = i
    stack.length = d + 1
    if (STRUCTURAL.test(lines[i])) for (const a of stack) keep[a] = true
  }
  const kept = lines.filter((_, i) => keep[i])
  const dropped = lines.length - kept.length
  let s = kept.join('\n')
  let note = `${dropped} líneas de contenido no interactivo omitidas`
  if (s.length > budget) { s = s.slice(0, budget); note = 'outline INCOMPLETO' }
  return s + `\n…[recortado: ${note} — usá find para localizar lo que no veas]`
}

function oracleText(obs, firstTurn, findResult) {
  const parts = []
  if (firstTurn) {
    parts.push('ESTRUCTURA DE LA PÁGINA:\n' + trimOutline(obs.context, CONTEXT_BUDGET))
    parts.push(`ELEMENTOS ACCIONABLES (${obs.mapTotal} total${obs.mapTotal > MAP_CAP ? ', primeros ' + MAP_CAP + ' — el resto vía find' : ''}):\n` +
      JSON.stringify(obs.map))
  } else {
    parts.push('CAMBIOS DESDE TU ÚLTIMA ACCIÓN:\n' + JSON.stringify({ changed: obs.changed, changes: obs.changes, actionabilityDelta: obs.delta }))
  }
  if (findResult) parts.push('RESULTADO DE TU BÚSQUEDA:\n' + JSON.stringify(findResult))
  if (obs.unobservable.length) parts.push('REGIONES NO OBSERVABLES: ' + JSON.stringify(obs.unobservable))
  return parts.join('\n\n')
}

const schemaFor = (arm) => ({
  type: 'object',
  properties: {
    action: { type: 'string', enum: arm === 'A' ? ['click', 'type', 'press_enter', 'done'] : ['click', 'type', 'press_enter', 'find', 'done'] },
    ...(arm === 'A' ? {} : { id: { type: 'string' }, query: { type: 'string' } }),
    x: { type: 'number' }, y: { type: 'number' },
    text: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action', 'reason'],
  additionalProperties: false,
})

/** Per-arm rules — v2 run showed arm A hallucinating an element id after reading rules
 *  about a capability it does not have. Each arm only hears about its own channels. */
const RULES_BASE = `Sos un agente que opera una página web real con acciones de mouse/teclado.
Respondé SOLO el JSON de tu próxima acción:`
const RULES_COMMON = `- type: escribe en el elemento enfocado (primero hacé click en el campo, en un paso anterior).
- press_enter: envía el formulario enfocado.
- done: SOLO cuando la URL o la página actual demuestran que la tarea está completa.
Un click aterriza en lo que esté ARRIBA en esa posición: un elemento tapado no recibe el click.`
const rulesFor = (arm) => {
  if (arm === 'A') {
    return `${RULES_BASE}
- click: x,y = centro del elemento en la captura (de un bbox [x,y,w,h]: x+w/2, y+h/2).
${RULES_COMMON}`
  }
  const withIds = `${RULES_BASE}
- click: preferí id (de ELEMENTOS ACCIONABLES, CAMBIOS o RESULTADO DE BÚSQUEDA — se scrollea solo si hace falta); x,y solo si no tenés id (centro de un bbox [x,y,w,h]: x+w/2, y+h/2).
- find: {query} busca por texto en TODA la página — usalo cuando lo que necesitás no aparezca (el outline y el mapa pueden estar incompletos, y te lo avisan cuando lo están).
${RULES_COMMON}`
  if (arm === 'B') return withIds
  return withIds + `
Tenés dos canales: la CAPTURA DE PANTALLA es la autoridad sobre qué es visible y dónde está; los datos semánticos son la autoridad sobre oclusión, estado, cambios y lo que está fuera de pantalla. Si se contradicen en geometría, mandá la captura.`
}

async function decide(content, schema = schemaFor('B')) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  const text = (json.content || []).map((c) => c.text || '').join('')
  return {
    decision: json.stop_reason === 'refusal' ? null : JSON.parse(text),
    inputTokens: json.usage?.input_tokens || 0,
    outputTokens: json.usage?.output_tokens || 0,
  }
}

// ── Page plumbing ────────────────────────────────────────────────────────────────────
async function newPage(browser) {
  return browser.newPage({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    bypassCSP: true,
    locale: 'es-AR',
  })
}

async function loadTask(page, task, sdk) {
  await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  await page.addScriptTag({ content: sdk })
}

/** The SDK washes away on navigation; re-inject before observing. */
async function ensureSdk(page, sdk) {
  const has = await page.evaluate(() => typeof window.__agentInspect === 'function').catch(() => false)
  if (!has) { await page.addScriptTag({ content: sdk }).catch(() => {}); await page.waitForTimeout(300) }
}

async function runGolden(page, task) {
  for (const step of task.golden) {
    if (step.fill) await page.fill(step.fill[0], step.fill[1], { timeout: 8000 })
    if (step.typeInto) {
      await page.locator(step.typeInto[0]).first().click({ timeout: 8000 })
      await page.keyboard.insertText(step.typeInto[1])
    }
    if (step.press) await page.keyboard.press(step.press)
    if (step.click) await page.locator(step.click).first().click({ timeout: 8000 })
    if (step.settle) await page.waitForTimeout(step.settle)
  }
  return task.success(page.url())
}

// ── The loop (paid) ──────────────────────────────────────────────────────────────────
async function runArm(browser, task, arm, rep, sdk) {
  const page = await newPage(browser)
  const row = { task: task.id, arm, rep, success: false, steps: 0, tokensIn: 0, tokensOut: 0, error: null }
  try {
    await loadTask(page, task, sdk)
    let firstTurn = true
    let lastUrl = page.url()
    let findResult = null
    const history = []
    for (let step = 0; step < MAX_STEPS; step++) {
      await ensureSdk(page, sdk)
      // A navigation is a new page: fresh outline, no cross-page diff, stale find result.
      if (page.url() !== lastUrl) { firstTurn = true; lastUrl = page.url(); findResult = null }
      const content = []
      let obs = null
      const previous = firstTurn ? null : await page.evaluate(() => window.__lastCp)
      if (arm === 'D') {
        obs = await page.evaluate(inPageSnap, previous)
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: obs.src.split(',')[1] } })
      } else if (arm !== 'A') {
        obs = await page.evaluate(inPageObserve, previous)
      }
      if (arm === 'A' || arm === 'C') {
        const shot = await page.screenshot({ type: 'jpeg', quality: 80 })
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.toString('base64') } })
      }
      const textParts = [rulesFor(arm), 'OBJETIVO: ' + task.goal, 'URL ACTUAL: ' + page.url()]
      if (obs) textParts.push(oracleText(obs, firstTurn, findResult))
      if (history.length) textParts.push('TUS ACCIONES PREVIAS:\n' + history.join('\n'))
      content.push({ type: 'text', text: textParts.join('\n\n') })

      const { decision, inputTokens, outputTokens } = await decide(content, schemaFor(arm))
      row.tokensIn += inputTokens; row.tokensOut += outputTokens
      row.steps++
      firstTurn = false
      findResult = null
      if (!decision) { row.error = 'refusal'; break }
      history.push(JSON.stringify(decision))
      if (decision.action === 'done') break
      if (decision.action === 'find' && decision.query && arm !== 'A') {
        findResult = await page.evaluate(inPageFind, decision.query)
        continue // free in-page lookup — no page action this step
      }
      if (decision.action === 'click') {
        let point = decision.id && arm !== 'A' ? await page.evaluate(inPageLocate, decision.id) : null
        if (!point && decision.x != null) point = { x: decision.x, y: decision.y }
        if (point) await page.mouse.click(point.x, point.y)
        else history.push(JSON.stringify({ harness: 'click sin id resoluble ni coordenadas — no se ejecutó' }))
      }
      if (decision.action === 'type' && decision.text) await page.keyboard.insertText(decision.text)
      if (decision.action === 'press_enter') await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
      if (task.success(page.url())) break
    }
    row.success = task.success(page.url())
    row.history = history
  } catch (e) {
    row.error = String(e).slice(0, 200)
  }
  await page.close().catch(() => {})
  return row
}

// ── Dry: validate tasks + measure payloads + budget ──────────────────────────────────
async function dry(browser, sdk) {
  const IMG_TOKENS = Math.round(1280 * 800 / 750)
  const report = []
  for (const task of TASKS) {
    const row = { task: task.id }
    // 1. the task is completable by script
    let page = await newPage(browser)
    try {
      await loadTask(page, task, sdk)
      row.goldenSuccess = await runGolden(page, task)
      row.finalUrl = page.url().slice(0, 90)
    } catch (e) { row.goldenSuccess = false; row.error = String(e).slice(0, 140) }
    await page.close()
    // 2. each arm's first-turn payload, measured on a fresh load
    page = await newPage(browser)
    try {
      await loadTask(page, task, sdk)
      const obs = await page.evaluate(inPageObserve, null)
      const oracleTok = Math.round(oracleText(obs, true).length / 4)
      const oracleNextTok = 400 // measured sweep p50 is ~19; changes+map dominates → conservative
      row.tokens = {
        A_first: IMG_TOKENS, B_first: oracleTok, C_first: IMG_TOKENS + oracleTok,
        B_next_est: oracleNextTok + Math.round(JSON.stringify(obs.map).length / 4),
      }
    } catch (e) { row.error = (row.error || '') + ' obs: ' + String(e).slice(0, 100) }
    await page.close()
    report.push(row)
    console.log(JSON.stringify(row))
  }
  // 3. budget
  const prompt = 500
  const perTaskSteps = MAX_STEPS
  const est = {}
  for (const model of Object.keys(PRICES)) {
    let inTok = 0, outTok = 0
    for (const r of report) {
      if (!r.tokens) continue
      const t = r.tokens
      const stepIn = { A: IMG_TOKENS + prompt, B: t.B_next_est + prompt, C: IMG_TOKENS + t.B_next_est + prompt }
      for (const arm of ['A', 'B', 'C']) {
        const first = arm === 'A' ? t.A_first : arm === 'B' ? t.B_first : t.C_first
        inTok += REPS * (first + prompt + (perTaskSteps - 1) * stepIn[arm])
        outTok += REPS * perTaskSteps * 120
      }
    }
    est[model] = usd(model, inTok, outTok)
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'realloop-dry.json'), JSON.stringify({ reps: REPS, maxSteps: MAX_STEPS, report, budgetUsd: est }, null, 2))
  console.log('\nBudget for a full paid run (reps=' + REPS + ', steps≤' + MAX_STEPS + ', 3 arms, ' + report.length + ' tasks):')
  console.log(JSON.stringify(est, null, 1))
}

// ── Main ─────────────────────────────────────────────────────────────────────────────
const SDK = await (async () => {
  const esbuild = await import('esbuild')
  const entry = join(HERE, 'sdk-entry.mjs')
  await writeFile(entry, `import { inspect } from '${join(AGENT, 'src/index.js')}'
import { agentOracle } from '${join(AGENT, 'src/plugin.js')}'
import { snapdom } from '${hostSnapdom(REPO)}'
window.__agentInspect = inspect
window.__agentOracle = agentOracle
window.__snapdom = snapdom
`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
})()

const browser = await chromium.launch()
if (DRY) { await dry(browser, SDK); await browser.close(); process.exit(0) }

const results = []
for (const task of TASKS) {
  for (const arm of ARMS) {
    for (let rep = 0; rep < REPS; rep++) {
      const row = await runArm(browser, task, arm, rep, SDK)
      results.push(row)
      console.log(JSON.stringify(row))
    }
  }
}
await browser.close()

const byArm = {}
for (const arm of ARMS) {
  const mine = results.filter((r) => r.arm === arm)
  const tIn = mine.reduce((a, r) => a + r.tokensIn, 0)
  const tOut = mine.reduce((a, r) => a + r.tokensOut, 0)
  byArm[arm] = {
    success: mine.filter((r) => r.success).length + '/' + mine.length,
    avgSteps: +(mine.reduce((a, r) => a + r.steps, 0) / mine.length).toFixed(2),
    tokensIn: tIn, tokensOut: tOut, usd: usd(MODEL, tIn, tOut),
  }
}
await mkdir(OUT, { recursive: true })
const summary = { model: MODEL, reps: REPS, maxSteps: MAX_STEPS, byArm, results }
await writeFile(join(OUT, `realloop-${ARMS.join('')}.json`), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ model: MODEL, byArm }, null, 1))
