/**
 * scaling.mjs — isolate the supra-linear scaling claim in a clean harness.
 *
 * Panel field data: 13.7k elements = 3.8× La Nación's node count but 35× its walk
 * time (their CDP env). Two competing hypotheses:
 *   (a) intrinsic: some per-node phase costs O(depth) or O(document) and real large
 *       pages are also deeper (geometryFrame climbs to the nearest positioned
 *       ancestor — all-static chains climb to the ROOT);
 *   (b) environmental: their env has a ~1Hz tick that blocks the main thread ~900ms
 *       per beat (measured by their own idle control). A walk that fits inside one
 *       inter-tick window pays nothing; a walk spanning N beats pays ~N×900ms of
 *       wall time that is not CPU. La Nación (74ms) fits; Wikipedia doesn't.
 *
 * This script measures per-node cost on a small vs large REAL page, on synthetic
 * pages with controlled node count and depth, and then re-runs the large page with
 * an artificial 1Hz/900ms tick to see whether the panel's 35× reproduces.
 *
 *   node packages/agent/experiment/scaling.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))

const built = await esbuild.build({
  stdin: {
    contents: `import { observeChunked } from '${join(REPO, 'packages/agent/src/plugin.js').replace(/\\/g, '/')}'\nwindow.__oc = observeChunked`,
    resolveDir: REPO,
    loader: 'js',
  },
  bundle: true, write: false, format: 'iife', platform: 'browser',
})
const SDK = built.outputFiles[0].text

const browser = await chromium.launch({ channel: 'chromium' })
const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 665 } })

// tick: emulate the panel env's measured idle noise (main thread blocked ~900ms at ~1Hz)
const measure = (page, { tick = false } = {}) => page.evaluate(async ({ tick }) => {
  let iv = null
  if (tick) {
    iv = setInterval(() => { const t = performance.now(); while (performance.now() - t < 900) { /* busy */ } }, 1000)
    // free-running relative to the walk, like a real environment tick
    await new Promise((r) => setTimeout(r, 500))
  }
  window.__SD_PROF = {}
  const t0 = performance.now()
  const obs = await window.__oc(document.body, {})
  const walkMs = Math.round(performance.now() - t0)
  if (iv) clearInterval(iv)
  const prof = Object.fromEntries(Object.entries(window.__SD_PROF).map(([k, v]) => [k, Math.round(v)]))
  return { nodes: obs.snapshot.order.length, walkMs, prof }
}, { tick })

const row = (label, r) =>
  console.log(`${label.padEnd(34)} nodes ${String(r.nodes).padStart(6)} · walk ${String(r.walkMs).padStart(6)}ms · ${(r.walkMs * 1000 / r.nodes).toFixed(1).padStart(6)}µs/node · maxSlice ${r.prof.maxSliceMs || 0}ms · top: styleSubset ${r.prof.styleSubset || 0} relativeBBox ${r.prof.relativeBBox || 0} computeName ${r.prof.computeName || 0} occluderAt ${r.prof.occluderAt || 0}`)

// ── real pages: small vs large ───────────────────────────────────────────────────────
for (const [label, url] of [
  ['REAL example.com (tiny)', 'https://example.com/'],
  ['REAL lanacion (small-ish)', 'https://www.lanacion.com.ar/'],
  ['REAL wikipedia Buenos_Aires (big)', 'https://es.wikipedia.org/wiki/Buenos_Aires'],
]) {
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(3000)
    await page.addScriptTag({ content: SDK })
    row(label, await measure(page))
    if (label.includes('wikipedia') || label.includes('lanacion')) {
      row(`${label} +1Hz tick`, await measure(page, { tick: true }))
      // the panel-env reproduction: 4x CPU (their throttled CDP) so the walk is
      // long enough to SPAN beats of the tick — the threshold effect that turns
      // linear work into supra-linear WALL time
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      row(`${label} 4x throttle`, await measure(page))
      row(`${label} 4x throttle +1Hz tick`, await measure(page, { tick: true }))
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    }
  } catch (e) {
    console.log(`${label.padEnd(34)} SKIPPED (${String(e).slice(0, 80)})`)
  }
  await page.close()
}

// ── synthetic: node count sweep at constant shallow depth ────────────────────────────
const page = await ctx.newPage()
await page.goto('about:blank')
await page.addScriptTag({ content: SDK })
const buildCards = (cards, wrap) => page.evaluate(({ cards, wrap }) => {
  let html = ''
  for (let i = 0; i < cards; i++) {
    let card = `<h3>Card ${i}</h3><p>descriptive text ${i} with several words</p><div><a href="/item${i}">open ${i}</a><button>act ${i}</button></div>`
    for (let d = 0; d < wrap; d++) card = `<div>${card}</div>`
    html += `<section>${card}</section>`
  }
  document.body.innerHTML = `<main>${html}</main>`
}, { cards, wrap })

for (const cards of [40, 160, 640, 2000]) {
  await buildCards(cards, 1)
  row(`SYNTH shallow ×${cards} cards`, await measure(page))
}
// ── synthetic: same node count, deep wrappers (geometryFrame climbs to root) ─────────
for (const wrap of [1, 15, 30]) {
  await buildCards(640, wrap)
  row(`SYNTH 640 cards, wrap depth ${wrap}`, await measure(page))
}
// ── synthetic: the 1Hz tick against a walk that spans multiple beats ─────────────────
await buildCards(2000, 1)
row('SYNTH ×2000 +1Hz tick', await measure(page, { tick: true }))

await browser.close()
