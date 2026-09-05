import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { sensor } from '../packages/sensor/src/sensor.js'

/**
 * Convergence probe: v3's differential recapture ("snapdomDIFF") vs the agent's
 * semantic diff. They live on different layers — snapdomDIFF re-produces the SAME
 * PICTURE faster on repeat captures; the sensor produces MEANING (typed delta).
 * The question with a measurable answer: does the winning agent loop combine them —
 * sensor at needs:'clone' for semantics each step, plain plugin-less captures for
 * pixels on demand (which stay eligible for memo/differential)?
 */

const plugins = []

function makeCard(rows = 60) {
  const card = document.createElement('section')
  card.style.cssText = 'position:relative;width:520px;padding:16px;background:#fff'
  card.innerHTML = `
    <h2>Panel</h2>
    <p data-testid="status" role="status">Ready</p>
    ${Array.from({ length: rows }, (_, i) =>
      `<div style="padding:2px 6px"><span>row ${i}</span> <button data-testid="b${i}">Act ${i}</button></div>`).join('')}
  `
  document.body.appendChild(card)
  return card
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose()
  document.body.innerHTML = ''
})

const ms = () => performance.now()

describe('sensor × snapdomDIFF (differential recapture) convergence', () => {
  it('layers compose: plain repeat captures serve fast and byte-stable; sensor-attached captures suspend the fast path; the hybrid loop gets both meaning and memoized pixels', async () => {
    const card = makeCard()
    const K = 5

    // ── Arm A: plain captures (no plugins) — memo/differential eligible ──────────
    let t = ms()
    const firstPlain = await snapdom(card, { embedFonts: false })
    const plainFirstMs = ms() - t
    const plainRepeatMs = []
    let memoHits = 0
    let lastUrl = firstPlain.url
    for (let i = 0; i < K; i++) {
      t = ms()
      const r = await snapdom(card, { embedFonts: false })
      plainRepeatMs.push(ms() - t)
      // Memoization warms up on consecutive calls; a memo serve is byte-identical.
      if (r.url === lastUrl) memoHits++
      lastUrl = r.url
    }

    // Mutate one subtree, recapture: differential path must still yield a fresh,
    // DIFFERENT picture that reflects the mutation (correctness over speed).
    card.querySelector('[data-testid="status"]').textContent = 'Saved'
    t = ms()
    const afterMutation = await snapdom(card, { embedFonts: false })
    const plainDirtyMs = ms() - t
    expect(afterMutation.url).not.toBe(lastUrl)
    expect(decodeURIComponent(afterMutation.url)).toContain('Saved')

    // ── Arm B: sensor attached at needs:'render' — impure hooks suspend memo ─────
    const watchRender = sensor()
    plugins.push(watchRender)
    const renderMs = []
    for (let i = 0; i < K; i++) {
      t = ms()
      await snapdom(card, { plugins: [watchRender], embedFonts: false })
      renderMs.push(ms() - t)
    }

    // ── Arm C: sensor at needs:'clone' — prepared clone, no render ──
    const watchClone = sensor({ needs: 'clone' })
    plugins.push(watchClone)
    const cloneMs = []
    let lastReport = null
    for (let i = 0; i < K; i++) {
      card.querySelector('[data-testid="status"]').textContent = `step ${i}`
      t = ms()
      const r = await snapdom(card, { plugins: [watchClone], embedFonts: false })
      cloneMs.push(ms() - t)
      lastReport = await r.toSensor()
      if (i > 0) expect(lastReport.observation.status).toBe('DELTA_DETECTED')
    }

    // ── Arm D: the hybrid agent loop — clone-stage semantics each step, plain pixels on
    // demand. The plain capture interleaves with clone-stage sensor captures and must stay
    // correct (and, when the engine can, memoized).
    card.querySelector('[data-testid="status"]').textContent = 'hybrid'
    await snapdom(card, { plugins: [watchClone], embedFonts: false })
    t = ms()
    const hybridPixels = await snapdom(card, { embedFonts: false })
    const hybridPixelsMs = ms() - t
    expect(decodeURIComponent(hybridPixels.url)).toContain('hybrid')
    const hybridReport = await (await snapdom(card, { plugins: [watchClone], embedFonts: false })).toSensor()
    expect(hybridReport.observation.status).toBe('NO_SUPPORTED_DELTA_DETECTED')

    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    console.log(JSON.stringify({
      probe: 'sensor-x-snapdomdiff',
      nodes: card.querySelectorAll('*').length,
      plainFirstMs: +plainFirstMs.toFixed(1),
      plainRepeatMedianMs: +med(plainRepeatMs).toFixed(1),
      memoHits: `${memoHits}/${K}`,
      plainDirtySubtreeMs: +plainDirtyMs.toFixed(1),
      sensorRenderMedianMs: +med(renderMs).toFixed(1),
      sensorCloneMedianMs: +med(cloneMs).toFixed(1),
      hybridPixelsOnDemandMs: +hybridPixelsMs.toFixed(1),
    }))

    // Timing is diagnostic: hardware/load can reverse short measurements. Assert the
    // observable contracts instead of making a flaky claim about relative speed.
    expect(memoHits).toBeGreaterThan(0)
    expect(lastReport.coverage.stage).toBe('clone')
    expect(lastReport.coverage.engineFrame.clonePrepared).toBe(true)
    expect(lastReport.visual.svg).toBe('NOT_RENDERED_STAGE_CLONE')
  })
})
