/**
 * Phase-5, layer 3 — END-TO-END AGENT LOOP (act → observe → act). Requires a key.
 *
 *   node packages/agent/experiment/loop.mjs [--reps 5] [--model claude-opus-5] [--steps 4]
 *
 * The single-observation harness (harness.mjs) measures COMPREHENSION per observation.
 * This measures what the spec actually asks for: does the arm's observation make an
 * agent finish the task, in fewer actions, without clicking things it cannot click?
 *
 * The task is built so that the decisive fact is GEOMETRIC and has no markup
 * representation: a fixed-position banner overlaps the goal button. Two dismissable
 * overlays exist and only ONE of them covers anything, so an arm that cannot see
 * occlusion has to guess which — while arm B is told outright.
 *
 * Actions are executed as real coordinate clicks (`mouse.click` at the element's
 * centre), never Playwright's actionability-checked `element.click()`: an agent aiming
 * at a covered button really does hit whatever is on top, and that miss is the metric.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { usd } from './cost.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def
}
const REPS = Number(flag('reps', 5))
const MODEL = String(flag('model', 'claude-opus-5'))
const MAX_STEPS = Number(flag('steps', 4))
const KEY = process.env.ANTHROPIC_API_KEY
// --dry spends nothing: it prints the first observation of each arm plus the geometric
// facts the task turns on, so the fixture can be validated before any paid run.
const DRY = flag('dry', false) === true
if (!KEY && !DRY) { console.error('[loop] ANTHROPIC_API_KEY required — this layer is the model in the loop.'); process.exit(1) }

const GOAL = 'Save the document.'

/**
 * The app. `#save` sits at the bottom of the page; the bottom banner overlaps it once
 * raised, the top promo bar overlaps nothing. Neither overlap is derivable from markup.
 */
const APP = `
  <style>
    body { font-family: system-ui; margin: 0; padding: 16px; }
    .bar { position: fixed; left: 0; right: 0; background: #1b1b1b; color: #fff;
           padding: 14px 16px; display: flex; gap: 12px; align-items: center; z-index: 50; }
    #promo { top: 0; transform: translateY(-100%); }
    #cookies { bottom: 0; min-height: 110px; align-items: flex-start; transform: translateY(100%); }
    /* On the ids: an id selector outranks .bar.up, so a class-only raised state loses. */
    #promo.up, #cookies.up { transform: translateY(0); }
    #actions { position: absolute; top: 700px; left: 16px; display: flex; gap: 8px; }
  </style>
  <h1>Documento</h1>
  <p data-testid="status">Borrador sin guardar</p>
  <div id="actions">
    <button data-testid="save">Guardar</button>
    <button data-testid="discard">Descartar</button>
  </div>
  <div class="bar" id="promo">
    <span>Probá la versión Pro gratis por 30 días.</span>
    <button data-testid="promo-close">No, gracias</button>
  </div>
  <div class="bar" id="cookies">
    <span>Usamos cookies para mejorar tu experiencia.</span>
    <button data-testid="cookies-accept">Aceptar</button>
  </div>
  <script>
    window.__saved = false
    window.__clicks = []
    document.addEventListener('click', (e) => {
      const el = e.target.closest('button') || e.target
      window.__clicks.push({ testid: el.getAttribute && el.getAttribute('data-testid') || null, tag: el.localName })
    }, true)
    document.querySelector('[data-testid=save]').addEventListener('click', () => {
      window.__saved = true
      document.querySelector('[data-testid=status]').textContent = 'Guardado'
    })
    document.querySelector('[data-testid=discard]').addEventListener('click', () => {
      document.querySelector('[data-testid=status]').textContent = 'Descartado'
    })
    document.querySelector('[data-testid=promo-close]').addEventListener('click', () => document.getElementById('promo').classList.remove('up'))
    document.querySelector('[data-testid=cookies-accept]').addEventListener('click', () => document.getElementById('cookies').classList.remove('up'))
    // Both overlays are already raised before the agent's first observation.
    document.getElementById('promo').classList.add('up')
    document.getElementById('cookies').classList.add('up')
  </script>`

