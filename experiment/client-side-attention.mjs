#!/usr/bin/env node
/**
 * Client-side attention experiment.
 *
 * Same already-open tab and same action, two read-only evidence paths:
 *   - a whole-body Playwright ARIA snapshot (full-state reference), and
 *   - the SnapDOM companion response (client-side typed delta + compact digest).
 *
 * Playwright is the hermetic browser harness, not the product arm. The companion
 * request itself travels extension -> worker -> isolated content script and never
 * uses CDP/debugger or a second browser. No personal browser profile is accessed.
 */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createServer, get } from 'node:http'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from 'playwright'

/* global chrome, document */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPANION = join(ROOT, 'companion')
const CLIENT = join(COMPANION, 'gate-client')
const CLIENT_ID = 'caajdlhkjophkdagpdchjbllohjojgml'
const SCALES = [50, 250, 1000, 3000]
const REPS = 3
const outputIndex = process.argv.indexOf('--output')
const OUTPUT = outputIndex >= 0
  ? resolve(process.cwd(), process.argv[outputIndex + 1])
  : join(ROOT, 'experiment', 'results', 'client-side-attention.json')

const fixture = (count) => `<!doctype html><meta charset="utf-8">
<title>Client-side attention fixture ${count}</title>
<style>
  body{font:14px system-ui;margin:0} header{position:sticky;top:0;background:white;padding:12px;border-bottom:1px solid #ddd;z-index:2}
  main{padding:12px}.row{display:flex;align-items:center;gap:12px;min-height:34px}.row p{margin:0;color:#555}.row button{min-width:120px}
</style>
<header aria-label="Cart summary"><button id="cart">Cart <span id="badge">0</span></button><span id="status" role="status">Ready</span></header>
<main aria-label="Catalog">
${Array.from({ length: count }, (_, index) => `<article class="row"><h2>Item ${index}</h2><p>Catalog description ${index}</p><button ${index === 0 ? 'id="target"' : ''}>Add item ${index}</button></article>`).join('')}
</main>
<script>
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('badge').textContent = '1';
    document.getElementById('status').textContent = 'Added Item 0';
  });
</script>`

const results = []
let context
let server
let profile
let fixturePort
let browserVersion
let clientWorker

try {
  profile = await mkdtemp(join(tmpdir(), 'snapdom-client-attention-'))
  server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const count = Number(url.searchParams.get('count'))
    if (!SCALES.includes(count)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('unknown fixture')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(fixture(count))
  })
  await listenSafe(server)
  fixturePort = server.address().port

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 800 },
    args: [
      `--disable-extensions-except=${COMPANION},${CLIENT}`,
      `--load-extension=${COMPANION},${CLIENT}`,
    ],
  })
  browserVersion = context.browser()?.version() || null
  await wakeClient(context)
  clientWorker = context.serviceWorkers().find((worker) => new URL(worker.url()).host === CLIENT_ID)
  if (!clientWorker) throw new Error('gate-client service worker did not start')

  for (const count of SCALES) {
    for (let rep = 0; rep < REPS; rep++) {
      const page = await context.newPage()
      const url = `http://127.0.0.1:${fixturePort}/catalog?count=${count}&rep=${rep}`
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        const tabId = await clientWorker.evaluate((targetUrl) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === targetUrl)?.id), page.url())
        if (!Number.isInteger(tabId)) throw new Error('fixture tab not found by extension client')
        const ask = async (request) => {
          const deadline = Date.now() + 5000
          for (;;) {
            const reply = await clientWorker.evaluate(
              ({ tabId: targetTabId, request: payload }) => globalThis.snapdomGateAsk(targetTabId, payload),
              { tabId, request },
            )
            if (!/Receiving end does not exist/i.test(reply?.error || '') || Date.now() >= deadline) return reply
            await page.waitForTimeout(50)
          }
        }

        const baseline = await ask({ type: 'SNAPDOM_OBSERVE', obsId: `baseline-${count}-${rep}` })
        if (baseline?.result?.contract !== 8 || baseline.result.changed !== undefined) {
          throw new Error(`invalid SnapDOM baseline: ${JSON.stringify({ error: baseline?.error, contract: baseline?.result?.contract, changed: baseline?.result?.changed, url: baseline?.result?.url })}`)
        }
        await page.click('#target')
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Added Item 0')

        let snap
        let aria
        let snapWallMs
        let ariaWallMs
        // Alternate read order so the descriptive timing is not tied to a fixed first
        // observer. Neither read mutates the authored fixture state.
        if (rep % 2 === 0) {
          ;({ value: snap, elapsedMs: snapWallMs } = await timed(() => ask({ type: 'SNAPDOM_OBSERVE', obsId: `after-${count}-${rep}` })))
          ;({ value: aria, elapsedMs: ariaWallMs } = await timed(() => page.locator('body').ariaSnapshot()))
        } else {
          ;({ value: aria, elapsedMs: ariaWallMs } = await timed(() => page.locator('body').ariaSnapshot()))
          ;({ value: snap, elapsedMs: snapWallMs } = await timed(() => ask({ type: 'SNAPDOM_OBSERVE', obsId: `after-${count}-${rep}` })))
        }

        const snapWire = JSON.stringify(snap?.result || {})
        const snapTruth = snap?.result?.changed === true &&
          (snap.result.changes || []).some((change) => /Added Item 0|Cart 1|\b1\b/.test(`${change.name || ''} ${change.beforeName || ''}`))
        const ariaTruth = /Added Item 0/.test(aria) && /Cart 1/.test(aria)
        results.push({
          count,
          rep,
          readOrder: rep % 2 === 0 ? ['snapdom', 'aria'] : ['aria', 'snapdom'],
          actionables: baseline.result.actionables,
          truth: { snapdom: snapTruth, aria: ariaTruth },
          snapdom: {
            responseBytes: Buffer.byteLength(snapWire),
            wallMs: snapWallMs,
            reportedWalkMs: snap.result.walkMs,
            changes: snap.result.changes?.length || 0,
            torn: snap.result.torn,
            unobservable: snap.result.unobservable,
          },
          aria: {
            snapshotBytes: Buffer.byteLength(aria),
            wallMs: ariaWallMs,
          },
        })
      } finally {
        await page.close()
      }
    }
  }
} finally {
  await context?.close()
  if (server) await new Promise((resolveClose) => server.close(resolveClose))
  if (profile) await rm(profile, { recursive: true, force: true })
}

