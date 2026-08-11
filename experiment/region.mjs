/**
 * The region experiment — image alone vs image + actionables, on real pages.
 *
 *   node experiment/region.mjs [--reps 2] [--model claude-opus-5]
 *
 * The Phase-5 arms treated pixels and structure as rivals and asked "did anything
 * change?" over whole synthetic pages. Both choices were wrong. snapdom goes to the
 * region that matters, and the product is the PAIR: a small image showing what it looks
 * like, plus the list of what can be clicked and where.
 *
 * So the question here is the one an agent actually has to answer, and it grades itself
 * against the live DOM with no judge involved:
 *
 *     "Give me the (x, y) you would click for <goal>."
 *
 * A hit is `document.elementFromPoint(x, y)` landing on the intended element or inside
 * it. That single metric exposes the real trade: a downscaled screenshot costs few
 * tokens but every pixel of pointing error is multiplied by 1/scale, while a bbox list
 * is exact but says nothing about what the region looks like.
 *
 * Arms
 *   img1    — image of the region at scale 1 (what a vision agent does today)
 *   img025  — the same image at scale 0.25 (cheap pixels)
 *   map     — the actionables list alone: role, name, state, bbox (no pixels)
 *   pair    — img025 + map (the product)
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { usd } from './cost.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf('--' + n)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d
}
const REPS = Number(flag('reps', 2))
const MODEL = String(flag('model', 'claude-opus-5'))
const KEY = process.env.ANTHROPIC_API_KEY
const DRY = !KEY || flag('dry', false) === true

/**
 * Real regions, and goals that need the model to work out WHICH element is meant —
 * not to copy the only candidate. `expect` is the ground truth, resolved live.
 */
const REGIONS = [
  {
    id: 'github-header', url: 'https://github.com/', sel: 'header',
    goals: [
      { goal: 'open the search box', expect: '[data-target="qbsearch-input.inputButtonText"], .header-search-button, [aria-label*="Search"]' },
      { goal: 'go to the pricing page', expect: 'a[href="/pricing"], a[href*="pricing"]' },
    ],
  },
  {
    id: 'stripe-nav', url: 'https://stripe.com/', sel: 'header',
    goals: [
      { goal: 'reach the sign-in page for existing customers', expect: 'a[href*="dashboard.stripe.com"], a[href*="login"], a[href*="sign-in"]' },
      { goal: 'see how much Stripe charges', expect: 'a[href*="pricing"]' },
    ],
  },
  {
    id: 'wikipedia-infobox', url: 'https://es.wikipedia.org/wiki/Argentina', sel: 'table.infobox',
    goals: [
      { goal: 'open the article about the capital city', expect: 'a[href*="Buenos_Aires"]' },
      { goal: 'open the article about the official language', expect: 'a[href*="idioma" i], a[href*="espa" i]' },
    ],
  },
  {
    id: 'lanacion-nav', url: 'https://www.lanacion.com.ar/', sel: 'header',
    goals: [
      { goal: 'open the sports section', expect: 'a[href*="deportiv"], a[href*="deporte"]' },
      { goal: 'log in to the reader account', expect: 'a[href*="suscri" i], a[href*="login" i], [class*="login" i]' },
    ],
  },
  {
    id: 'mercadolibre-nav', url: 'https://www.mercadolibre.com.ar/', sel: 'body',
    goals: [
      { goal: 'type a product name to search for it', expect: 'input[type="text"], input[name="as_word"], [class*="search-input"]' },
      { goal: 'sign in to your account', expect: 'a[href*="login" i], a[href*="registration" i], [data-link-id*="login"]' },
    ],
  },
]

const CLICK_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    target: { type: 'string' },
    confident: { type: 'boolean' },
  },
  required: ['x', 'y', 'target', 'confident'],
  additionalProperties: false,
}

async function ask(content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000, fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLICK_SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return {
    answer: j.stop_reason === 'refusal' ? null : JSON.parse((j.content || []).map((c) => c.text || '').join('')),
    inputTokens: j.usage?.input_tokens || 0,
    outputTokens: j.usage?.output_tokens || 0,
  }
}

