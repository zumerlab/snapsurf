import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { sensor } from '../packages/sensor/src/sensor.js'

const plugins = []

function makeCard(testid = 'card') {
  const card = document.createElement('section')
  card.setAttribute('data-testid', testid)
  card.style.cssText = 'position:relative;width:400px;min-height:120px;padding:12px'
  card.innerHTML = `
    <button data-testid="continue">Continue</button>
    <p data-testid="status" role="status">Ready</p>
  `
  document.body.appendChild(card)
  return card
}

const capture = (root, plugin) => snapdom(root, {
  plugins: [plugin],
  embedFonts: false,
  cache: 'disabled',
})

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose()
  document.body.innerHTML = ''
})

describe('sensor baseline continuity (fail-loud remount)', () => {
  it('declares HISTORY_NOT_CARRIED when the tracked root is remounted', async () => {
    const card = makeCard()
    const plugin = sensor()
    plugins.push(plugin)

    const first = await capture(card, plugin)
    expect((await first.toSensor()).localState.rootContinuity).toEqual({ status: 'ESTABLISHED' })

    // SPA-style remount: same shape, new Element identity.
    card.remove()
    const remounted = makeCard()
    const second = await capture(remounted, plugin)
    const report = await second.toSensor()

    expect(report.observation.status).toBe('BASELINE_ESTABLISHED')
    expect(report.localState.rootContinuity).toEqual({
      status: 'HISTORY_NOT_CARRIED',
      disconnectedPriorRoots: 1,
      possibleRemount: true,
    })
    expect(report.uncertainty.reasons).toContain('baseline-history-not-carried')
  })

  it('does not claim possibleRemount for a different-shaped successor', async () => {
    const card = makeCard()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(card, plugin)
    card.remove()
    const other = document.createElement('form')
    other.style.cssText = 'width:400px;min-height:120px'
    other.innerHTML = '<button>Send</button>'
    document.body.appendChild(other)

    const report = await (await capture(other, plugin)).toSensor()
    expect(report.localState.rootContinuity.status).toBe('HISTORY_NOT_CARRIED')
    expect(report.localState.rootContinuity.possibleRemount).toBeUndefined()
    expect(report.uncertainty.reasons).toContain('baseline-history-not-carried')
  })

  it('tracks parallel live roots without a false warning and stays CONTINUOUS afterwards', async () => {
    const cardA = makeCard('card-a')
    const cardB = makeCard('card-b')
    const plugin = sensor()
    plugins.push(plugin)

    await capture(cardA, plugin)
    const firstB = await (await capture(cardB, plugin)).toSensor()
    expect(firstB.localState.rootContinuity).toEqual({ status: 'ESTABLISHED' })
    expect(firstB.uncertainty.reasons).not.toContain('baseline-history-not-carried')

    cardA.querySelector('[data-testid="status"]').textContent = 'Saved'
    const secondA = await (await capture(cardA, plugin)).toSensor()
    expect(secondA.observation.status).toBe('DELTA_DETECTED')
    expect(secondA.localState.rootContinuity).toEqual({ status: 'CONTINUOUS' })
  })

  it('treats reset as explicit amnesia: no warning after reset()', async () => {
    const card = makeCard()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(card, plugin)
    card.remove()
    plugin.reset()

    const fresh = makeCard()
    const report = await (await capture(fresh, plugin)).toSensor()
    expect(report.localState.rootContinuity).toEqual({ status: 'ESTABLISHED' })
    expect(report.uncertainty.reasons).not.toContain('baseline-history-not-carried')
  })
})