const PROMPT = `You are an in-page UI agent. GOAL: ${GOAL}
You act by clicking exactly one element per turn. Reply with:
- action: "click" to click an element, or "done" if the goal is already accomplished.
- target: the visible label or test id of the element to click (ignored when action is "done").
- reason: one short sentence.
A click is delivered to whatever is topmost at that element's position, so clicking an element that something else covers does nothing.`

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'done'] },
    target: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action', 'target', 'reason'],
  additionalProperties: false,
}

async function decide(content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000, fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ACTION_SCHEMA } },
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

/** Same resolver for every arm: test id first, then visible label (case-insensitive). */
const RESOLVE = (want) => {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]+/gi, ' ').replace(/\s+/g, ' ').trim()
  const w = norm(want)
  if (!w) return null
  const els = [...document.querySelectorAll('button, a[href], input, [role=button]')]
  return els.find((el) => norm(el.getAttribute('data-testid')) === w)
    || els.find((el) => norm(el.textContent) === w)
    || els.find((el) => w.includes(norm(el.getAttribute('data-testid'))) && el.getAttribute('data-testid'))
    || els.find((el) => norm(el.textContent) && w.includes(norm(el.textContent)))
    || els.find((el) => norm(el.textContent) && norm(el.textContent).includes(w))
    || null
}

async function runArm(browser, sdk, arm, rep) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${APP}</body>`)
  await page.addScriptTag({ content: sdk })
  await page.evaluate(`window.__resolveTarget = ${RESOLVE.toString()}`)
  await page.waitForTimeout(80)

  const history = []
  let tokensIn = 0, tokensOut = 0, invalidClicks = 0, refused = false
  let steps = 0
  // The decisive metric: actions spent BEFORE the goal was reached. Total actions are
  // also reported, but an agent that keeps poking after success would otherwise mask the
  // difference between reaching the goal in two moves and stumbling into it in four.
  let actionsToSuccess = null

  for (; steps < MAX_STEPS; steps++) {
    const shot = arm === 'A' ? await page.screenshot() : null
    const obs = arm === 'A' ? null : await page.evaluate((a) => window.__observe(a), arm)

    const content = []
    if (shot) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot.toString('base64') } })
    const label = arm === 'A' ? 'Evidence: a screenshot of the page as it is now.'
      : arm === 'B' ? 'Evidence (post-layout interactive map + what changed since your last observation):'
        : 'Evidence (markup-level element list + mutation log since your last observation):'
    content.push({
      type: 'text',
      text: `${PROMPT}\n\n${label}\n${obs === null ? '' : JSON.stringify(obs, null, 1)}\n\n` +
        `Actions you have already taken this session: ${history.length ? history.join('; ') : 'none'}`,
    })

    const { decision, inputTokens, outputTokens } = await decide(content)
    tokensIn += inputTokens; tokensOut += outputTokens
    if (!decision) { refused = true; break }
    if (decision.action === 'done') { history.push('declared done'); break }

    const hit = await page.evaluate((want) => {
      const el = window.__resolveTarget(want)
      if (!el) return { resolved: false }
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
      const top = onScreen ? document.elementFromPoint(x, y) : null
      const topBtn = top && top.closest ? (top.closest('button') || top) : top
      return {
        resolved: true, x, y, onScreen,
        wanted: el.getAttribute('data-testid'),
        topmost: topBtn && topBtn.getAttribute ? topBtn.getAttribute('data-testid') : null,
      }
    }, decision.target)

    if (!hit.resolved) { history.push(`tried to click "${decision.target}" — no such element`); continue }
    if (!hit.onScreen) {
      // Aiming at an element that has been scrolled or translated out of the viewport is
      // as wasted as aiming at a covered one; don't dispatch a click at those coordinates.
      invalidClicks++
      history.push(`clicked "${decision.target}" (off-screen)`)
      continue
    }
    await page.mouse.click(hit.x, hit.y)
    // The click landed on whatever was topmost — that is the honest failure mode.
    if (hit.topmost !== hit.wanted) invalidClicks++
    history.push(`clicked "${decision.target}"`)
    await page.waitForTimeout(80)
    if (actionsToSuccess === null && await page.evaluate(() => window.__saved === true)) {
      actionsToSuccess = history.length
    }
  }

  const saved = await page.evaluate(() => window.__saved === true)
  const clicks = await page.evaluate(() => window.__clicks)
  await page.close()
  return { arm, rep, saved, steps: history.length, actionsToSuccess, invalidClicks, refused, history, clicks, tokensIn, tokensOut }
}

async function dryRun(browser, sdk) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${APP}</body>`)
  await page.addScriptTag({ content: sdk })
  await page.waitForTimeout(120)
  const geometry = await page.evaluate(() => ['save', 'discard', 'promo-close', 'cookies-accept'].map((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    const r = el.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
    const top = document.elementFromPoint(x, y)
    return { id, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], topmostAtCentre: top && (top.getAttribute('data-testid') || top.id || top.localName) }
  }))
  const B = await page.evaluate(() => window.__observe('B'))
  const C = await page.evaluate(() => window.__observe('C'))
  await page.close()
  console.log(JSON.stringify({ geometry, B, C }, null, 1))
}

