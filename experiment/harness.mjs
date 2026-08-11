/**
 * Phase-5, layer 2 — MODEL IN THE LOOP (gated on ANTHROPIC_API_KEY).
 *
 * Playwright orchestrates all three arms; arm B runs in-page via the injected SDK, arm C
 * via an in-page MutationObserver + a11y diff (no post-render signals), arm A ships
 * before/after PNGs. Same model, equivalent prompts, same tasks.
 *
 *   node experiment/harness.mjs [--reps 5] [--model claude-opus-5]
 *
 * Without a key it runs in --dry mode: every arm still executes and every mechanical
 * metric (payload bytes, invalid-click detection, change-detection FP/FN, latency) is
 * recorded; only the model-dependent metrics (task success, action count) are skipped
 * and reported as blocked. Layer 1 (experiment/signal.test.js) covers the information
 * question without a model at all.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { scoreVerdict } from './verdict.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def
}
const REPS = Number(flag('reps', 5))
const MODEL = String(flag('model', 'claude-opus-5'))
const KEY = process.env.ANTHROPIC_API_KEY
const DRY = !KEY || flag('dry', false) === true
const DUMP = flag('dump', false) === true
/** Anthropic first-party rates, USD per million tokens: [input, output]. */
const PRICES = {
  'claude-opus-5': [5, 25], 'claude-fable-5': [10, 50], 'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5],
}

/* ── Apps: corpus-derived, one per failure mode the strata care about ─────────── */
const APPS = {
  'remount-spa': `
    <div id="app">
      <h1>Pedidos</h1>
      <button data-testid="refresh">Refrescar</button>
      <ul id="list">
        <li>Pedido 1 · pendiente</li>
        <li>Pedido 2 · pendiente</li>
        <li>Pedido 3 · pendiente</li>
      </ul>
    </div>
    <script>
      // A "framework" that rerenders the whole subtree with new class names on refresh,
      // optionally flipping one order's status.
      let gen = 0
      document.querySelector('[data-testid=refresh]').addEventListener('click', () => {
        gen++
        const flip = window.__flipOne === true
        document.getElementById('list').outerHTML =
          '<ul id="list">' + [1, 2, 3].map((i) =>
            '<li class="g' + gen + '">Pedido ' + i + ' · ' +
            (flip && i === 2 ? 'enviado' : 'pendiente') + '</li>').join('') + '</ul>'
      })
    </script>`,
  'modal-flow': `
    <button data-testid="save">Guardar</button>
    <button data-testid="delete">Borrar</button>
    <p>Documento sin guardar</p>
    <script>
      document.querySelector('[data-testid=delete]').addEventListener('click', () => {
        const m = document.createElement('div')
        m.setAttribute('role','dialog'); m.setAttribute('aria-label','Confirmar borrado')
        m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99;display:flex;align-items:center;justify-content:center'
        m.innerHTML = '<div style="background:#fff;padding:20px"><p>¿Seguro?</p><button data-testid="confirm">Sí</button></div>'
        document.body.appendChild(m)
      })
    </script>`,
  'canvas-dashboard': `
    <h2>Métricas</h2>
    <canvas id="chart" width="300" height="120"></canvas>
    <button data-testid="redraw">Redibujar</button>
    <script>
      const c = document.getElementById('chart').getContext('2d')
      let hue = 10
      const draw = () => { hue = (hue + 90) % 360; c.fillStyle = 'hsl(' + hue + ',70%,50%)'; c.fillRect(0,0,300,120) }
      draw()
      document.querySelector('[data-testid=redraw]').addEventListener('click', draw)
    </script>`,
  'live-noise': `
    <p data-testid="clock">Actualizado 00:00:00</p>
    <button data-testid="toggle">Activar alertas</button>
    <span data-testid="alerts">alertas: off</span>
    <script>
      let t = 0
      setInterval(() => { t++; document.querySelector('[data-testid=clock]').textContent =
        'Actualizado ' + String(Math.floor(t/60)).padStart(2,'0') + ':' + String(t%60).padStart(2,'0') + ':00' }, 100)
      document.querySelector('[data-testid=toggle]').addEventListener('click', () => {
        document.querySelector('[data-testid=alerts]').textContent = 'alertas: on'
      })
    </script>`,
}

/**
 * Tasks: each names the app, the action to perform, and the GROUND TRUTH about what
 * changed — so change-detection false positives/negatives are measurable mechanically,
 * independent of any model.
 */
