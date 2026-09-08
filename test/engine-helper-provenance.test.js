import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as engine from '../vendor/snapdom/dist/snapdom.mjs'
import * as publicSurf from '../src/index.js' // Capture entry binds provenance before observation.
import { observe, observeChunked, buildUi } from '../src/plugin.js'

const owned = engine.__snapdomIsInternalNode
const read = (previous) => buildUi(observe(document.body, { noise: 'none', previous }))
const readChunked = async (previous) => buildUi(await observeChunked(document.body, { noise: 'none', previous, budgetMs: 1 }))
const fixture = () => {
  const root = document.createElement('main')
  root.style.cssText = 'width:320px;padding:16px;background:white;color:black'
  root.innerHTML = '<h1>Capture QA</h1><button>Keep watching</button><p>Stable document</p>'
  document.body.append(root)
  return root
}
const rasterize = async (root) => {
  const result = await engine.snapdom(root, { embedFonts: false, dpr: 1 })
  const canvas = await result.toCanvas()
  expect(canvas.width).toBeGreaterThan(0)
  expect(canvas.height).toBeGreaterThan(0)
  const helpers = [...document.querySelectorAll('iframe')].filter(owned)
  expect(helpers.length).toBeGreaterThan(0) // Exercise the real decode host, not a mock.
  return helpers
}

describe('renderer helper provenance stays out of semantic observations', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  afterEach(() => { document.body.innerHTML = '' })

  it('real capture → observe stays unchanged without inventing an iframe blind spot', async () => {
    const root = fixture()
    const before = read()
    expect(before.unobservable).toEqual([])
    const previous = before.checkpoint()
    const helpers = await rasterize(root)

    for (const helper of helpers) helper.removeAttribute('data-snapdom-internal')
    expect(helpers.every(owned)).toBe(true) // Removing the public marker cannot remove provenance.
    for (const after of [read(previous), await readChunked(previous)]) {
      expect(after.changed).toBe(false)
      expect(after.changes).toEqual([])
      expect(after.unobservable).toEqual([])
      expect([...after.__snapshot.elements.values()].some(owned)).toBe(false)
    }
    expect(engine.markInternalNode).toBeUndefined()
    expect(publicSurf.bindEngineOwnership).toBeUndefined()
    expect(publicSurf.isEngineInternalNode).toBeUndefined()
  })

  it('forged public markers cannot conceal authored controls or iframe blind spots', async () => {
    const root = fixture()
    const button = root.querySelector('button')
    button.setAttribute('data-snapdom-internal', '')
    button.setAttribute('data-snapdom-sandbox', '')
    button.setAttribute('data-snapdom', 'injected-import')
    button.id = 'snapdom-sandbox'
    expect(owned(button)).toBe(false)
    const before = read()
    const previous = before.checkpoint()
    button.textContent = 'Author change remains visible'

    const forged = document.createElement('iframe')
    forged.setAttribute('data-snapdom-internal', '')
    forged.setAttribute('aria-hidden', 'true')
    forged.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none'
    document.body.append(forged)
    expect(owned(forged)).toBe(false)
    await rasterize(root)

    const after = await readChunked(previous)
    expect(after.changed).toBe(true)
    expect(after.getByRole('button', { name: 'Author change remains visible' })).not.toBeNull()
    expect(after.__snapshot.byElement.has(button)).toBe(true)
    expect(after.__snapshot.byElement.has(forged)).toBe(true)
    expect(after.unobservable.filter((node) => node.sourceType === 'iframe')).toHaveLength(1)
    expect([...after.__snapshot.elements.values()].some(owned)).toBe(false)
  })
})