async function run() {
  await mkdir(OUT, { recursive: true })
  const sdk = await bundleSdk()
  const browser = await chromium.launch()
  if (DRY) { await dryRun(browser, sdk); await browser.close(); return }
  const rows = []
  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of ['A', 'B', 'C']) rows.push(await runArm(browser, sdk, arm, rep))
  }
  await browser.close()

  const byArm = {}
  for (const arm of ['A', 'B', 'C']) {
    const mine = rows.filter((r) => r.arm === arm)
    const done = mine.filter((r) => r.saved)
    const tIn = mine.reduce((a, r) => a + r.tokensIn, 0)
    const tOut = mine.reduce((a, r) => a + r.tokensOut, 0)
    byArm[arm] = {
      n: mine.length,
      taskSuccess: +(done.length / mine.length).toFixed(2),
      meanActionsToSuccess: done.length ? +(done.reduce((a, r) => a + r.actionsToSuccess, 0) / done.length).toFixed(2) : null,
      optimalRuns: done.filter((r) => r.actionsToSuccess === 2).length, // dismiss the covering bar, then save
      meanTotalActions: +(mine.reduce((a, r) => a + r.steps, 0) / mine.length).toFixed(2),
      invalidClicks: mine.reduce((a, r) => a + r.invalidClicks, 0),
      refusals: mine.filter((r) => r.refused).length,
      meanInputTokens: Math.round(tIn / mine.length),
      usd: usd(MODEL, tIn, tOut),
    }
  }
  const summary = { model: MODEL, reps: REPS, maxSteps: MAX_STEPS, goal: GOAL, byArm, totalUsd: +['A', 'B', 'C'].reduce((a, k) => a + byArm[k].usd, 0).toFixed(4) }
  await writeFile(join(OUT, 'loop-raw.json'), JSON.stringify({ summary, rows }, null, 1))
  await writeFile(join(OUT, 'loop-summary.json'), JSON.stringify(summary, null, 1))
  console.log(JSON.stringify(summary, null, 1))
}

/** One page script: the SDK plus each arm's observation function. */
async function bundleSdk() {
  const esbuild = await import('esbuild')
  const entry = join(OUT, '.loop-entry.mjs')
  await writeFile(entry, `
import { inspect } from '${join(HERE, '..', 'src', 'index.js').replace(/\\/g, '/')}'
import { startArmC } from '${join(HERE, 'arms.mjs').replace(/\\/g, '/')}'
let prev = null, cArm = null
window.__observe = async (arm) => {
  if (arm === 'B') {
    const ui = await inspect(document.body, prev ? { previous: prev } : {})
    const out = {
      interactive: ui.agentMap.map.map((e) => ({ name: e.n, role: e.r, box: e.b, covered: e.covered || false, coveredBy: e.coveredBy })),
      changesSinceLastObservation: prev ? ui.changes : 'first observation',
      actionabilityDelta: prev ? ui.actionabilityDelta : undefined,
    }
    prev = ui.checkpoint()
    return out
  }
  // Arm C: markup only — the element list carries no layout, no stacking, no occlusion.
  const list = [...document.querySelectorAll('button, a[href], input, [role=button]')].map((el) => ({
    name: (el.textContent || '').trim(), role: el.getAttribute('role') || el.localName,
    testid: el.getAttribute('data-testid') || undefined,
    disabled: el.hasAttribute('disabled') || undefined,
    hidden: el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || undefined,
  }))
  const mutations = cArm ? cArm.finish().payload : 'first observation'
  cArm = startArmC(document.body)
  return { interactive: list, mutationsSinceLastObservation: mutations }
}
`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
}

run().catch((e) => { console.error(e); process.exit(1) })
