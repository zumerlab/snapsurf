import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import {
  sensor,
  SENSOR_PLUGIN_NAME,
  SENSOR_REPORT_CONTRACT,
} from '../packages/sensor/src/sensor.js'

const plugins = []

function fixture() {
  const root = document.createElement('main')
  root.style.cssText = 'position:relative;width:640px;min-height:240px;padding:20px'
  root.innerHTML = `
    <section data-testid="workspace">
      <button data-testid="mode" aria-pressed="false">Mode</button>
      <p data-testid="status" role="status">Ready</p>
      <button data-testid="continue">Continue</button>
    </section>
    <aside data-testid="outside"></aside>
  `
  document.body.appendChild(root)
  return {
    root,
    workspace: root.querySelector('[data-testid="workspace"]'),
    outside: root.querySelector('[data-testid="outside"]'),
  }
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

describe('SnapDOM sensor plugin', () => {
  it('is a standard plugin and binds each report to its own SnapDOM result', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    expect(plugin).toMatchObject({ name: SENSOR_PLUGIN_NAME })
    expect(typeof plugin.beforeSnap).toBe('function')
    expect(typeof plugin.afterClone).toBe('function')
    expect(typeof plugin.defineExports).toBe('function')
    expect(plugin.observe).toBeUndefined()
    expect(plugin.pure).toBeUndefined()

    const first = await capture(workspace, plugin)
    workspace.querySelector('[data-testid="mode"]').setAttribute('aria-pressed', 'true')
    workspace.querySelector('[data-testid="status"]').textContent = 'Saved'
    const second = await capture(workspace, plugin)

    // Read the first result after the second capture: per-capture binding must not return
    // a shared "latest report".
    const baseline = await first.toSensor()
    const report = await second.toSensor()

    expect(first.url).toMatch(/^data:image\/svg\+xml/)
    expect(typeof first.toPng).toBe('function')
    expect(baseline).toMatchObject({
      contract: SENSOR_REPORT_CONTRACT,
      taskAssessment: { status: 'NOT_ASSESSED' },
      observation: { status: 'BASELINE_ESTABLISHED' },
      coverage: {
        source: 'SNAPDOM_AFTER_CLONE_FRAME',
        engineFrame: {
          clonePrepared: true,
          nodeMapApplied: true,
          styleCacheApplied: true,
        },
      },
      visual: { svg: 'CAPTURED_BY_SNAPDOM' },
    })
    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.semanticDelta.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'state',
        beforeNode: expect.objectContaining({ state: expect.objectContaining({ pressed: false }) }),
        afterNode: expect.objectContaining({ state: expect.objectContaining({ pressed: true }) }),
      }),
      expect.objectContaining({
        kind: 'content',
        beforeNode: expect.objectContaining({ name: 'Ready' }),
        afterNode: expect.objectContaining({ name: 'Saved' }),
      }),
    ]))
    expect(report.localState).toMatchObject({
      priorState: 'OPAQUE_IN_MEMORY',
      checkpointEncoding: 'NOT_USED',
    })
    expect(report).not.toHaveProperty('expected')
    expect(report).not.toHaveProperty('outcome')
    expect(report).not.toHaveProperty('postcondition')
    expect(report).not.toHaveProperty('baseline')
    expect(report).not.toHaveProperty('checkpoint')
  })

  it('advances its private baseline and reports a quiet third capture', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(workspace, plugin)
    workspace.querySelector('[data-testid="status"]').textContent = 'Saved'
    const changed = await capture(workspace, plugin)
    const quiet = await capture(workspace, plugin)

    expect((await changed.toSensor()).observation.status).toBe('DELTA_DETECTED')
    expect((await quiet.toSensor()).observation).toMatchObject({
      status: 'NO_SUPPORTED_DELTA_DETECTED',
      semanticDelta: { total: 0 },
      renderedActionabilityDelta: {
        lost: { total: 0 },
        gained: { total: 0 },
      },
    })
  })

  it('scopes work to the element passed to SnapDOM and ignores a sibling secret', async () => {
    const { workspace, outside } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(workspace, plugin)
    outside.textContent = 'outside-secret-4b5f2d'
    const result = await capture(workspace, plugin)
    const report = await result.toSensor()

    expect(report.observation.status).toBe('NO_SUPPORTED_DELTA_DETECTED')
    expect(report.observation.semanticDelta.total).toBe(0)
    expect(JSON.stringify(report)).not.toContain('outside-secret-4b5f2d')
  })

  it('redacts its report without pretending to redact SnapDOM SVG', async () => {
    const { workspace } = fixture()
    workspace.querySelector('[data-testid="status"]').textContent = 'Secret account'
    const plugin = sensor({ privacy: { redact: ['Secret account'] } })
    plugins.push(plugin)

    const before = await capture(workspace, plugin)
    workspace.querySelector('[data-testid="status"]').textContent = 'Updated'
    const after = await capture(workspace, plugin)
    const report = await after.toSensor()

    expect(JSON.stringify(report)).not.toContain('Secret account')
    expect(report.privacy).toMatchObject({
      rulesActive: 1,
      literalRedaction: 'APPLIED_TO_SENSOR_REPORT',
      snapdomSvg: 'OUTSIDE_SENSOR_REPORT',
    })
    expect(decodeURIComponent(before.url)).toContain('Secret account')
  })

  it('accepts a same-origin iframe root from another JavaScript realm', async () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDocument = frame.contentDocument
    frameDocument.body.innerHTML = `
      <main id="scope">
        <button data-testid="mode" aria-pressed="false">Mode</button>
        <p data-testid="status" role="status">Ready</p>
      </main>
    `
    const scope = frameDocument.querySelector('#scope')
    const plugin = sensor()
    plugins.push(plugin)

    await capture(scope, plugin)
    scope.querySelector('[data-testid="mode"]').setAttribute('aria-pressed', 'true')
    scope.querySelector('[data-testid="status"]').textContent = 'Saved'
    const result = await capture(scope, plugin)
    const report = await result.toSensor()

    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.semanticDelta.total).toBe(2)
    plugin.reset(scope)
  })

  it('reports a button becoming covered by an external overlay', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)
    const button = workspace.querySelector('[data-testid="continue"]')

    await capture(workspace, plugin)
    const rect = button.getBoundingClientRect()
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', 'Private overlay label')
    overlay.style.cssText = [
      'position:fixed',
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${Math.max(1, rect.width)}px`,
      `height:${Math.max(1, rect.height)}px`,
      'z-index:2147483647',
      'background:white',
    ].join(';')
    document.body.appendChild(overlay)

    const result = await capture(workspace, plugin)
    const report = await result.toSensor()
    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.renderedActionabilityDelta.lost).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        role: 'button',
        name: 'Continue',
        covered: true,
        coveredBy: expect.objectContaining({ role: 'dialog', externalToScope: true }),
      })],
    })
    expect(JSON.stringify(report)).not.toContain('Private overlay label')
  })

  it('rejects predetermined outcomes and can reset or dispose its local history', async () => {
    const { workspace } = fixture()
    expect(() => sensor({ expected: { changed: true } })).toThrow(/does not support expected/)

    const plugin = sensor()
    plugins.push(plugin)
    await expect(snapdom(workspace, {
      plugins: [plugin], burst: true, embedFonts: false,
    })).rejects.toThrow(/burst:true is incompatible/)
    const first = await capture(workspace, plugin)
    await expect(first.toSensor({ expected: { changed: true } })).rejects.toThrow(
      /describes effects, not task success/,
    )

    plugin.reset(workspace)
    const restarted = await capture(workspace, plugin)
    expect((await restarted.toSensor()).observation.status).toBe('BASELINE_ESTABLISHED')

    plugin.dispose()
    await expect(capture(workspace, plugin)).rejects.toThrow(/plugin is disposed/)
    plugins.pop()
  })
})