const img = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } })

/** Same task text for every arm; only the evidence differs. */
function prompt(goal, arm, region) {
  const frame = `The region occupies page coordinates x ${region.box[0]}…${region.box[0] + region.box[2]}, y ${region.box[1]}…${region.box[1] + region.box[3]}.`
  const common = `You are a UI agent. GOAL: ${goal}\nAnswer with the PAGE coordinates (x, y) you would click, the name of what you are aiming at, and whether you are confident.\n${frame}`
  if (arm === 'img1') return `${common}\nEvidence: an image of the region at full size. Its top-left pixel is page coordinate (${region.box[0]}, ${region.box[1]}) and one image pixel is one page pixel.`
  if (arm === 'img025') return `${common}\nEvidence: an image of the region scaled to 25%. Its top-left pixel is page coordinate (${region.box[0]}, ${region.box[1]}) and one image pixel is FOUR page pixels.`
  if (arm === 'map') return `${common}\nEvidence: the clickable elements of this region — role, name, state, and bounding box [x, y, width, height] in page coordinates.`
  return `${common}\nEvidence: an image of the region scaled to 25% (top-left pixel = page coordinate (${region.box[0]}, ${region.box[1]}), one image pixel = FOUR page pixels), AND the clickable elements with role, name, state and bounding box [x, y, width, height] in page coordinates.`
}

async function runRegion(browser, region) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, bypassCSP: true })
  const rows = []
  try {
    await page.goto(region.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)
    await page.addScriptTag({ content: SDK })
    await page.waitForTimeout(200)

    const ev = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel)
      if (!el) return { missing: true }
      const r = el.getBoundingClientRect()
      const ui = window.__buildUi(window.__observe(el))
      const map = ui.agentMap.map.map((e) => ({ role: e.r, name: e.n, state: e.s, covered: e.covered || undefined, box: e.b }))
      const res = await window.__snapdom(el)
      const i1 = await res.toPng({ scale: 1 })
      const i025 = await res.toPng({ scale: 0.25 })
      return {
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        map, mapText: JSON.stringify(map),
        img1: i1.src.split(',')[1], img025: i025.src.split(',')[1],
      }
    }, region.sel)
    if (ev.missing) { await page.close(); return [{ region: region.id, error: 'selector matched nothing' }] }

    for (const g of region.goals) {
      // Ground truth, resolved live: the element(s) that satisfy this goal.
      const truth = await page.evaluate(({ sel, expect }) => {
        const root = document.querySelector(sel)
        const hits = [...root.querySelectorAll(expect)].filter((e) => {
          const b = e.getBoundingClientRect()
          return b.width > 0 && b.height > 0
        })
        return hits.length ? { found: true, count: hits.length } : { found: false }
      }, { sel: region.sel, expect: g.expect })
      if (!truth.found) { rows.push({ region: region.id, goal: g.goal, skipped: 'no ground-truth element in this region' }); continue }

      for (let rep = 0; rep < REPS; rep++) {
        for (const arm of ['img1', 'img025', 'map', 'pair']) {
          const content = []
          if (arm === 'img1') content.push(img(ev.img1))
          if (arm === 'img025' || arm === 'pair') content.push(img(ev.img025))
          let text = prompt(g.goal, arm, { box: ev.box })
          if (arm === 'map' || arm === 'pair') text += `\n${ev.mapText}`
          content.push({ type: 'text', text })

          const row = { region: region.id, goal: g.goal, arm, rep, evidenceBytes: (arm === 'img1' ? ev.img1.length : 0) + ((arm === 'img025' || arm === 'pair') ? ev.img025.length : 0) + ((arm === 'map' || arm === 'pair') ? ev.mapText.length : 0) }
          if (DRY) { rows.push(row); continue }
          const { answer, inputTokens, outputTokens } = await ask(content)
          row.inputTokens = inputTokens; row.outputTokens = outputTokens
          if (!answer) { row.refused = true; rows.push(row); continue }
          row.said = { x: Math.round(answer.x), y: Math.round(answer.y), target: answer.target, confident: answer.confident }
          // The grade is GEOMETRIC: does the point fall inside the intended element's
          // box? An earlier version used elementFromPoint, which only answers for the
          // visible viewport — every answer below the fold scored zero for every arm,
          // including correct ones (Wikipedia's infobox runs to y≈2290 on an 800px
          // viewport). elementFromPoint is still consulted when the point IS on screen,
          // to catch a correct aim at something that is covered.
          const grade = await page.evaluate(({ x, y, sel, expect }) => {
            const root = document.querySelector(sel)
            const wanted = [...root.querySelectorAll(expect)].filter((e) => {
              const b = e.getBoundingClientRect()
              return b.width > 0 && b.height > 0
            })
            const inside = wanted.some((w) => {
              const b = w.getBoundingClientRect()
              return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
            })
            const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
            let covered = null
            if (inside && onScreen) {
              const at = document.elementFromPoint(x, y)
              covered = !(at && wanted.some((w) => w === at || w.contains(at) || at.contains(w)))
            }
            return { inside, onScreen, covered }
          }, { x: row.said.x, y: row.said.y, sel: region.sel, expect: g.expect })
          row.hit = grade.inside
          row.onScreen = grade.onScreen
          row.aimedAtCovered = grade.covered === true
          rows.push(row)
        }
      }
    }
  } catch (e) {
    rows.push({ region: region.id, error: String(e).slice(0, 200) })
  }
  await page.close()
  return rows
}

