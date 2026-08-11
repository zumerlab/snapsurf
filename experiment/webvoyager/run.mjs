/**
 * WebVoyager eval — the competitor's benchmark, run against the oracle.
 *
 * Same 25 tasks (dataset.mjs reproduces lumen's seeded stratified sample id-for-id),
 * same max steps, same trial policy, same judge contract, same report schema, so our
 * numbers sit next to `baselines/*.json` without translation. What changes is the
 * PERCEPTION CHANNEL, which is the whole question:
 *
 *   pixels   screenshot only                    — the vision-first baseline (lumen's premise)
 *   oracle   outline + agentMap, then diffs     — the product
 *   hybrid   screenshot + oracle
 *   snap     ONE snapdom capture → pixels+semantics of the same instant (embedded agent)
 *
 * All four run the same loop, model, prompt skeleton and action set, so an arm delta is
 * a channel delta and nothing else.
 *
 *   node experiment/webvoyager/run.mjs --dry
 *        free: loads every task, measures each arm's first-turn payload, flags sites
 *        that block the harness, prints a per-arm cost estimate.
 *   node experiment/webvoyager/run.mjs --arms oracle,pixels [--limit 25]
 *        [--trials 3] [--steps 50] [--model claude-sonnet-4-6] [--tasks id,id] [--headless]
 *   node experiment/webvoyager/run.mjs --model gemini-2.5-flash --arms oracle,pixels
 *        free on the AI Studio free tier — same loop, same metrics, $0 spend
 *   node experiment/webvoyager/run.mjs --mock --trials 1 --tasks GitHub--25
 *        free smoke test: scripted policy, no model call at all
 *
 * Provider follows the model id: `gemini-*` needs GEMINI_API_KEY, anything else needs
 * ANTHROPIC_API_KEY. Judge: GEMINI_API_KEY → gemini-2.5-flash (lumen's judge); otherwise
 * an Anthropic judge, recorded in the report as `judgeModel`.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 * @module agent/experiment/webvoyager/run
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lumenTasks, loadTasks, sampleStratified } from './dataset.mjs'
import { judge, JUDGE_MODEL } from './judge.mjs'
import { withRetry } from './retry.mjs'
import { usd } from '../cost.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../../tools/host-repo.mjs')
const REPO = resolveHost()
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def
}
const DRY = flag('dry', false) === true
const ARMS = String(flag('arms', 'oracle')).split(',')
const LIMIT = Number(flag('limit', 25))
const TRIALS = Number(flag('trials', 3))
const MAX_STEPS = Number(flag('steps', 50))
const MODEL = String(flag('model', 'claude-sonnet-4-6'))
const ONLY = flag('tasks', '') ? String(flag('tasks', '')).split(',') : null
const HEADLESS = flag('headless', false) === true
const TASK_TIMEOUT_MS = Number(flag('timeout', 600000))
const TAG = String(flag('tag', ''))
/** Scripted policy instead of the model: exercises the whole loop (both observation
 *  paths, find, act, screenshot, judge plumbing, report writing) for free. */
const MOCK = flag('mock', false) === true
/** Provider follows the model id: `gemini-*` → Google AI Studio, anything else → Anthropic.
 *  The free AI Studio tier is what makes a full run cost nothing; it rate-limits hard, so
 *  every call goes through withRetry. */
const IS_GEMINI = MODEL.startsWith('gemini')
const KEY = process.env.ANTHROPIC_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
if (!DRY && !MOCK) {
  const missing = IS_GEMINI ? !GEMINI_KEY && 'GEMINI_API_KEY' : !KEY && 'ANTHROPIC_API_KEY'
  if (missing) { console.error(`[webvoyager] ${missing} required for model ${MODEL} (or --dry / --mock).`); process.exit(1) }
}


const TASKS = (() => {
  const base = LIMIT === 25 ? lumenTasks() : sampleStratified(loadTasks(), LIMIT)
  const picked = ONLY ? base.filter((t) => ONLY.includes(t.id)) : base
  return picked.slice(0, LIMIT)
})()

// ── Observation channels (shared with realloop.mjs by design, not by import: that file
//    is a script and importing it would launch a browser) ─────────────────────────────
const CONTEXT_BUDGET = 14000 // chars
const MAP_CAP = 120

