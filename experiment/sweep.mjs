/**
 * Wide sweep — the zero-config noise claim and the per-turn payload economics,
 * measured across ~35 diverse real sites. No model, no spend.
 *
 * Per site: load + settle 6s → inject SDK → inspect → checkpoint → wait 2s →
 * inspect({previous}) — every change is a false positive by construction.
 * Payload: what a model would be sent per turn (context outline, changes report,
 * agentMap) vs a JPEG screenshot of the same viewport.
 * Token estimates: text ≈ chars/4; image ≈ w*h/750 (Claude vision).
 */
import { chromium } from 'playwright'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'results')
const SDK = await (async () => {
  const esbuild = await import('esbuild')
  const { writeFile: wf } = await import('node:fs/promises')
  const entry = join(HERE, 'sdk-entry.mjs')
  await wf(entry, `import { inspect } from '${join(REPO, 'packages/agent/src/index.js')}'\nwindow.__agentInspect = inspect\n`)
  const res = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false, platform: 'browser', absWorkingDir: REPO })
  return res.outputFiles[0].text
})()

const SITES = [
  // news
  'https://www.lanacion.com.ar/', 'https://www.clarin.com/', 'https://www.infobae.com/',
  'https://www.bbc.com/', 'https://www.theguardian.com/international', 'https://elpais.com/',
  // e-commerce
  'https://www.mercadolibre.com.ar/', 'https://www.ebay.com/', 'https://www.etsy.com/',
  'https://www.aliexpress.com/', 'https://www.zalando.es/',
  // SaaS / marketing
  'https://stripe.com/', 'https://github.com/', 'https://about.gitlab.com/',
  'https://vercel.com/', 'https://slack.com/', 'https://www.notion.com/',
  'https://linear.app/', 'https://www.figma.com/', 'https://openai.com/',
  'https://www.anthropic.com/', 'https://www.cloudflare.com/', 'https://www.digitalocean.com/',
  // docs / reference
  'https://developer.mozilla.org/es/', 'https://es.wikipedia.org/wiki/Argentina',
  'https://react.dev/', 'https://docs.python.org/3/', 'https://stackoverflow.com/questions',
  'https://www.npmjs.com/', 'https://pypi.org/',
  // gov / org / misc
  'https://www.argentina.gob.ar/', 'https://www.mozilla.org/es-AR/',
  'https://wordpress.org/', 'https://duckduckgo.com/html/', 'https://www.apple.com/',
  'https://www.microsoft.com/es-ar/',
]

const IN_PAGE = {
  first: async () => {
    const t0 = performance.now()
    const ui = await window.__agentInspect(document.body)
    const ms = performance.now() - t0
    window.__cp = ui.checkpoint()
    return {
      ms: +ms.toFixed(0),
      nodes: ui.__snapshot.order.length,
      contextBytes: ui.context.length,
      agentMapEntries: ui.agentMap.map.length,
      agentMapBytes: JSON.stringify(ui.agentMap).length,
      checkpointBytes: JSON.stringify(window.__cp).length,
      unobservable: ui.unobservable.length,
    }
  },
  rest: async () => {
    const ui = await window.__agentInspect(document.body, { previous: window.__cp })
    const byKind = ui.changes.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m }, {})
    return {
      fps: ui.changes.length,
      byKind,
      changesBytes: JSON.stringify({ changes: ui.changes, actionabilityDelta: ui.actionabilityDelta }).length,
      sample: ui.changes.slice(0, 4).map((c) => ({ kind: c.kind, role: c.role, name: c.name && String(c.name).slice(0, 40) })),
    }
  },
}

async function sweep(browser, url) {
  const id = url.replace(/^https:\/\/(www\.)?/, '').replace(/[^a-z0-9.]+/g, '_').replace(/_+$/, '').slice(0, 30)
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    bypassCSP: true,
    locale: 'es-AR',
  })
  const row = { id, url }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(6000)
    await page.addScriptTag({ content: SDK })
    row.first = await page.evaluate(IN_PAGE.first)
    const shot = await page.screenshot({ type: 'jpeg', quality: 80 })
    row.screenshotBytes = shot.length
    await page.waitForTimeout(2000)
    row.rest = await page.evaluate(IN_PAGE.rest)
    // tokens a model would pay per observation turn
    row.tokens = {
      oracle_first_turn: Math.round((row.first.contextBytes + row.first.agentMapBytes) / 4),
      oracle_next_turn: Math.round(row.rest.changesBytes / 4),
      screenshot_turn: Math.round(1280 * 800 / 750),
    }
  } catch (e) {
    row.error = String(e).split('\n')[0].slice(0, 160)
  }
  await page.close().catch(() => {})
  return row
}

const browser = await chromium.launch()
await mkdir(OUT, { recursive: true })
const queue = [...SITES]
const rows = []
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const url = queue.shift()
    const row = await sweep(browser, url)
    rows.push(row)
    console.log(`done ${row.id}${row.error ? ' ERROR ' + row.error : ` fps=${row.rest.fps}`}`)
  }
}))
await browser.close()
rows.sort((a, b) => a.url.localeCompare(b.url))
await writeFile(join(OUT, 'sweep.json'), JSON.stringify(rows, null, 2))

const ok = rows.filter((r) => !r.error)
const quiet = ok.filter((r) => r.rest.fps === 0)
console.log(`\n${ok.length}/${rows.length} measured · ${quiet.length}/${ok.length} with ZERO rest noise`)
