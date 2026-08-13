import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { sensor } from '../packages/sensor/src/sensor.js'

const plugins = []

function makeCard() {
  const card = document.createElement('section')
  card.setAttribute('data-testid', 'stage-card')
  card.style.cssText = 'position:relative;width:400px;min-height:120px;padding:12px'
  card.innerHTML = `
    <button data-testid="mode" aria-pressed="false">Mode</button>
    <p data-testid="status" role="status">Ready</p>
  `
  document.body.appendChild(card)
  return card
}

const capture = (root, plugin, extraPlugins = []) => snapdom(root, {
  plugins: [plugin, ...extraPlugins],
  embedFonts: false,
  cache: 'disabled',
})

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose()
  document.body.innerHTML = ''
})

describe('sensor × SnapDOM v3 stages', () => {
  it('default needs is render: full pipeline, SVG captured, frame walk', async () => {
    const card = makeCard()
    const plugin = sensor()
    plugins.push(plugin)

    const result = await capture(card, plugin)
    const report = await result.toSensor()
    expect(result.stage).toBe('render')
    expect(result.url).toMatch(/^data:image\/svg\+xml/)
    expect(report.coverage.source).toBe('SNAPDOM_AFTER_CLONE_FRAME')
    expect(report.coverage.stage).toBe('render')
    expect(report.visual.svg).toBe('CAPTURED_BY_SNAPDOM')
  })

  it("needs:'live' walks the live DOM, takes no clone, and says so", async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'live' })
    plugins.push(plugin)

    const first = await capture(card, plugin)
    expect(first.stage).toBe('live')
    const baseline = await first.toSensor()
    expect(baseline.observation.status).toBe('BASELINE_ESTABLISHED')
    expect(baseline.coverage.source).toBe('LIVE_DOM_WALK')
    expect(baseline.coverage.stage).toBe('live')
    expect(baseline.coverage.engineFrame.clonePrepared).toBe(false)
    expect(baseline.visual.svg).toBe('NOT_CAPTURED_STAGE_LIVE')
    expect(baseline.visual.raster).toBe('REQUEST_A_NEW_SCOPED_CAPTURE_WITH_CLIP')

    card.querySelector('[data-testid="mode"]').setAttribute('aria-pressed', 'true')
    const second = await capture(card, plugin)
    const report = await second.toSensor()
    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.semanticDelta.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'state' }),
    ]))

    // What was never produced is never faked: pixels must throw, not lie.
    await expect(Promise.resolve().then(() => second.toPng())).rejects.toThrow(/stage 'live'/)
  })

  it('another render plugin raises the stage and the sensor follows to the frame walk', async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'live' })
    plugins.push(plugin)
    const raise = { name: 'raise-to-render' }

    const result = await capture(card, plugin, [raise])
    const report = await result.toSensor()
    expect(result.stage).toBe('render')
    expect(report.coverage.source).toBe('SNAPDOM_AFTER_CLONE_FRAME')
    expect(result.url).toMatch(/^data:image\/svg\+xml/)
  })

  it("needs:'live' on a stage-less legacy runtime fails loud, never a silent clone", () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'live' })
    plugins.push(plugin)

    // A legacy runtime never stamps options.__stage. Simulate its beforeSnap call.
    expect(() => plugin.beforeSnap({ element: card, options: {} }))
      .toThrow(/staged SnapDOM runtime/)
  })

  it('declares drift in live mode when another live plugin mutates before the walk', async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'live' })
    plugins.push(plugin)
    const mutator = {
      name: 'live-mutator',
      needs: 'live',
      beforeClone() {
        card.querySelector('[data-testid="status"]').textContent = 'Drifted'
      },
    }

    // Mutator first: its beforeClone runs before the sensor's walk.
    const result = await snapdom(card, {
      plugins: [mutator, plugin],
      embedFonts: false,
      cache: 'disabled',
    })
    expect(result.stage).toBe('live')
    const report = await result.toSensor()
    expect(report.uncertainty.reasons).toContain('mutated-during-capture-prep')
  })

  it('rejects an unknown needs value early', () => {
    expect(() => sensor({ needs: 'pixels' })).toThrow(/needs must be/)
  })
})