const integrity = {
  trials: results.length,
  expectedTrials: SCALES.length * REPS,
  allTruthMatched: results.every((row) => row.truth.snapdom && row.truth.aria),
  zeroTorn: results.every((row) => row.snapdom.torn === 0),
  zeroUnobservable: results.every((row) => row.snapdom.unobservable === 0),
  fixturePortNot8377: fixturePort !== 8377,
  fixturePortClosed: await portClosed(fixturePort),
  profileRemoved: profile ? !(await exists(profile)) : false,
}
if (!Object.values(integrity).every((value) => value === true || (typeof value === 'number' && value === integrity.expectedTrials))) {
  throw new Error(`integrity gate failed: ${JSON.stringify(integrity)}`)
}

const summary = SCALES.map((count) => {
  const rows = results.filter((row) => row.count === count)
  const ariaBytes = median(rows.map((row) => row.aria.snapshotBytes))
  const snapBytes = median(rows.map((row) => row.snapdom.responseBytes))
  return {
    count,
    medianActionables: median(rows.map((row) => row.actionables)),
    medianAriaSnapshotBytes: ariaBytes,
    medianSnapdomResponseBytes: snapBytes,
    ariaToSnapdomByteRatio: round(ariaBytes / snapBytes),
    medianAriaWallMs: median(rows.map((row) => row.aria.wallMs)),
    medianSnapdomWallMs: median(rows.map((row) => row.snapdom.wallMs)),
  }
})

const output = {
  schema: 1,
  classification: 'single-machine scaling experiment; descriptive, not a token or speed claim',
  question: 'Does a client-side typed delta avoid resending whole-page semantic state as the page grows?',
  browser: { engine: 'chromium', version: browserVersion, profile: 'task-owned temporary profile' },
  companionPath: 'allowlisted client extension -> companion service worker -> isolated content script',
  scales: SCALES,
  repetitions: REPS,
  summary,
  trials: results,
  integrity,
  caveats: [
    'The ARIA snapshot and SnapDOM response do not contain identical evidence: SnapDOM adds geometry, typed change and uncertainty fields.',
    'The fixture is synthetic and the action changes a small fixed region; this tests scaling behavior, not real-site task success.',
    'Wall time is descriptive because the two readers have different implementations and were run sequentially with alternating order.',
    'UTF-8 bytes are not model tokens. No token estimate is reported.',
    'Playwright launches the isolated test browser, but the measured SnapDOM product path itself uses no CDP/debugger request.',
  ],
}

await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ output: OUTPUT, summary, integrity }, null, 2))

async function timed(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, elapsedMs: round(performance.now() - started) }
}

async function wakeClient(ctx) {
  if (ctx.serviceWorkers().some((worker) => new URL(worker.url()).host === CLIENT_ID)) return
  const wake = await ctx.newPage()
  try {
    await wake.goto(`chrome-extension://${CLIENT_ID}/worker.js`).catch(() => {})
    await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null)
  } finally {
    await wake.close()
  }
}

async function listenSafe(target) {
  for (;;) {
    await new Promise((resolveListen, reject) => {
      target.once('error', reject)
      target.listen(0, '127.0.0.1', resolveListen)
    })
    const address = target.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind')
    if (address.port !== 8377) return
    await new Promise((resolveClose) => target.close(resolveClose))
  }
}

async function portClosed(port) {
  if (!Number.isInteger(port)) return false
  return await new Promise((resolveClosed) => {
    const request = get({ host: '127.0.0.1', port, path: '/', timeout: 300 }, () => {
      request.destroy()
      resolveClosed(false)
    })
    request.on('error', () => resolveClosed(true))
    request.on('timeout', () => { request.destroy(); resolveClosed(false) })
  })
}

async function exists(path) {
  return await stat(path).then(() => true, () => false)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function round(value) {
  return Math.round(value * 100) / 100
}
