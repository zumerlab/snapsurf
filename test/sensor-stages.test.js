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
    expect(result.needs).toBe('render')
    expect(result.url).toMatch(/^data:image\/svg\+xml/)
    expect(report.coverage.source).toBe('SNAPDOM_AFTER_CLONE_FRAME')
    expect(report.coverage.stage).toBe('render')
    expect(report.visual.svg).toBe('CAPTURED_BY_SNAPDOM')
  })

  it("needs:'clone' prepares the frame without rendering pixels", async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'clone' })
    plugins.push(plugin)

    const first = await capture(card, plugin)
    expect(first.needs).toBe('clone')
    const baseline = await first.toSensor()
    expect(baseline.observation.status).toBe('BASELINE_ESTABLISHED')
    expect(baseline.coverage.source).toBe('SNAPDOM_AFTER_CLONE_FRAME')
    expect(baseline.coverage.stage).toBe('clone')
    expect(baseline.coverage.engineFrame.clonePrepared).toBe(true)
    expect(baseline.visual.svg).toBe('NOT_RENDERED_STAGE_CLONE')
    expect(baseline.visual.raster).toBe('REQUEST_A_NEW_SCOPED_CAPTURE_WITH_CLIP')

    card.querySelector('[data-testid="mode"]').setAttribute('aria-pressed', 'true')
    const second = await capture(card, plugin)
    const report = await second.toSensor()
    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.semanticDelta.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'state' }),
    ]))

    // What was never produced is never faked: pixels must throw, not lie.
    await expect(Promise.resolve().then(() => second.toPng())).rejects.toThrow(/clone/)
  })

  it.each(['live', 'dom'])('rejects removed stage %s before capture', (needs) => {
    expect(() => sensor({ needs })).toThrow(/'clone' or 'render'.*removed/)
  })

  it('another render plugin raises the stage and the sensor follows to the frame walk', async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'clone' })
    plugins.push(plugin)
    const raise = { name: 'raise-to-render' }

    const result = await capture(card, plugin, [raise])
    const report = await result.toSensor()
    expect(result.needs).toBe('render')
    expect(report.coverage.source).toBe('SNAPDOM_AFTER_CLONE_FRAME')
    expect(result.url).toMatch(/^data:image\/svg\+xml/)
  })

  it("needs:'clone' on a stage-less legacy runtime fails loud, never a silent clone", () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'clone' })
    plugins.push(plugin)

    // A legacy runtime never stamps the resolved stage on options.needs.
    expect(() => plugin.beforeSnap({ element: card, options: {} }))
      .toThrow(/staged SnapDOM runtime/)
  })

  it('declares drift when another clone plugin mutates before the frame walk', async () => {
    const card = makeCard()
    const plugin = sensor({ needs: 'clone' })
    plugins.push(plugin)
    const mutator = {
      name: 'clone-mutator',
      needs: 'clone',
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
    expect(result.needs).toBe('clone')
    const report = await result.toSensor()
    expect(report.uncertainty.reasons).toContain('mutated-during-capture-prep')
  })

  it('rejects an unknown needs value early', () => {
    expect(() => sensor({ needs: 'pixels' })).toThrow(/needs must be/)
  })
})