const inPageObserve = async (previous) => {
  const ui = await window.__agentInspect(document.body, previous ? { previous } : {})
  window.__lastUi = ui
  window.__lastCp = ui.checkpoint()
  const map = ui.agentMap.map.slice(0, 120).map((e) => ({
    id: e.id, role: e.r, name: e.n, bbox: e.b,
    ...(e.covered ? { covered: true, coveredBy: e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role) } : {}),
  }))
  return {
    context: ui.context, map, mapTotal: ui.agentMap.map.length,
    changed: ui.changed, changes: ui.changes && ui.changes.slice(0, 60),
    delta: ui.actionabilityDelta, unobservable: ui.unobservable,
  }
}

/** Arm `snap`: pixels AND semantics from ONE snapdom capture of the same instant. */
const inPageSnap = async (previous) => {
  const oracle = window.__agentOracle(previous ? { previous } : {})
  const result = await window.__snapdom(document.body, { plugins: [oracle], clip: 'viewport' })
  const img = await result.toPng()
  const ui = oracle.ui
  window.__lastUi = ui
  window.__lastCp = ui.checkpoint()
  const map = ui.agentMap.map.slice(0, 120).map((e) => ({
    id: e.id, role: e.r, name: e.n, bbox: e.b,
    ...(e.covered ? { covered: true, coveredBy: e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role) } : {}),
  }))
  return {
    src: img.src, context: ui.context, map, mapTotal: ui.agentMap.map.length,
    changed: ui.changed, changes: ui.changes && ui.changes.slice(0, 60),
    delta: ui.actionabilityDelta, unobservable: ui.unobservable,
  }
}

/** Whole-page text search — free (runs in-page, costs no model tokens). */
const inPageFind = (query) => {
  const ui = window.__lastUi
  if (!ui) return { query, matches: [] }
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
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

/** Read the text around a node — how an oracle arm quotes an answer it can see. */
const inPageRead = (id) => {
  const ui = window.__lastUi
  const el = ui && ui.__snapshot.elements.get(id)
  if (!el) return null
  const container = el.closest('article, section, li, tr, main, div') || el
  return { id, text: (container.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 2500) }
}

/** Resolve a node id to a viewport point, scrolling it into view if needed. */
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

const STRUCTURAL = /\[(button|link|textbox|searchbox|checkbox|radio|combobox|slider|spinbutton|switch|tab|menuitem|option|heading|navigation|main|banner|search|form|contentinfo|img)\]|#/
function trimOutline(context, budget) {
  if (context.length <= budget) return context
  const lines = context.split('\n').map((l) => (STRUCTURAL.test(l) ? l : l.replace(/"([^"]{40})[^"]*"/, '"$1…"')))
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
  let s = kept.join('\n')
  let note = `${lines.length - kept.length} non-interactive content lines omitted`
  if (s.length > budget) { s = s.slice(0, budget); note = 'outline TRUNCATED' }
  return s + `\n…[trimmed: ${note} — use find to locate anything you cannot see]`
}

function oracleText(obs, firstTurn, extra) {
  const parts = []
  if (firstTurn) {
    parts.push('PAGE STRUCTURE:\n' + trimOutline(obs.context, CONTEXT_BUDGET))
    parts.push(`ACTIONABLE ELEMENTS (${obs.mapTotal} total${obs.mapTotal > MAP_CAP ? ', first ' + MAP_CAP + ' — the rest via find' : ''}):\n` + JSON.stringify(obs.map))
  } else {
    parts.push('CHANGES SINCE YOUR LAST ACTION:\n' + JSON.stringify({ changed: obs.changed, changes: obs.changes, actionabilityDelta: obs.delta }))
  }
  if (extra) parts.push(extra)
  if (obs.unobservable.length) parts.push('UNOBSERVABLE REGIONS: ' + JSON.stringify(obs.unobservable))
  return parts.join('\n\n')
}

// ── Prompt + action schema ───────────────────────────────────────────────────────────
const hasOracle = (arm) => arm !== 'pixels'

const schemaFor = (arm) => ({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: hasOracle(arm)
        ? ['click', 'type', 'press_enter', 'scroll', 'goto', 'find', 'read', 'answer']
        : ['click', 'type', 'press_enter', 'scroll', 'goto', 'answer'],
    },
    ...(hasOracle(arm) ? { id: { type: 'string' }, query: { type: 'string' } } : {}),
    x: { type: 'number' }, y: { type: 'number' },
    text: { type: 'string' },
    url: { type: 'string' },
    dy: { type: 'number' },
    answer: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action', 'reason'],
  additionalProperties: false,
})

