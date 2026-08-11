/**
 * run-demo.mjs — "QA without visual assertions", end to end through the MCP server.
 *
 * The app (app.html) carries ambient noise on purpose: a live clock and a CSS
 * spinner. Any screenshot assertion around it is flaky by construction. The demo
 * runs the same two test cases both ways:
 *
 *   T1 add-item : type "Buy milk", click Add   → assert the EXACT semantic effect
 *   T2 no-op    : click Refresh (does nothing) → assert NOTHING changed
 *
 * oracle arm: browser_act + browser_assert (structured pass/checks, ~200 bytes)
 * pixel arm : before/after screenshots + perceptual diff (what a visual assertion sees)
 *
 *   node demo-qa/run-demo.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const APP = pathToFileURL(join(HERE, 'app.html')).href

// ── MCP client (stdio, zero deps) ────────────────────────────────────────────────────
const srv = spawn(process.execPath, [join(HERE, '..', 'mcp', 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
let nextId = 1
createInterface({ input: srv.stdout }).on('line', (l) => {
  try { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id) } catch { /* noise */ }
})
const call = (method, params) => new Promise((r) => {
  const id = nextId++
  pending.set(id, r)
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const tool = async (name, args) => {
  const m = await call('tools/call', { name, arguments: args })
  return { text: m.result.content[0].text, sc: m.result.structuredContent || {} }
}
await call('initialize', { protocolVersion: '2024-11-05' })

console.log('══ ORACLE ARM (browser_act + browser_assert) ══')
await tool('browser_open', { url: APP })

// T1: add an item, assert the exact semantic effect
const input = (await tool('browser_find', { text: 'New item' })).sc.matches[0]
await tool('browser_act', { action: 'click', target: input.id })
await tool('browser_act', { action: 'type', text: 'Buy milk' })
await tool('browser_act', { action: 'enter' })
const t1 = await tool('browser_assert', {
  changed: true,
  mustInclude: [{ kind: 'added', name: 'Buy milk' }],
  exists: 'Buy milk',
})
console.log('T1 add-item →', t1.sc.assert.pass ? 'PASS' : 'FAIL')
console.log(t1.text.split('\n').map((l) => '   ' + l).join('\n'))

// T2: the no-op — assert the click did NOTHING (clock keeps ticking, spinner spins)
const refresh = (await tool('browser_find', { text: 'Refresh' })).sc.matches[0]
await tool('browser_act', { action: 'click', target: refresh.id })
const t2 = await tool('browser_assert', { changed: false })
console.log('T2 no-op    →', t2.sc.assert.pass ? 'PASS' : 'FAIL')
console.log(t2.text.split('\n').map((l) => '   ' + l).join('\n'))

srv.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 800))

// ── PIXEL ARM: the same T2 no-op under a visual assertion ────────────────────────────
console.log('\n══ PIXEL ARM (what a screenshot assertion sees on the SAME no-op) ══')
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
const diffSrc = (await readFile(join(REPO, 'node_modules/@zumer/snapdiff/src/diff.js'), 'utf8')).replace(/^export /gm, '')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 700, height: 500 } })
await page.goto(APP)
await page.waitForTimeout(500)
const shotA = (await page.screenshot()).toString('base64')
await page.click('#refresh')          // the no-op
await page.waitForTimeout(1100)       // one clock tick later — like any real test runner delay
const shotB = (await page.screenshot()).toString('base64')
const pix = await page.evaluate(async ({ a, b, diffCode }) => {
  (0, eval)(diffCode)
  const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64 })
  const [ia, ib] = await Promise.all([load(a), load(b)])
  const c = (img) => { const cv = document.createElement('canvas'); cv.width = ia.width; cv.height = ia.height; const x = cv.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, ia.width, ia.height).data }
  const r = diffPixels(c(ia), c(ib), new Uint8ClampedArray(ia.width * ia.height * 4), ia.width, ia.height, {})
  return { diff: r.diff, ratio: r.ratio }
}, { a: shotA, b: shotB, diffCode: diffSrc })
await browser.close()
console.log(`no-op click → ${pix.diff} pixels differ (${(100 * pix.ratio).toFixed(2)}%) — a visual assertion here FAILS (flaky: clock + spinner)`)
console.log(`oracle on the same no-op → changed:false (assertable, ~${t2.text.length} bytes of evidence)`)
process.exit(0)