const TASKS = [
  { id: 'modal-covers', app: 'modal-flow', click: '[data-testid="delete"]',
    // Either identifier counts: a caller may cite the test id or the visible label.
    truth: { userVisibleChange: true, mustReportCovered: [['save', 'guardar'], ['delete', 'borrar']] },
    stratum: 'occlusion' },
  { id: 'remount-noop', app: 'remount-spa', click: '[data-testid="refresh"]',
    truth: { userVisibleChange: false }, stratum: 'replaced node' },
  { id: 'remount-real-change', app: 'remount-spa', click: '[data-testid="refresh"]',
    setup: 'window.__flipOne = true', truth: { userVisibleChange: true },
    stratum: 'replaced node' },
  { id: 'canvas-redraw', app: 'canvas-dashboard', click: '[data-testid="redraw"]',
    truth: { userVisibleChange: true, onlyPixels: true }, stratum: 'canvas' },
  { id: 'live-clock-only', app: 'live-noise', click: null, waitMs: 400,
    truth: { userVisibleChange: false }, stratum: 'pure noise' },
  { id: 'live-toggle', app: 'live-noise', click: '[data-testid="toggle"]',
    truth: { userVisibleChange: true }, stratum: 'semantic-small' },
]

/**
 * The verdict shape, enforced server-side. With structured outputs the answer always
 * parses, so a malformed reply can never be miscounted as a wrong answer.
 */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    userVisibleChange: { type: 'boolean' },
    nowUnclickable: { type: 'array', items: { type: 'string' } },
    understandable: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['userVisibleChange', 'nowUnclickable', 'understandable', 'summary'],
  additionalProperties: false,
}

/** Set false once if the account rejects the server-side-fallback beta (see run()). */
let FALLBACKS = true

async function callModel(prompt, imageParts) {
  const body = {
    model: MODEL,
    // Thinking is ON by default on Claude Opus 5 and shares this budget with the answer:
    // the old 400 truncated every reply mid-thought. `effort: low` keeps it short.
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: [...(imageParts || []), { type: 'text', text: prompt }] }],
    ...(FALLBACKS ? { fallbacks: 'default' } : {}),
  }
  const headers = {
    'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
    ...(FALLBACKS ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
  }
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  const text = (json.content || []).map((c) => c.text || '').join('\n')
  return {
    text,
    // A safety decline is not a wrong answer — it is a missing answer, counted separately.
    refused: json.stop_reason === 'refusal',
    servedBy: json.model,
    inputTokens: json.usage?.input_tokens ?? null,
    outputTokens: json.usage?.output_tokens ?? null,
    latencyMs: Date.now() - t0,
  }
}

const QUESTION = `You are a UI agent observing a web page across one user action. Using ONLY the evidence below, answer:
- userVisibleChange: did anything change that a user would care about? It is false for class-name churn, a ticking clock, scrolling, or a re-render that produces identical UI.
- nowUnclickable: elements a user could click before the action and cannot click now (for example, because something is covering them). Identify them as specifically as the evidence allows; [] if none.
- understandable: true if this evidence lets you interpret everything that changed. false if any region that may have changed is opaque to you — content you cannot read from this evidence.
- summary: one sentence.`