const RULES_BASE = `You are an agent operating a real web page with mouse and keyboard.
Reply with ONLY the JSON of your next action:`
const RULES_COMMON = `- type: types into the focused element (click the field first, in an earlier step).
- press_enter: submits the focused form.
- scroll: {dy} pixels (positive = down).
- goto: {url} navigates directly.
- answer: {answer} the final answer to the task, in the words the task asks for. Use it ONLY
  when the page in front of you supports it. If the task is unachievable, answer explaining why.
A click lands on whatever is ON TOP at that position: a covered element does not receive it.`

const rulesFor = (arm) => {
  if (arm === 'pixels') {
    return `${RULES_BASE}
- click: x,y = the element's centre in the screenshot.
${RULES_COMMON}`
  }
  const withIds = `${RULES_BASE}
- click: prefer id (from ACTIONABLE ELEMENTS, CHANGES or SEARCH RESULT — it auto-scrolls if needed); x,y only when you have no id (centre of a bbox [x,y,w,h]: x+w/2, y+h/2).
- find: {query} searches text across the WHOLE page — use it when what you need is not listed (the outline and map can be incomplete, and they tell you when they are).
- read: {id} returns the text around that element — use it to read values you must report.
${RULES_COMMON}`
  if (arm === 'oracle') return withIds
  return withIds + `
You have two channels: the SCREENSHOT is the authority on what is visible and where; the semantic data is the authority on occlusion, state, changes and what is off-screen. If they disagree on geometry, trust the screenshot.`
}

const mockDecide = (step, arm, task) => {
  const plan = hasOracle(arm)
    ? [{ action: 'scroll', dy: 400, reason: 'mock' }, { action: 'find', query: task.web_name.split(' ')[0], reason: 'mock' }, { action: 'answer', answer: 'mock answer', reason: 'mock' }]
    : [{ action: 'scroll', dy: 400, reason: 'mock' }, { action: 'scroll', dy: -200, reason: 'mock' }, { action: 'answer', answer: 'mock answer', reason: 'mock' }]
  return { decision: plan[Math.min(step, plan.length - 1)], inputTokens: 0, outputTokens: 0 }
}

/** Gemini's schema dialect has no additionalProperties; everything else carries over. */
const toGeminiSchema = (schema) => {
  const { additionalProperties: _drop, ...rest } = schema
  return rest
}

async function decideAnthropic(content, schema) {
  const res = await withRetry(() => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  }), 'model')
  const json = await res.json()
  const text = (json.content || []).map((c) => c.text || '').join('')
  return {
    decision: json.stop_reason === 'refusal' ? null : JSON.parse(text),
    inputTokens: json.usage?.input_tokens || 0,
    outputTokens: json.usage?.output_tokens || 0,
  }
}

