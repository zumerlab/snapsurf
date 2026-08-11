/**
 * bench-qa.mjs — PLAN phase F2: the sales number.
 *
 * For every corpus fixture (page.html + mutate.js + expected.json, hand-written
 * truth) run three arms and compare against expected.changed:
 *
 *   oracle : THROUGH the MCP server (browser_open file:// wrapper that self-mutates
 *            at t=+1500ms, then browser_verify) — measures the PRODUCT, not the lab.
 *   pixel  : pixelmatch-class perceptual diff (@zumer/snapdiff/diff, zero-dep) over
 *            before/after screenshots of the same mutation.
 *   a11y   : Playwright accessibility.snapshot() JSON before/after, string compare —
 *            the "a11y tree diff" a Playwright-based agent gets for free.
 *
 * The corpus already contains the money cases: fixtures where REAL visual movement
 * must NOT count as change (css-animation-running, live-timestamp, scroll-only,
 * residual-hover…) — expected.changed=false under actual pixel churn. A false
 * positive there is a flaky visual assertion in a QA pipeline.
 *
 * Output: experiment/results/bench-qa.md (+ raw JSON alongside).
 *
 *   node experiment/bench-qa.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../tools/host-repo.mjs')
const REPO = resolveHost()
const CORPUS = join(HERE, '..', 'corpus')
const TMP = join('/tmp', 'snapdom-bench-qa')
await mkdir(TMP, { recursive: true })

// ── Fixture wrappers ─────────────────────────────────────────────────────────────────
// mutate.js files are real ES modules (top-level consts, even imports from src/) and
// they expect an ELEMENT root. `document` breaks appendChild (HierarchyRequestError)
// and `document.body` misses <style> tags the parser hoisted into <head> — use
// document.documentElement. Bundle each module properly instead of regex-inlining.
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
const mutateBundles = new Map()
async function bundleMutate(name) {
  if (!mutateBundles.has(name)) {
    const out = await esbuild.build({
      entryPoints: [join(CORPUS, name, 'mutate.js')],
      bundle: true, format: 'iife', globalName: '__mutateMod', write: false, platform: 'browser',
    })
    mutateBundles.set(name, out.outputFiles[0].text)
  }
  return mutateBundles.get(name)
}

// Mount EXACTLY like the product's own corpus runner (test/corpus.test.js):
// a container div, innerHTML = fragment, mutate(container). mode 'auto' fires the
// mutation at +1500ms (oracle arm: open observes the baseline first); 'manual'
// exposes window.__runMutation() so the competitor arm controls before/after.
async function buildWrapper(name, mode) {
  const page = await readFile(join(CORPUS, name, 'page.html'), 'utf8')
  const bundle = await bundleMutate(name)
  const html = `<!doctype html><html><body>
<script>
const container = document.createElement('div')
container.style.cssText = 'width:900px;position:relative'
container.innerHTML = ${JSON.stringify(page).replace(/<\/script/gi, '<\\/script')}
document.body.appendChild(container)
${bundle}
const __frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
const __run = async () => {
  try { await __mutateMod.default(container, { frame: __frame }); window.__mutated = true }
  catch (e) { window.__mutateErr = String(e) }
}
${mode === 'auto' ? 'setTimeout(__run, 1500)' : 'window.__runMutation = __run'}
</script></body></html>`
  const file = join(TMP, `${name}.${mode}.html`)
  await writeFile(file, html)
  return pathToFileURL(file).href
}

// ── Arm 1: oracle through MCP ────────────────────────────────────────────────────────
function startMcp() {
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
  return { srv, call }
}

async function oracleArm(mcp, url) {
  const t0 = Date.now()
  await mcp.call('tools/call', { name: 'browser_open', arguments: { url } })
  await new Promise((r) => setTimeout(r, 2200)) // mutation fires at +1500ms in-page
  const v = await mcp.call('tools/call', { name: 'browser_verify', arguments: {} })
  const sc = v.result.structuredContent || {}
  const text = v.result.content[0].text
  return {
    ms: Date.now() - t0,
    changed: !!sc.changed,
    changes: sc.changes || 0,
    evidenceBytes: text.length,
    text,
  }
}

// ── Arms 2+3: pixel (snapdiff) and a11y (Playwright) on a plain page ─────────────────
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))
const diffSrc = (await readFile(join(REPO, 'node_modules/@zumer/snapdiff/src/diff.js'), 'utf8'))
  .replace(/^export /gm, '')

async function competitorArms(browser, name) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(await buildWrapper(name, 'manual'))
  await page.waitForTimeout(400)

  const t0 = Date.now()
  const a11yBefore = JSON.stringify(await page.accessibility.snapshot())
  const shotA = (await page.screenshot()).toString('base64')
  await page.evaluate('window.__runMutation()')
  await page.waitForTimeout(150)
  const shotB = (await page.screenshot()).toString('base64')
  const a11yAfter = JSON.stringify(await page.accessibility.snapshot())
  const msCapture = Date.now() - t0

  // decode + perceptual diff IN-PAGE (no node-side PNG decoder needed)
  const pix = await page.evaluate(async ({ a, b, diffCode }) => {
    (0, eval)(diffCode)
    const load = (b64) => new Promise((res) => {
      const img = new Image()
      img.onload = () => res(img)
      img.src = 'data:image/png;base64,' + b64
    })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = ia.width, h = ia.height
    const px = (img) => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const x = c.getContext('2d')
      x.drawImage(img, 0, 0)
      return x.getImageData(0, 0, w, h).data
    }
    const da = px(ia), db = px(ib)
    const out = new Uint8ClampedArray(da.length)
    const r = diffPixels(da, db, out, w, h, {})
    return { n: r.diff, total: r.total }
  }, { a: shotA, b: shotB, diffCode: diffSrc })
  await page.close()

  return {
    pixel: { changed: pix.n > 0, pct: +(100 * pix.n / pix.total).toFixed(3), ms: msCapture, evidenceBytes: shotA.length + shotB.length },
    a11y: { changed: a11yBefore !== a11yAfter, ms: msCapture, evidenceBytes: a11yBefore.length + a11yAfter.length },
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────
const fixtures = (await readdir(CORPUS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
console.error(`fixtures: ${fixtures.length}`)
const mcp = startMcp()
await mcp.call('initialize', { protocolVersion: '2024-11-05' })
const browser = await chromium.launch()

const rows = []
for (const name of fixtures) {
  const expected = JSON.parse(await readFile(join(CORPUS, name, 'expected.json'), 'utf8'))
  const url = await buildWrapper(name, 'auto')
  let oracle, comp
  try { oracle = await oracleArm(mcp, url) } catch (e) { oracle = { error: String(e).slice(0, 80) } }
  try { comp = await competitorArms(browser, name) } catch (e) { comp = { pixel: { error: String(e).slice(0, 80) }, a11y: { error: String(e).slice(0, 80) } } }
  const row = { name, expected: expected.changed, oracle, ...comp }
  // correctness: does the arm's boolean match the hand-written truth?
  row.oracleOk = oracle.error ? false : oracle.changed === expected.changed
  row.pixelOk = comp.pixel.error ? false : comp.pixel.changed === expected.changed
  row.a11yOk = comp.a11y.error ? false : comp.a11y.changed === expected.changed
  rows.push(row)
  console.error(`${name}: expected=${expected.changed} oracle=${oracle.changed ?? 'ERR'}(${row.oracleOk ? 'ok' : 'X'}) pixel=${comp.pixel.changed ?? 'ERR'}(${row.pixelOk ? 'ok' : 'X'}) a11y=${comp.a11y.changed ?? 'ERR'}(${row.a11yOk ? 'ok' : 'X'})`)
}

await browser.close()
mcp.srv.kill('SIGTERM')

// ── Report ───────────────────────────────────────────────────────────────────────────
const tally = (k) => rows.filter((r) => r[k]).length
const noise = rows.filter((r) => r.expected === false)
const real = rows.filter((r) => r.expected === true)
const fp = (arm) => noise.filter((r) => !r[`${arm}Ok`]).length
const miss = (arm) => real.filter((r) => !r[`${arm}Ok`]).length
const md = `# Change detection — this tool (through MCP) vs pixel difference vs accessibility tree

Date: ${new Date().toISOString().slice(0, 10)} · corpus: ${rows.length} cases with hand-written truth
(${real.length} with a real change, ${noise.length} NOISE cases: visible movement, no real change).
The tool arm runs THROUGH the MCP server (browser_open + browser_verify), so it measures the product.

## Overall

| Method | Right | False alarms (noise) | Missed changes | Says WHAT changed |
|---|---:|---:|---:|---|
| **This tool (browser_verify)** | **${tally('oracleOk')}/${rows.length}** | **${fp('oracle')}/${noise.length}** | ${miss('oracle')}/${real.length} | kind + role + name + selector |
| Pixel difference (pixelmatch class) | ${tally('pixelOk')}/${rows.length} | ${fp('pixel')}/${noise.length} | ${miss('pixel')}/${real.length} | a % of pixels, no meaning |
| Accessibility tree (Playwright) | ${tally('a11yOk')}/${rows.length} | ${fp('a11y')}/${noise.length} | ${miss('a11y')}/${real.length} | two JSON trees to diff yourself |

## Per case

| Case | Truth | This tool | Pixel | a11y | Evidence, tool | Evidence, pixel | Evidence, a11y |
|---|:---:|:---:|:---:|:---:|---:|---:|---:|
${rows.map((r) => `| ${r.name} | ${r.expected ? 'change' : 'noise'} | ${r.oracle.error ? 'ERR' : (r.oracleOk ? '✓' : `✗ (${r.oracle.changed})`)} | ${r.pixel.error ? 'ERR' : (r.pixelOk ? '✓' : `✗ (${r.pixel.pct}%)`)} | ${r.a11y.error ? 'ERR' : (r.a11yOk ? '✓' : '✗')} | ${r.oracle.evidenceBytes ?? '—'} B | ${r.pixel.evidenceBytes ? Math.round(r.pixel.evidenceBytes / 1024) + ' KB' : '—'} | ${r.a11y.evidenceBytes ? Math.round(r.a11y.evidenceBytes / 1024) + ' KB' : '—'} |`).join('\n')}

Honesty notes:
- The pixel comparison uses the SAME perceptual, anti-aliasing-aware algorithm from
  @zumer/snapdiff (pixelmatch class), not a naive compare.
- The accessibility tree only answers "does the JSON differ?". Working out WHAT changed is
  left to the caller, holding both full trees — that is what its evidence column measures.
- Evidence for this tool is the text browser_verify returns (kinds, names, selectors,
  ready for a model or an assertion). For pixels it is the TWO screenshots a person or a
  model would have to look at. For the accessibility tree it is the two trees to diff.
`
await writeFile(join(HERE, 'results', 'bench-qa.md'), md)
await writeFile(join(HERE, 'results', 'bench-qa.json'), JSON.stringify(rows, null, 2))
console.error('report → experiment/results/bench-qa.md')
process.exit(0)
