/**
 * Field pass, done right: a REGION, and text + image together.
 *
 *   node packages/agent/experiment/field-scoped.mjs
 *
 * The first field pass walked `document.body` of five sites and concluded the walk
 * "does not scale". That measured the worst case anyone would ever ask for. snapdom's
 * whole point is going straight to the element that matters, and an agent's question is
 * almost always about a region: this card, this form, this panel.
 *
 * It also measured text and pixels as rivals — the Phase-5 arms were "screenshots vs
 * structure". The actual product is BOTH, from one capture and one instant, with the
 * image scaled down: the text says what each thing is and where, the small image says
 * what it looks like. This measures that pairing at several scales.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'results')

/** One realistic "the agent cares about this" region per site. */
const TARGETS = [
  { id: 'lanacion', url: 'https://www.lanacion.com.ar/', sel: 'article, [class*="card"]', what: 'a story card in the feed' },
  { id: 'mercadolibre', url: 'https://www.mercadolibre.com.ar/', sel: '[class*="promotion-item"], [class*="item__"], li[class*="card"]', what: 'a product card' },
  { id: 'github', url: 'https://github.com/', sel: 'header, [class*="Header"]', what: 'the header / nav' },
  { id: 'wikipedia', url: 'https://es.wikipedia.org/wiki/Argentina', sel: 'table.infobox, .infobox, #bodyContent table', what: 'the infobox' },
  { id: 'stripe', url: 'https://stripe.com/', sel: 'nav, header', what: 'the nav' },
]

const SCALES = [1, 0.5, 0.25]
const kb = (n) => +(n / 1024).toFixed(1)

async function measure(browser, t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, bypassCSP: true })
  const row = { id: t.id, what: t.what }
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)
    await page.addScriptTag({ content: SDK })
    await page.waitForTimeout(200)

    const out = await page.evaluate(async ({ sel, scales }) => {
      const el = document.querySelector(sel)
      if (!el) return { missing: true }
      const r = el.getBoundingClientRect()

      // The walk, scoped to the region — five runs.
      const times = []
      let obs
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        obs = window.__observe(el)
        times.push(performance.now() - t0)
      }
      const ui = window.__buildUi(obs)

      // The pairing: one capture, then the same pixels at several scales.
      const images = {}
      for (const s of scales) {
        const t0 = performance.now()
        const img = await window.__snapdom(el).then((res) => res.toPng({ scale: s }))
        images[s] = { bytes: img.src.length, ms: Math.round(performance.now() - t0), w: img.naturalWidth, h: img.naturalHeight }
      }
      // What a full-viewport screenshot of the page would have cost, for reference.
      return {
        tag: el.tagName.toLowerCase(),
        box: [Math.round(r.width), Math.round(r.height)],
        nodes: obs.snapshot.order.length,
        times,
        outlineBytes: ui.context.length,
        checkpointBytes: JSON.stringify(ui.checkpoint()).length,
        agentMapEntries: ui.agentMap.map.length,
        agentMapBytes: JSON.stringify(ui.agentMap).length,
        images,
        outlinePreview: ui.context.split('\n').slice(0, 6).join('\n'),
      }
    }, { sel: t.sel, scales: SCALES })

    if (out.missing) { row.error = 'selector matched nothing'; }
    else {
      Object.assign(row, out)
      row.walk_p50 = +[...out.times].sort((a, b) => a - b)[2].toFixed(1)
      delete row.times
    }
  } catch (e) {
    row.error = String(e).slice(0, 200)
  }
  await page.close()
  return row
}

let SDK = ''

async function run() {
  await mkdir(OUT, { recursive: true })
  SDK = await bundleSdk()
  const browser = await chromium.launch()
  const rows = []
  for (const t of TARGETS) {
    process.stderr.write(`[scoped] ${t.id} … `)
    const r = await measure(browser, t)
    process.stderr.write(r.error ? `ERROR ${r.error}\n` : `${r.nodes} nodes, ${r.walk_p50}ms, text ${kb(r.outlineBytes)}KB, img@0.25 ${kb(r.images['0.25'].bytes)}KB\n`)
    rows.push(r)
  }
  await browser.close()
  await writeFile(join(OUT, 'field-scoped.json'), JSON.stringify(rows, null, 1))
  console.log(JSON.stringify(rows, null, 1))
}

async function bundleSdk() {
  const esbuild = await import('esbuild')
  const entry = join(OUT, '.scoped-entry.mjs')
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