async function run() {
  await mkdir(OUT, { recursive: true })
  const sdk = await bundleSdk()
  const browser = await chromium.launch()
  const rows = []

  for (const task of TASKS) {
    for (let rep = 0; rep < REPS; rep++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.setContent(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:16px">${APPS[task.app]}</body>`)
      await page.addScriptTag({ content: sdk })
      if (task.setup) await page.evaluate(task.setup)
      await page.waitForTimeout(60)

      const shotBefore = await page.screenshot()
      await page.evaluate(() => window.__agentPrepare())
      if (task.click) await page.click(task.click)
      if (task.waitMs) await page.waitForTimeout(task.waitMs)
      await page.waitForTimeout(60)
      const payloads = await page.evaluate(() => window.__agentCollect())
      const shotAfter = await page.screenshot()

      const row = {
        task: task.id, stratum: task.stratum, rep,
        truth: task.truth,
        bytes: {
          A: shotBefore.length + shotAfter.length,
          B: payloads.B.bytes,
          C: payloads.C.bytes,
        },
        // Mechanical (model-free) verdicts. IMPORTANT: the question is the STRATUM's
        // question, not a generic "did anything change" — otherwise arm C scores free
        // points on occlusion (a modal insertion IS a mutation, so "changed" is trivially
        // right while saying nothing about which buttons became unclickable).
        mechanical: {
          B: { saysChanged: payloads.B.payload.changed, reportedCovered: payloads.B.payload.actionabilityDelta?.becameCovered?.length || 0, flagsCanvas: payloads.B.flagsCanvas },
          C: { saysChanged: (payloads.C.payload.mutations || []).length > 0 || (payloads.C.payload.a11yDiff || []).length > 0, reportedCovered: 0, flagsCanvas: JSON.stringify(payloads.C.payload).includes('semanticsAvailable') },
        },
      }
      for (const arm of ['B', 'C']) {
        const m = row.mechanical[arm]
        if (task.truth.mustReportCovered) {
          // Occlusion: the answer is WHICH elements stopped being clickable.
          m.correct = m.reportedCovered >= task.truth.mustReportCovered.length
        } else if (task.truth.onlyPixels) {
          // Canvas: DOM signals cannot answer, and pretending otherwise would be the bug
          // (§9). The right answer is to FLAG the region as semantics-unavailable so the
          // caller knows to rasterize it.
          m.correct = m.flagsCanvas === true
        } else {
          m.correct = m.saysChanged === task.truth.userVisibleChange
        }
      }

      if (!DRY) {
        const b64 = (buf) => buf.toString('base64')
        row.model = {}
        row.model.A = await callModel(`${QUESTION}\n\nEvidence: the two screenshots above (before, after).`, [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(shotBefore) } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(shotAfter) } },
        ])
        row.model.B = await callModel(`${QUESTION}\n\nEvidence (structured change report):\n${JSON.stringify(payloads.B.payload, null, 1)}`)
        row.model.C = await callModel(`${QUESTION}\n\nEvidence (mutation log + accessibility-tree diff):\n${JSON.stringify(payloads.C.payload, null, 1)}`)
        for (const arm of ['A', 'B', 'C']) {
          const m = row.model[arm]
          // Structured outputs guarantee the shape; a refusal is the only empty case.
          m.parsed = m.refused ? null : JSON.parse(m.text)
          m.score = m.parsed ? scoreVerdict(m.parsed, task.truth) : null
          m.correct = m.score ? m.score.changeCorrect : false
        }
      }
      // --dump: write each arm's evidence to disk, blinded, so an external judge (any
      // model, any transport) can be scored without this process holding a key.
      if (DUMP) {
        const base = join(OUT, 'evidence', `${task.id}__rep${rep}`)
        await mkdir(base, { recursive: true })
        await writeFile(join(base, 'before.png'), shotBefore)
        await writeFile(join(base, 'after.png'), shotAfter)
        await writeFile(join(base, 'armB.json'), JSON.stringify(payloads.B.payload, null, 1))
        await writeFile(join(base, 'armC.json'), JSON.stringify(payloads.C.payload, null, 1))
        // Ground truth is written SEPARATELY so a judge prompt can never include it.
        await writeFile(join(base, '_truth.json'), JSON.stringify({ task: task.id, stratum: task.stratum, truth: task.truth }, null, 1))
      }
      rows.push(row)
      await page.close()
    }
  }
  await browser.close()

  const summary = summarize(rows)
  await writeFile(join(OUT, 'raw.json'), JSON.stringify({ dry: DRY, model: MODEL, reps: REPS, rows }, null, 1))
  await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1))
  console.log(JSON.stringify(summary, null, 1))
  if (DRY) {
    console.log('\n[harness] DRY MODE: no ANTHROPIC_API_KEY — mechanical metrics recorded, model-in-the-loop metrics BLOCKED.')
    console.log('[harness] Set ANTHROPIC_API_KEY and re-run for task success / action count / token cost per arm.')
  }
}