async function decideGemini(content, schema) {
  // Same content, Gemini's wire shape: text parts stay text, image parts become inlineData.
  const parts = content.map((c) => (c.type === 'image'
    ? { inlineData: { mimeType: c.source.media_type, data: c.source.data } }
    : { text: c.text }))
  const res = await withRetry(() => fetch(`${GEMINI_BASE}/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
    }),
  }), 'model')
  const json = await res.json()
  const cand = json.candidates?.[0]
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('')
  return {
    // A blocked/empty candidate is a refusal, not a crash: the loop records it and moves on.
    decision: text ? JSON.parse(text) : null,
    inputTokens: json.usageMetadata?.promptTokenCount || 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount || 0,
  }
}

const decide = (content, schema) => (IS_GEMINI ? decideGemini(content, schema) : decideAnthropic(content, schema))

// ── Page plumbing ────────────────────────────────────────────────────────────────────
const newPage = (browser) => browser.newPage({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  bypassCSP: true,
  locale: 'en-US',
})

async function ensureSdk(page, sdk) {
  const has = await page.evaluate(() => typeof window.__agentInspect === 'function').catch(() => false)
  if (!has) { await page.addScriptTag({ content: sdk }).catch(() => {}); await page.waitForTimeout(300) }
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
  promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
})

// ── One attempt ──────────────────────────────────────────────────────────────────────
async function attempt(browser, task, arm, instruction, sdk) {
  const started = Date.now()
  const page = await newPage(browser)
  const out = { answer: '', status: 'maxSteps', steps: 0, tokensIn: 0, tokensOut: 0, trace: [], payload: [], error: null }
  try {
    await page.goto(task.web, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(4000)
    await page.addScriptTag({ content: sdk })

    let firstTurn = true
    let lastUrl = page.url()
    let extra = null
    const history = []

    for (let step = 0; step < MAX_STEPS; step++) {
      await ensureSdk(page, sdk)
      if (page.url() !== lastUrl) { firstTurn = true; lastUrl = page.url(); extra = null }

      const content = []
      let obs = null
      const previous = firstTurn ? null : await page.evaluate(() => window.__lastCp)
      if (arm === 'snap') {
        obs = await page.evaluate(inPageSnap, previous)
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: obs.src.split(',')[1] } })
      } else if (hasOracle(arm)) {
        obs = await page.evaluate(inPageObserve, previous)
      }
      if (arm === 'pixels' || arm === 'hybrid') {
        const shot = await page.screenshot({ type: 'jpeg', quality: 80 })
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.toString('base64') } })
      }

      const textParts = [rulesFor(arm), 'TASK: ' + instruction, 'CURRENT URL: ' + page.url(), `STEP ${step + 1} of ${MAX_STEPS}`]
      if (obs) textParts.push(oracleText(obs, firstTurn, extra))
      if (history.length) textParts.push('YOUR PREVIOUS ACTIONS:\n' + history.slice(-25).join('\n'))
      content.push({ type: 'text', text: textParts.join('\n\n') })

      // Per-turn payload shape: the only observability in --mock (no token counts), and
      // in a paid run the evidence of how the oracle's cost decays after the first turn.
      out.payload.push({
        step: step + 1,
        firstTurn,
        textChars: content.filter((c) => c.type === 'text').reduce((s, c) => s + c.text.length, 0),
        imageBytes: content.filter((c) => c.type === 'image').reduce((s, c) => s + c.source.data.length, 0),
      })

      const { decision, inputTokens, outputTokens } = MOCK
        ? mockDecide(step, arm, task)
        : await decide(content, schemaFor(arm))
      out.tokensIn += inputTokens; out.tokensOut += outputTokens
      out.steps++
      firstTurn = false
      extra = null
      if (!decision) { out.status = 'refusal'; break }
      history.push(JSON.stringify(decision))
      out.trace.push(decision)

      if (decision.action === 'answer') { out.answer = decision.answer || decision.reason || ''; out.status = 'success'; break }
      if (decision.action === 'find' && decision.query && hasOracle(arm)) {
        extra = 'SEARCH RESULT:\n' + JSON.stringify(await page.evaluate(inPageFind, decision.query))
        continue
      }
      if (decision.action === 'read' && decision.id && hasOracle(arm)) {
        extra = 'ELEMENT TEXT:\n' + JSON.stringify(await page.evaluate(inPageRead, decision.id))
        continue
      }
      if (decision.action === 'click') {
        let point = decision.id && hasOracle(arm) ? await page.evaluate(inPageLocate, decision.id) : null
        if (!point && decision.x != null) point = { x: decision.x, y: decision.y }
        if (point) await page.mouse.click(point.x, point.y).catch(() => {})
        else history.push(JSON.stringify({ harness: 'click with no resolvable id and no coordinates — not executed' }))
      }
      if (decision.action === 'type' && decision.text) await page.keyboard.insertText(decision.text)
      if (decision.action === 'press_enter') await page.keyboard.press('Enter')
      if (decision.action === 'scroll') await page.mouse.wheel(0, decision.dy || 600)
      if (decision.action === 'goto' && decision.url) {
        await page.goto(decision.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      }
      await page.waitForTimeout(2000)
    }

    // The judge sees the final screen for every arm, including the ones the model never
    // saw pixels of — same evidence for every arm, exactly as lumen judges.
    out.screenshot = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null)
    out.finalUrl = page.url()
  } catch (e) {
    out.error = String(e).slice(0, 300)
    out.status = 'error'
    out.screenshot = await page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null)
  }
  await page.close().catch(() => {})
  out.durationMs = Date.now() - started
  return out
}

/** Agent reasoning + actions, in the shape the judge prompt expects. */
const traceForJudge = (a) =>
  `Final answer: ${a.answer || '(none — agent did not answer)'}\nFinal URL: ${a.finalUrl || ''}\nStatus: ${a.status}\nActions taken (${a.steps} steps):\n` +
  a.trace.map((d, i) => `${i + 1}. ${JSON.stringify(d)}`).join('\n')

async function runTask(browser, task, arm, sdk) {
  let feedback = null
  const attempts = []
  for (let trial = 1; trial <= TRIALS; trial++) {
    let instruction = task.ques
    if (feedback && trial > 1) {
      instruction += `\n\n[IMPORTANT: A previous attempt at this task failed. The evaluator said: "${feedback}". Try a DIFFERENT approach this time.]`
    }
    let a
    try {
      a = await withTimeout(attempt(browser, task, arm, instruction, sdk), TASK_TIMEOUT_MS + 60000, task.id)
    } catch (e) {
      a = { answer: '', status: 'error', steps: 0, tokensIn: 0, tokensOut: 0, trace: [], error: String(e).slice(0, 300), durationMs: TASK_TIMEOUT_MS }
    }
    const verdict = MOCK
      ? { pass: false, reason: 'mock run — judge skipped' }
      : await judge(task.ques, traceForJudge(a), a.screenshot)
    attempts.push({ trial, ...a, screenshot: undefined, judgePass: verdict.pass, judgeReason: verdict.reason })
    if (verdict.pass || trial === TRIALS) break
    feedback = verdict.reason
    process.stdout.write(`  [retry ${trial}/${TRIALS}] `)
  }
  const last = attempts[attempts.length - 1]
  return {
    id: task.id, web_name: task.web_name, question: task.ques, startUrl: task.web, arm,
    agentResult: last.answer, agentStatus: last.status, finalUrl: last.finalUrl,
    steps: last.steps, tokens: last.tokensIn + last.tokensOut,
    tokensIn: last.tokensIn, tokensOut: last.tokensOut, durationMs: last.durationMs,
    judgePass: last.judgePass, judgeReason: last.judgeReason, trial: last.trial,
    pass1: attempts[0].judgePass,
    stepsAllTrials: attempts.reduce((s, a) => s + a.steps, 0),
    tokensInAllTrials: attempts.reduce((s, a) => s + a.tokensIn, 0),
    tokensOutAllTrials: attempts.reduce((s, a) => s + a.tokensOut, 0),
    tokensAllTrials: attempts.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
    durationAllTrialsMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: last.error ?? undefined,
    attempts: attempts.map((a) => ({ trial: a.trial, status: a.status, steps: a.steps, judgePass: a.judgePass, judgeReason: a.judgeReason, answer: a.answer, trace: a.trace, payload: a.payload })),
  }
}

// ── Report ───────────────────────────────────────────────────────────────────────────
function summarize(arm, results) {
  const ok = results.filter((r) => !r.error)
  const avg = (fn) => (ok.length ? ok.reduce((s, r) => s + fn(r), 0) / ok.length : 0)
  const tIn = results.reduce((s, r) => s + r.tokensInAllTrials, 0)
  const tOut = results.reduce((s, r) => s + r.tokensOutAllTrials, 0)
  return {
    timestamp: new Date().toISOString(),
    framework: `snapdom-agent:${arm}`, arm, model: MODEL, judgeModel: JUDGE_MODEL(),
    trials: TRIALS, maxSteps: MAX_STEPS,
    total: results.length,
    passed: results.filter((r) => r.judgePass).length,
    passRate: results.length ? results.filter((r) => r.judgePass).length / results.length : 0,
    passed1: results.filter((r) => r.pass1).length,
    passRate1: results.length ? results.filter((r) => r.pass1).length / results.length : 0,
    avgSteps: Math.round(avg((r) => r.steps) * 10) / 10,
    avgTokens: Math.round(avg((r) => r.tokens)),
    avgDurationMs: Math.round(avg((r) => r.durationMs)),
    avgStepsAllTrials: Math.round(avg((r) => r.stepsAllTrials) * 10) / 10,
    avgTokensAllTrials: Math.round(avg((r) => r.tokensAllTrials)),
    usdAllTrials: usd(MODEL, tIn, tOut),
    results,
  }
}

// ── Dry run: reachability + payload + budget, no model spend ──────────────────────────
async function dry(browser, sdk) {
  const IMG_TOKENS = Math.round((1280 * 800) / 750)
  const rows = []
  for (const task of TASKS) {
    const row = { id: task.id, site: task.web_name }
    const page = await newPage(browser)
    try {
      const res = await page.goto(task.web, { waitUntil: 'domcontentloaded', timeout: 60000 })
      row.httpStatus = res ? res.status() : null
      await page.waitForTimeout(4000)
      await page.addScriptTag({ content: sdk })
      const obs = await page.evaluate(inPageObserve, null)
      row.mapTotal = obs.mapTotal
      const oracleTok = Math.round(oracleText(obs, true).length / 4)
      row.tokens = { pixels_first: IMG_TOKENS, oracle_first: oracleTok, hybrid_first: IMG_TOKENS + oracleTok }
      const title = await page.title()
      row.title = title.slice(0, 60)
      row.blocked = /captcha|robot|unusual traffic|access denied|are you a human/i.test(title + ' ' + obs.context.slice(0, 4000))
    } catch (e) {
      row.error = String(e).slice(0, 140)
    }
    await page.close().catch(() => {})
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  const measured = rows.filter((r) => r.tokens)
  const prompt = 600
  const est = {}
  for (const arm of ['pixels', 'oracle', 'hybrid']) {
    let inTok = 0, outTok = 0
    for (const r of measured) {
      const first = r.tokens[arm + '_first']
      // steady-state step: same channel again (oracle steps are diffs, ~10x smaller than
      // the first turn, so this is deliberately conservative for the oracle arms).
      const perStep = arm === 'pixels' ? IMG_TOKENS + prompt
        : arm === 'oracle' ? Math.round(first / 3) + prompt
          : IMG_TOKENS + Math.round(first / 3) + prompt
      inTok += TRIALS * (first + prompt + (MAX_STEPS - 1) * perStep)
      outTok += TRIALS * MAX_STEPS * 150
    }
    est[arm] = { worstCaseUsd: usd(MODEL, inTok, outTok), note: `${measured.length} tasks × ${TRIALS} trials × ${MAX_STEPS} steps (upper bound: no task ends early)` }
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'dry.json'), JSON.stringify({ model: MODEL, trials: TRIALS, maxSteps: MAX_STEPS, rows, budgetUsd: est }, null, 2))
  console.log('\nWorst-case budget per arm:\n' + JSON.stringify(est, null, 1))
  console.log(`blocked/failed: ${rows.filter((r) => r.blocked || r.error).map((r) => r.id).join(', ') || 'none'}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────────────
const SDK = await (async () => {
  const esbuild = await import('esbuild')
  const entry = join(HERE, '.sdk-entry.mjs')
  await writeFile(entry, `import { inspect } from '${join(AGENT, 'src/index.js')}'
import { agentOracle } from '${join(AGENT, 'src/plugin.js')}'
import { snapdom } from '${join(REPO, 'src/api/snapdom.js')}'
window.__agentInspect = inspect
window.__agentOracle = agentOracle
window.__snapdom = snapdom
`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
})()

const browser = await chromium.launch({ headless: HEADLESS })
if (DRY) { await dry(browser, SDK); await browser.close(); process.exit(0) }

await mkdir(OUT, { recursive: true })
const stamp = Date.now()
for (const arm of ARMS) {
  const results = []
  console.log(`\n=== arm ${arm} · ${TASKS.length} tasks · model ${MODEL} · judge ${JUDGE_MODEL()} · trials ${TRIALS} · maxSteps ${MAX_STEPS} ===`)
  const outFile = join(OUT, `webvoyager-${arm}-${MODEL}${TAG ? '-' + TAG : ''}-${stamp}.json`)
  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i]
    process.stdout.write(`[${i + 1}/${TASKS.length}] ${task.id} (${task.web_name})... `)
    const r = await runTask(browser, task, arm, SDK)
    results.push(r)
    console.log(`[${r.judgePass ? 'PASS' : 'FAIL'}${r.trial > 1 ? ` (trial ${r.trial})` : ''}] steps=${r.steps} tokens=${r.tokens.toLocaleString()} time=${(r.durationMs / 1000).toFixed(1)}s`)
    if (!r.judgePass) console.log(`    ${r.judgeReason.slice(0, 140)}`)
    await writeFile(outFile, JSON.stringify(summarize(arm, results), null, 2))
  }
  const s = summarize(arm, results)
  console.log(`\n${arm}: ${s.passed}/${s.total} (pass@1 ${s.passed1}/${s.total}) · avgSteps ${s.avgSteps} · avgTokens ${s.avgTokens.toLocaleString()} · avgTime ${(s.avgDurationMs / 1000).toFixed(1)}s · spend $${s.usdAllTrials}`)
  console.log(`saved ${outFile}`)
}
await browser.close()
