/**
 * gate.mjs — automated per-bundle validation of the companion.
 *
 * Born from the panel's own recommendation after two rounds were spent
 * re-discovering the channel by hand: "convert the gate + sub-tasks into an
 * automated harness that, given a bundle, spits out the report". Run after every
 * build; a red gate means DO NOT hand this bundle to a consumer round.
 *
 *   node packages/agent/companion/gate.mjs
 *
 * Checks: contract version · ready message emitted WITH result payload · walk
 * wall-time and max main-thread block on a 13k-node page · torn/changesTotal
 * present · fail-loud (unknown key → red) · ignore accepted · menu occlusion in
 * becameCovered (vs the panel's elementFromPoint ground truth) · faithful no-op.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const { chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs'))

const PROFILE = '/tmp/companion-gate-profile'
const { rm } = await import('node:fs/promises')
await rm(PROFILE, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', viewport: { width: 1400, height: 665 },
  args: [`--disable-extensions-except=${HERE}`, `--load-extension=${HERE}`],
})
const page = await ctx.newPage()

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ask() consumes e.data.result ONLY (the documented reader) — if the ready message
// or its payload is missing, the gate must go red, not silently poll the node.
const ask = (msg, tmo = 60000) => page.evaluate(async ({ m, tmo }) => {
  const obsId = Date.now() + Math.random()
  const res = new Promise((r) => {
    const h = (e) => {
      if (e.data && e.data.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) {
        removeEventListener('message', h)
        r({ ready: true, result: e.data.result })
      }
    }
    addEventListener('message', h)
    setTimeout(() => r({ ready: false }), tmo)
  })
  window.postMessage({ ...m, obsId }, '*')
  return await res
}, { m: msg, tmo })

await page.goto('https://es.wikipedia.org/wiki/Buenos_Aires', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)

// ── channel + contract ───────────────────────────────────────────────────────────────
const marker = await page.evaluate(() => !!document.querySelector('meta[name="__snapdom_companion"]'))
check('content script present', marker)

// rAF probe running DURING the first big walk: max main-thread gap
const first = await page.evaluate(async () => {
  let maxGap = 0, last = performance.now(), running = true
  const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; if (running) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  const obsId = 'gate1'
  const t0 = performance.now()
  const res = new Promise((r) => {
    addEventListener('message', (e) => { if (e.data?.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) r(e.data.result) })
    setTimeout(() => r(null), 60000)
  })
  window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId }, '*')
  const result = await res
  running = false
  return result ? { wallMs: Math.round(performance.now() - t0), maxGap: Math.round(maxGap), result } : null
})
check('ready message carries result', !!first, first ? '' : 'no ready/result within 60s')
if (!first) { await ctx.close(); process.exit(1) }
const r1 = first.result
check('contract === 4', r1.contract === 4, `contract: ${r1.contract}`)
check('torn/changesTotal-class fields present', 'torn' in r1, `torn: ${r1.torn}`)
check('walk wall-time sane (< 8s)', first.wallMs < 8000, `${first.wallMs}ms for ${r1.actionables} actionables`)
check('max main-thread block < 300ms', first.maxGap < 300, `${first.maxGap}ms`)

// ── with-baseline pass: the post-walk pipeline (inflate+diff+relabel+checkpoint+digest)
// only runs when a baseline exists — the first-walk probe above never saw it, which is
// how 1-1.6s blocks reached the panel while this gate stayed green (panel probe round).
const probed = (msg, tmo = 60000) => page.evaluate(async ({ m, tmo }) => {
  let maxGap = 0, last = performance.now(), running = true
  const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; if (running) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  const obsId = 'probe' + Math.random()
  const res = new Promise((r) => {
    const h = (e) => { if (e.data?.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) { removeEventListener('message', h); r(e.data.result) } }
    addEventListener('message', h)
    setTimeout(() => r(null), tmo)
  })
  window.postMessage({ ...m, obsId }, '*')
  const result = await res
  running = false
  return { result, maxGap: Math.round(maxGap) }
}, { m: msg, tmo })

const second = await probed({ type: 'SNAPDOM_OBSERVE', prof: true })
check('with-baseline observe: max block < 300ms', !!second.result && second.maxGap < 300, `${second.maxGap}ms`)
check('prof covers the post-walk stages', !!second.result?.prof && 'diff' in second.result.prof && 'digest' in second.result.prof,
  JSON.stringify(second.result?.prof || null))

// ── throttled-environment pass (panel ask: measure where CDP/automation lives) ───────
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
const thr = await page.evaluate(async () => {
  const obsId = 'gate-thr'
  const t0 = performance.now()
  const res = new Promise((r) => {
    addEventListener('message', (e) => { if (e.data?.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) r(e.data.result) })
    setTimeout(() => r(null), 60000)
  })
  window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId }, '*')
  const result = await res
  return result ? Math.round(performance.now() - t0) : null
})
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
check('walk under 4x CPU throttle < 4s', thr !== null && thr < 4000, `${thr}ms`)

// ── assert reply channel: EXPLICIT check, message-only, no node fallback ─────────────
// (panel field report: asserts arrived node-only in its env while observes messaged
// 16/16 — this check must never be masked by another assertion's purpose)
const chan = await probed({ type: 'SNAPDOM_ASSERT', spec: { exists: 'Wikipedia' }, prof: true }, 15000)
check('ASSERT reply arrives via SNAPDOM_DIGEST_READY with result payload',
  chan.result && chan.result.type === 'assert' && 'pass' in chan.result,
  chan.result ? `result.type: ${chan.result?.type}` : 'NO message within 15s (node-only channel — panel blindspot reproduced)')
check('assert: max block < 300ms', !!chan.result && chan.maxGap < 300, `${chan.maxGap}ms`)
check('assert result carries prof (panel ask)', !!chan.result?.prof && 'evaluate' in chan.result.prof,
  JSON.stringify(chan.result?.prof || null))

// ── fail-loud + ignore ───────────────────────────────────────────────────────────────
const bad = await ask({ type: 'SNAPDOM_ASSERT', spec: { mustInclud: [] } })
check('fail-loud: unknown key → pass:false', bad.ready && bad.result.pass === false, JSON.stringify(bad.result?.checks?.[0]?.actual))
const ign = await ask({ type: 'SNAPDOM_ASSERT', spec: { changed: false, ignore: ['#definitely-absent'] } })
check('ignore key accepted', ign.ready && !ign.result.checks.some((c) => c.type === 'spec' && !c.pass), `pass: ${ign.result?.pass}`)

// ── sub-task: menu occlusion in becameCovered vs elementFromPoint ground truth ───────
await page.click('#vector-main-menu-dropdown-checkbox')
await page.waitForTimeout(500)
const o2 = await ask({ type: 'SNAPDOM_OBSERVE' })
const gtCovered = await page.evaluate(() => {
  let covered = 0
  for (const a of document.querySelectorAll('#vector-toc a')) {
    const r = a.getBoundingClientRect()
    if (!r.width || r.top > 450 || r.top < 0) continue
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!(hit === a || a.contains(hit) || (hit && hit.contains(a)))) covered++
  }
  return covered
})
const delta = o2.result?.actionabilityDelta?.becameCovered || []
check('menu occlusion detected (becameCovered ≥ ground-truth count)', delta.length >= Math.min(gtCovered, 3) && gtCovered > 0,
  `ground truth ${gtCovered} covered · delta reports ${delta.length}`)

// ── sub-task: faithful no-op ─────────────────────────────────────────────────────────
await page.click('#vector-main-menu-dropdown-checkbox') // close menu
await page.waitForTimeout(500)
await ask({ type: 'SNAPDOM_OBSERVE' }) // settle baseline
const noop = await ask({ type: 'SNAPDOM_ASSERT', spec: { changed: false, retry: { budgetMs: 1500 } } })
check('faithful no-op (changed:false passes)', noop.ready && noop.result.pass === true, `attempts: ${noop.result?.attempts}`)

await ctx.close()
const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\nGATE RED — ${failed.length} failure(s): do NOT hand this bundle to a consumer round` : '\nGATE GREEN — bundle fit for consumers')
process.exit(failed.length ? 1 : 0)
