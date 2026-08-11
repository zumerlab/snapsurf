/**
 * Field pass — the oracle against real pages, with no model and no API spend.
 *
 *   node experiment/field.mjs [--sites a,b] [--reps 5]
 *
 * Everything measured so far ran on fixtures written by the same hand that wrote the
 * reader. This asks the three questions those fixtures cannot:
 *
 *  1. SIZE — the pitch says "328 bytes vs 25 KB of screenshots". Does the payload stay
 *     small when the page has 3 000 nodes instead of 20?
 *  2. SPEED — the walk reads computed style per node. What does that cost for real?
 *  3. NOISE — the commercial claim is that the `agent` preset works unconfigured.
 *     A news site with rotating ads, lazy images and animations is its real judge:
 *     inspect twice with NO user action, and every reported change is a false positive.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const OUT = join(HERE, 'results')

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf('--' + n)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d
}
const REPS = Number(flag('reps', 5))

/** Deliberately diverse: ads and lazy loading, web components, e-commerce, a huge static
 *  document, and a marketing page built on scroll animation. */
const SITES = [
  { id: 'lanacion', url: 'https://www.lanacion.com.ar/', why: 'news — ad iframes, lazy images, infinite feed' },
  { id: 'github', url: 'https://github.com/', why: 'app shell — web components, shadow DOM' },
  { id: 'mercadolibre', url: 'https://www.mercadolibre.com.ar/', why: 'e-commerce — carousels, sticky header' },
  { id: 'wikipedia', url: 'https://es.wikipedia.org/wiki/Argentina', why: 'huge static document — the size ceiling' },
  { id: 'stripe', url: 'https://stripe.com/', why: 'marketing — scroll-driven animation, canvas/gradients' },
]

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y)
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1)
}

