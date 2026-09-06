import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { gifExport } from '../vendor/snapdom/plugins/gif-export.js'
import { videoExport } from '../vendor/snapdom/plugins/video-export.js'
import { agentOracle } from '../src/plugin.js'
import { inspect } from '../src/index.js'
import { sensor } from '../packages/sensor/src/sensor.js'
import { sensor as bundledSensor } from '../packages/sensor/dist/snapdom-sensor.js'

const sensors = []
afterEach(() => {
  for (const plugin of sensors.splice(0)) plugin.dispose()
  document.body.innerHTML = ''
})
function fixture() {
  const el = document.createElement('section')
  el.style.cssText = 'position:relative;width:180px;height:100px;background:white'
  el.innerHTML = '<div class="private" style="width:40px;height:30px;background:red">Hidden account</div><button title="Hidden title" aria-label="Hidden label">Public action</button><input type="email" value="private@example.test"><textarea class="field">Typed secret</textarea>'
  document.body.append(el)
  return el
}
const rules = {
  all: true,
  blocks: '.private',
  attributes: [{ selector: 'button', names: ['title', 'aria-label'] }],
}
const capture = (el, plugins) => snapdom(el, { plugins, embedFonts: false, dpr: 1 })
const forbidden = ['Hidden account', 'Hidden title', 'Hidden label', 'private@example.test', 'Typed secret']
function assertSafe(wire) {
  for (const secret of forbidden) expect(wire).not.toContain(secret)
}