function summarize(rows) {
  const byArm = { A: {}, B: {}, C: {} }
  for (const arm of ['A', 'B', 'C']) {
    const bytes = rows.map((r) => r.bytes[arm])
    byArm[arm].meanPayloadBytes = Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)
    if (arm !== 'A') {
      const mech = rows.map((r) => r.mechanical[arm])
      byArm[arm].mechanicalAccuracy = +(mech.filter((m) => m.correct).length / mech.length).toFixed(2)
      byArm[arm].falsePositives = mech.filter((m, i) => m.saysChanged && !rows[i].truth.userVisibleChange).length
      // Canvas tasks are DOM-invisible BY DESIGN (§9): counting them as false negatives
      // would be dishonest bookkeeping — they are reported separately, together with
      // whether the arm flagged the region as semantics-unavailable.
      const fnRows = mech.map((m, i) => ({ m, r: rows[i] })).filter(({ m, r }) => !m.saysChanged && r.truth.userVisibleChange)
      byArm[arm].falseNegatives = fnRows.filter(({ r }) => !r.truth.onlyPixels).length
      byArm[arm].canvasBlind = fnRows.filter(({ r }) => r.truth.onlyPixels).length
      byArm[arm].canvasFlagged = fnRows.filter(({ m, r }) => r.truth.onlyPixels && m.flagsCanvas).length
    } else {
      byArm.A.mechanicalAccuracy = null // pixels carry no structured answer
    }
    if (rows[0].model) {
      const ms = rows.map((r) => r.model[arm])
      // Pair each verdict with its own row: a refusal drops out, so positional indexing
      // into `rows` would silently misalign the false-positive/negative split.
      const scored = rows.map((r) => ({ v: r.model[arm], truth: r.truth })).filter((p) => p.v.score)
      const occl = scored.filter((p) => p.v.score.occlusionCorrect !== undefined)
      const canv = scored.filter((p) => p.v.score.canvasHonest !== undefined)
      const pct = (n, d) => (d ? +(n / d).toFixed(2) : null)
      const [pIn, pOut] = PRICES[MODEL] || [0, 0]
      const tIn = ms.reduce((a, m) => a + (m.inputTokens || 0), 0)
      const tOut = ms.reduce((a, m) => a + (m.outputTokens || 0), 0)
      byArm[arm].model = {
        n: ms.length,
        refusals: ms.filter((m) => m.refused).length,
        changeAccuracy: pct(scored.filter((p) => p.v.score.changeCorrect).length, scored.length),
        falsePositives: scored.filter((p) => !p.v.score.changeCorrect && p.truth.userVisibleChange === false).length,
        falseNegatives: scored.filter((p) => !p.v.score.changeCorrect && p.truth.userVisibleChange === true).length,
        occlusionIdentified: pct(occl.filter((p) => p.v.score.occlusionCorrect).length, occl.length),
        occlusionNamed: pct(occl.filter((p) => p.v.score.namedThem).length, occl.length),
        canvasHonesty: pct(canv.filter((p) => p.v.score.canvasHonest).length, canv.length),
        meanInputTokens: Math.round(tIn / ms.length),
        meanOutputTokens: Math.round(tOut / ms.length),
        meanLatencyMs: Math.round(ms.reduce((a, m) => a + m.latencyMs, 0) / ms.length),
        usd: +((tIn / 1e6) * pIn + (tOut / 1e6) * pOut).toFixed(4),
      }
    }
  }
  // Per stratum, on the stratum's own question — mechanically for B/C, and with the model
  // in the loop for all three arms when a key was present.
  const strata = {}
  for (const r of rows) {
    const s = (strata[r.stratum] ||= { mechanical: { B: 0, C: 0 }, n: 0 })
    s.n++
    if (r.mechanical.B.correct) s.mechanical.B++
    if (r.mechanical.C.correct) s.mechanical.C++
    if (r.model) {
      const m = (s.model ||= { A: 0, B: 0, C: 0 })
      for (const arm of ['A', 'B', 'C']) if (r.model[arm].score?.stratumCorrect) m[arm]++
    }
  }
  const totalUsd = +['A', 'B', 'C'].reduce((a, arm) => a + (byArm[arm].model?.usd || 0), 0).toFixed(4)
  return { dry: DRY, model: MODEL, totalUsd, byArm, strata }
}

/** Bundle the SDK + arms into one page script (esbuild is already a repo dep). */
async function bundleSdk() {
  const esbuild = await import('esbuild')
  const entry = join(OUT, '.entry.mjs')
  await writeFile(entry, `
import { inspect } from '${join(HERE, '..', 'src', 'index.js').replace(/\\/g, '/')}'
import { startArmC, armB } from '${join(HERE, 'arms.mjs').replace(/\\/g, '/')}'
let cp = null, cArm = null
window.__agentPrepare = async () => {
  const ui = await inspect(document.body)
  cp = ui.checkpoint()
  cArm = startArmC(document.body)
}
window.__agentCollect = async () => {
  const B = await armB(inspect, document.body, cp)
  const C = cArm.finish()
  // §9 honesty signal: does the arm tell the caller that a region's semantics are
  // unavailable (canvas/blocked iframe) and must be rasterized to be understood?
  const flagsCanvas = B.ui.agentMap.map.some((e) => e.semanticsAvailable === false) ||
    B.ui.context.includes('no semantics')
  return { B: { payload: B.payload, bytes: B.bytes, flagsCanvas }, C }
}
`)
  const res = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser',
    absWorkingDir: REPO,
  })
  return res.outputFiles[0].text
}

run().catch((e) => { console.error(e); process.exit(1) })