let SDK = ''

async function run() {
  await mkdir(OUT, { recursive: true })
  SDK = await bundleSdk()
  const browser = await chromium.launch()
  const rows = []
  for (const r of REGIONS) {
    process.stderr.write(`[region] ${r.id} … `)
    const got = await runRegion(browser, r)
    const hits = got.filter((x) => x.hit).length
    process.stderr.write(`${got.length} rows, ${hits} hits\n`)
    rows.push(...got)
  }
  await browser.close()

  const arms = ['img1', 'img025', 'map', 'pair']
  const byArm = {}
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm && !r.skipped && !r.error)
    if (!mine.length) continue
    const tIn = mine.reduce((a, r) => a + (r.inputTokens || 0), 0)
    const tOut = mine.reduce((a, r) => a + (r.outputTokens || 0), 0)
    byArm[arm] = {
      n: mine.length,
      hitRate: +(mine.filter((r) => r.hit).length / mine.length).toFixed(2),
      // Confidently wrong is the dangerous failure: an agent acts on it.
      confidentlyWrong: mine.filter((r) => !r.hit && r.said?.confident).length,
      meanEvidenceBytes: Math.round(mine.reduce((a, r) => a + r.evidenceBytes, 0) / mine.length),
      meanInputTokens: Math.round(tIn / mine.length),
      usd: usd(MODEL, tIn, tOut),
    }
  }
  const summary = { model: MODEL, reps: REPS, byArm, totalUsd: +Object.values(byArm).reduce((a, b) => a + b.usd, 0).toFixed(4) }
  await writeFile(join(OUT, 'region-raw.json'), JSON.stringify({ summary, rows }, null, 1))
  console.log(JSON.stringify(summary, null, 1))
}

async function bundleSdk() {
  const esbuild = await import('esbuild')
  const entry = join(OUT, '.region-entry.mjs')
  await mkdir(OUT, { recursive: true })
  await writeFile(entry, `
import { observe, buildUi } from '${join(HERE, '..', 'src', 'plugin.js').replace(/\\/g, '/')}'
import { snapdom } from '${join(REPO, 'src', 'api', 'snapdom.js').replace(/\\/g, '/')}'
window.__observe = observe; window.__buildUi = buildUi; window.__snapdom = snapdom
`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
}

run().catch((e) => { console.error(e); process.exit(1) })