async function measure(browser, site) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    // The product's own environment: a content script in an extension's isolated world
    // is not subject to the page's script-src. Without this, sites with a strict CSP
    // (github, stripe) reject the injection and we would be measuring the harness.
    bypassCSP: true,
  })
  const row = { id: site.id, url: site.url, why: site.why }
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // Let ads, lazy images and fonts actually arrive — the noise we want to face.
    await page.waitForTimeout(6000)
    await page.addScriptTag({ content: SDK })
    await page.waitForTimeout(300)

    // ── 1/2. Size and speed of the walk itself ────────────────────────────────
    const base = await page.evaluate(async (reps) => {
      const t = []
      let obs
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now()
        obs = window.__observe(document.body)
        t.push(performance.now() - t0)
      }
      const ui = window.__buildUi(obs)
      const cp = ui.checkpoint()
      return {
        nodes: obs.snapshot.order.length,
        walkMs: t,
        domBytes: document.body.outerHTML.length,
        contextBytes: ui.context.length,
        agentMapEntries: ui.agentMap.map.length,
        agentMapBytes: JSON.stringify(ui.agentMap).length,
        checkpointBytes: JSON.stringify(cp).length,
        checkpointLeanBytes: JSON.stringify(ui.checkpoint({ excludeText: true })).length,
        unobservable: ui.unobservable.length,
        unobservableKinds: [...new Set(ui.unobservable.map((u) => u.sourceType))],
        covered: ui.agentMap.map.filter((e) => e.covered).length,
      }
    }, REPS)
    Object.assign(row, base, { walk_p50: pct(base.walkMs, 0.5), walk_p95: pct(base.walkMs, 0.95) })
    delete row.walkMs
    row.checkpoint_vs_dom = +(row.checkpointBytes / row.domBytes).toFixed(2)

    // ── 2b. Does a full capture (the plugin path) survive this page? ─────────
    // Measured here, before anything scrolls, and alongside the root's own geometry —
    // a first run reported an empty snapshot on two sites and the body's box is the
    // only way to tell "the walk broke" from "the page had nothing laid out".
    {
      const t0 = Date.now()
      try {
        const cap = await page.evaluate(async () => {
          const b = document.body.getBoundingClientRect()
          const r = await window.__inspect(document.body)
          const b2 = document.body.getBoundingClientRect()
          return {
            context: r.context.length, agentMap: r.agentMap.map.length,
            bodyBoxBefore: [Math.round(b.width), Math.round(b.height)],
            bodyBoxAfter: [Math.round(b2.width), Math.round(b2.height)],
            visibleChildren: [...document.body.children].filter((c) => getComputedStyle(c).display !== 'none').length,
          }
        })
        row.fullInspect = { ok: true, ms: Date.now() - t0, ...cap }
      } catch (e) {
        row.fullInspect = { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 200) }
      }
    }

    // ── 3. The noise gate: two walks, no user action in between ───────────────
    // Every change reported here is a false positive by construction.
    const idle = await page.evaluate(async (ms) => {
      const before = window.__observe(document.body)
      const cp = window.__buildUi(before).checkpoint()
      await new Promise((r) => setTimeout(r, ms))
      const after = window.__buildUi(window.__observe(document.body, { previous: cp }))
      const byKind = {}
      for (const c of after.changes || []) byKind[c.kind] = (byKind[c.kind] || 0) + 1
      return {
        changed: after.changed,
        count: (after.changes || []).length,
        byKind,
        payloadBytes: JSON.stringify({ changed: after.changed, changes: after.changes, actionabilityDelta: after.actionabilityDelta }).length,
        sample: (after.changes || []).slice(0, 4).map((c) => ({ kind: c.kind, role: c.role, name: c.name })),
      }
    }, 4000)
    row.idleNoise = idle

    // ── 4. A real action: scroll one viewport ─────────────────────────────────
    const scrolled = await page.evaluate(async () => {
      const before = window.__observe(document.body)
      const cp = window.__buildUi(before).checkpoint()
      window.scrollBy(0, 800)
      await new Promise((r) => setTimeout(r, 1200))
      const after = window.__buildUi(window.__observe(document.body, { previous: cp }))
      const byKind = {}
      for (const c of after.changes || []) byKind[c.kind] = (byKind[c.kind] || 0) + 1
      return {
        count: (after.changes || []).length,
        byKind,
        payloadBytes: JSON.stringify({ changed: after.changed, changes: after.changes, actionabilityDelta: after.actionabilityDelta }).length,
      }
    })
    row.scroll = scrolled

  } catch (e) {
    row.error = String(e).slice(0, 300)
  }
  await page.close()
  return row
}

let SDK = ''

async function run() {
  await mkdir(OUT, { recursive: true })
  SDK = await bundleSdk()
  const only = flag('sites', null)
  const sites = only === null || only === true ? SITES : SITES.filter((s) => String(only).split(',').includes(s.id))
  const browser = await chromium.launch()
  const rows = []
  for (const site of sites) {
    process.stderr.write(`[field] ${site.id} … `)
    const row = await measure(browser, site)
    process.stderr.write(row.error ? 'ERROR\n' : `${row.nodes} nodes, walk ${row.walk_p50}ms, idle noise ${row.idleNoise?.count}\n`)
    rows.push(row)
  }
  await browser.close()
  await writeFile(join(OUT, 'field.json'), JSON.stringify(rows, null, 1))
  console.log(JSON.stringify(rows, null, 1))
}

/** The walk, the ui builder and the full inspect(), exposed on window. */
async function bundleSdk() {
  const esbuild = await import('esbuild')
  const entry = join(OUT, '.field-entry.mjs')
  await mkdir(OUT, { recursive: true })
  await writeFile(entry, `
import { observe, buildUi } from '${join(HERE, '..', 'src', 'plugin.js').replace(/\\/g, '/')}'
import { inspect } from '${join(HERE, '..', 'src', 'index.js').replace(/\\/g, '/')}'
window.__observe = observe
window.__buildUi = buildUi
window.__inspect = inspect
`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
}

run().catch((e) => { console.error(e); process.exit(1) })