describe('captureRedaction opt-in', () => {
  it('preserves default pixels and sanitizes the selected clone and semantic projections', async () => {
    const el = fixture()
    const original = el.outerHTML
    const plain = await capture(el, [agentOracle()])
    expect(decodeURIComponent(plain.url)).toContain('private@example.test')
    expect(decodeURIComponent(plain.url)).toContain('Hidden account')
    expect(await plain.toAgentContext()).not.toContain('Typed secret')
    expect(JSON.stringify(await plain.toAgentMap())).not.toContain('Typed secret')
    const result = await capture(el, [agentOracle({ captureRedaction: rules })])
    assertSafe(decodeURIComponent(result.url))
    const map = await result.toAgentMap()
    assertSafe(JSON.stringify(map))
    assertSafe(await result.toAgentContext())
    assertSafe(JSON.stringify(await result.toCheckpoint()))
    expect(map.map.some(entry => entry.n === 'Public action')).toBe(true)
    const pixels = (await result.toCanvas()).getContext('2d').getImageData(10, 10, 1, 1).data
    expect([...pixels]).toEqual([255, 255, 255, 255])
    expect(el.outerHTML).toBe(original)
    expect(el.querySelector('input').value).toBe('private@example.test')
  })

  it('filters ancestor names, external labels and labels assigned inside blocked shadow content', async () => {
    const el = fixture()
    const host = document.createElement('div')
    host.innerHTML = '<span id="outside-private" slot="label">Outside secret</span>'
    host.attachShadow({ mode: 'open' }).innerHTML = '<section class="private"><slot name="label"></slot></section>'
    document.body.append(host)
    el.querySelector('button').setAttribute('aria-labelledby', 'outside-private')
    const result = await capture(el, [agentOracle({ captureRedaction: rules })])
    const wire = JSON.stringify(await result.toAgentMap()) + await result.toAgentContext()
    assertSafe(wire)
    expect(wire).not.toContain('Outside secret')
    expect(wire).toContain('Public action')
  })

  it('omits direct label text assigned to a blocked shadow slot before names and checkpoints', async () => {
    const el = fixture()
    const host = document.createElement('div')
    host.id = 'slotted-label'
    host.innerHTML = 'Direct slot secret<span slot="public">Public label</span>'
    host.attachShadow({ mode: 'open' }).innerHTML = '<section class="private"><slot></slot></section><slot name="public"></slot>'
    document.body.append(host)
    const button = el.querySelector('button')
    button.removeAttribute('aria-label')
    button.setAttribute('aria-labelledby', host.id)
    const plain = await capture(el, [agentOracle()])
    expect(JSON.stringify(await plain.toAgentMap())).toContain('Direct slot secret')
    const first = await capture(el, [agentOracle({ captureRedaction: rules })])
    const previous = await first.toCheckpoint()
    const map = await first.toAgentMap()
    expect(map.map.some(entry => entry.n === 'Public label')).toBe(true)
    const wire = JSON.stringify(map) + await first.toAgentContext() + JSON.stringify(previous)
    expect(wire).not.toContain('Direct slot secret')
    expect(host.firstChild.nodeValue).toBe('Direct slot secret')
    host.firstChild.nodeValue = 'Changed slot secret'
    const second = await capture(el, [agentOracle({ captureRedaction: rules, previous })])
    expect((await second.toChanges()).changed).toBe(false)
  })

  it('does not fingerprint removed attributes or typed values in later checkpoints', async () => {
    const el = fixture()
    const link = document.createElement('a')
    link.href = '/private-token-one'; link.textContent = 'Public destination'; el.append(link)
    const captureRedaction = { ...rules, attributes: [...rules.attributes, { selector: 'a', names: ['href'] }] }
    const first = await capture(el, [agentOracle({ captureRedaction })])
    const previous = await first.toCheckpoint()
    link.href = '/private-token-two'
    el.querySelector('textarea').value = 'A much longer secret than before'
    const second = await capture(el, [agentOracle({ captureRedaction, previous })])
    expect((await second.toChanges()).changed).toBe(false)
  })

  it('does not derive a select value from blocked option text or a removed option attribute', async () => {
    const el = fixture()
    const select = document.createElement('select')
    select.style.width = '120px'
    const option = document.createElement('option')
    option.append('Public ', Object.assign(document.createElement('span'), { className: 'private', textContent: 'Choice secret' }))
    select.append(option); el.append(select)
    const policy = { blocks: '.private', attributes: [{ selector: 'option', names: ['value'] }] }
    const first = await capture(el, [agentOracle({ captureRedaction: policy })])
    const previous = await first.toCheckpoint()
    option.querySelector('span').textContent = 'Changed choice secret'
    const second = await capture(el, [agentOracle({ captureRedaction: policy, previous })])
    expect((await second.toChanges()).changed).toBe(false)
    expect(await second.toAgentContext()).not.toContain('Choice secret')
    option.value = 'private-option-token'
    const third = await capture(el, [agentOracle({ captureRedaction: policy })])
    const selectEntry = (await third.toAgentMap()).map.find(entry => entry.r === 'combobox')
    expect(selectEntry.s.value).toBeUndefined()
  })

  it('shares policy across sensor clone/render captures and preserves old reports', async () => {
    const el = fixture()
    const plugin = sensor({ needs: 'clone', captureRedaction: rules })
    sensors.push(plugin)
    const first = await capture(el, [plugin])
    const before = await first.toSensor()
    el.querySelector('button').textContent = 'Updated public action'
    const next = await capture(el, [plugin])
    const report = await next.toSensor()
    assertSafe(JSON.stringify(report))
    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.privacy.captureRedaction).toBe('SELECTED_FIELDS_BLOCKS_ATTRIBUTES')
    expect(await first.toSensor()).toEqual(before)
    const render = await capture(el, [plugin, { name: 'raise-to-render' }])
    assertSafe(decodeURIComponent(render.url))
  })

  it('keeps scoped rasterization redacted when inspect() captures a new region', async () => {
    const el = fixture()
    const ui = await inspect(el, { captureRedaction: rules, capture: { embedFonts: false } })
    const target = ui.getByRole('button')
    expect(target).toBeTruthy()
    const image = await ui.rasterize(target)
    assertSafe(decodeURIComponent(image.url))
    expect(decodeURIComponent(image.url)).toContain('Public action')
  })

  it.each(['gif', 'video'])('keeps policy for every deferred %s frame', async (kind) => {
    const el = fixture()
    const frames = []
    const observer = { name: 'audit-frame', beforeRender(ctx) { frames.push(ctx.clone.outerHTML) } }
    const recorder = kind === 'gif' ? gifExport() : videoExport()
    const result = await capture(el, [agentOracle({ captureRedaction: rules }), observer, recorder])
    frames.length = 0
    el.querySelector('.private').textContent = 'Hidden account after capture'
    const blob = kind === 'gif'
      ? await result.toGif({ frames: 2, fps: 10 })
      : await result.toMp4({ frames: 2, fps: 10 })
    expect(blob.size).toBeGreaterThan(0)
    expect(frames.length).toBe(2)
    for (const frame of frames) assertSafe(frame)
  })

  it('requires a fresh baseline when capture redaction is enabled, removed or changed', async () => {
    const el = fixture()
    const plain = await capture(el, [agentOracle()])
    const previous = await plain.toCheckpoint()
    expect(() => agentOracle({ captureRedaction: rules, previous })).toThrow(/new baseline/)
    const hidden = await capture(el, [agentOracle({ captureRedaction: rules })])
    const safePrevious = JSON.parse(JSON.stringify(await hidden.toCheckpoint()))
    expect(() => agentOracle({ previous: safePrevious })).toThrow(/new baseline/)
    expect(() => agentOracle({ captureRedaction: { all: true }, previous: safePrevious })).toThrow(/new baseline/)
    const continued = await capture(el, [agentOracle({ captureRedaction: rules, previous: safePrevious })])
    assertSafe(JSON.stringify(await continued.toChanges()))
  })

  it('rejects conflicting composed redactors instead of overwriting the capture policy', async () => {
    const el = fixture()
    const watcher = sensor({ captureRedaction: { all: true } })
    sensors.push(watcher)
    await expect(capture(el, [agentOracle({ captureRedaction: rules }), watcher])).rejects.toThrow(/Only one captureRedaction/)
    expect(el.querySelector('.private').textContent).toBe('Hidden account')
  })

  it.each(['oracle-first', 'sensor-first'])('rejects source/bundle redactor conflicts in %s order', async (order) => {
    const el = fixture()
    const watcher = bundledSensor({ captureRedaction: { all: false } })
    sensors.push(watcher)
    const oracle = agentOracle({ captureRedaction: rules })
    const plugins = order === 'oracle-first' ? [oracle, watcher] : [watcher, oracle]
    await expect(capture(el, plugins)).rejects.toThrow(/Only one captureRedaction/)
    expect(el.querySelector('input').value).toBe('private@example.test')
  })

  it.each([
    ['oracle', 'oracle-first'], ['oracle', 'sensor-first'],
    ['sensor', 'oracle-first'], ['sensor', 'sensor-first'],
  ])('rejects a protected %s with an unconfigured reader in %s order', async (protectedReader, order) => {
    const el = fixture()
    const watcher = bundledSensor(protectedReader === 'sensor' ? { captureRedaction: rules } : {})
    sensors.push(watcher)
    const oracle = agentOracle(protectedReader === 'oracle' ? { captureRedaction: rules } : {})
    const plugins = order === 'oracle-first' ? [oracle, watcher] : [watcher, oracle]
    await expect(capture(el, plugins)).rejects.toThrow(/unconfigured semantic reader/)
    expect(el.querySelector('input').value).toBe('private@example.test')
  })

  it('isolates differently configured concurrent captures and keeps literal privacy separate', async () => {
    const a = fixture(), b = fixture()
    const [hidden, plain] = await Promise.all([
      capture(a, [agentOracle({ captureRedaction: rules })]),
      capture(b, [agentOracle({ privacy: { redact: ['Hidden account'] } })]),
    ])
    assertSafe(await hidden.toAgentContext())
    expect(await plain.toAgentContext()).not.toContain('Hidden account')
    expect(decodeURIComponent(plain.url)).toContain('Hidden account')
    expect(await plain.toAgentContext()).not.toContain('Typed secret')
    expect(JSON.stringify(await plain.toAgentMap())).not.toContain('Typed secret')
  })
})
