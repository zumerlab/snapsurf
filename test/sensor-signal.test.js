import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { sensor } from '../packages/sensor/src/sensor.js'

const plugins = []

function fixture() {
  const root = document.createElement('main')
  root.style.cssText = 'position:relative;width:640px;min-height:240px;padding:20px'
  root.innerHTML = `
    <section data-testid="workspace">
      <button data-testid="mode" aria-pressed="false">Mode</button>
      <p data-testid="status" role="status">Ready</p>
      <span data-testid="spacer" style="display:inline-block;width:10px"></span>
      <button data-testid="continue">Continue</button>
    </section>
  `
  document.body.appendChild(root)
  return { root, workspace: root.querySelector('[data-testid="workspace"]') }
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

describe('sensor signal quality (folds, geometry rollup, capture drift)', () => {
  it('folds wrapper chains of an added subtree but keeps totals honest', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(workspace, plugin)

    // A dropdown-style insertion: two generic wrappers around the salient content.
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const option = document.createElement('button')
    option.textContent = 'Suggestion one'
    const label = document.createElement('p')
    label.textContent = 'historian (1939)'
    inner.appendChild(option)
    inner.appendChild(label)
    outer.appendChild(inner)
    workspace.appendChild(outer)

    const report = await (await capture(workspace, plugin)).toSensor()
    const delta = report.observation.semanticDelta

    expect(report.observation.status).toBe('DELTA_DETECTED')
    // Bounded invariant holds over the SIGNAL list; folded wrappers are counted
    // separately and explicitly. Full diff = total + foldedWrappers.
    expect(delta.foldedWrappers).toBeGreaterThanOrEqual(1)
    expect(delta.items.length + delta.truncated).toBe(delta.total)
    expect(delta.total + delta.foldedWrappers).toBeGreaterThanOrEqual(4)
    const names = delta.items.map((i) => i.afterNode?.name || i.afterNode?.text || i.name || '')
    expect(names.join('|')).toContain('Suggestion one')
    const kinds = delta.items.filter((i) => i.kind === 'added')
    expect(kinds.length).toBeLessThan(4)
  })

  it('never folds a named (aria-label) wrapper nor removed-side nodes', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(workspace, plugin)
    const outer = document.createElement('div')
    const labeled = document.createElement('div')
    labeled.setAttribute('aria-label', 'New messages')
    labeled.innerHTML = '<button>Open</button>'
    outer.appendChild(labeled)
    workspace.appendChild(outer)
    const added = await (await capture(workspace, plugin)).toSensor()
    const addedNames = added.observation.semanticDelta.items.map((i) => i.afterNode?.name || i.name || '')
    expect(addedNames.join('|')).toContain('New messages')

    // Removed subtrees are NEVER folded: the before side may lack the node facts
    // (checkpoint baselines) that make folding safe.
    outer.remove()
    const removed = await (await capture(workspace, plugin)).toSensor()
    expect(removed.observation.semanticDelta.foldedWrappers).toBeUndefined()
    expect(removed.observation.semanticDelta.total).toBeGreaterThanOrEqual(3)
  })

  it('does not claim drift when a prep mutation is restored before the walk (engine pattern)', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)
    const status = workspace.querySelector('[data-testid="status"]')
    const restoreMutator = {
      name: 'restore-mutator',
      beforeClone() {
        const original = status.textContent
        status.textContent = 'measuring…'
        status.textContent = original
      },
    }

    const report = await (await capture(workspace, plugin, [restoreMutator])).toSensor()
    expect(report.uncertainty.reasons).not.toContain('mutated-during-capture-prep')
    expect(report.coverage.engineFrame.driftWatch).toBe('NET_OF_ENGINE_PREP')
  })

  it('flags a pure reflow as geometryOnly', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    await capture(workspace, plugin)
    // margin-left is not in the visual style subset: siblings shift, nothing else
    workspace.querySelector('[data-testid="spacer"]').style.width = '160px'
    const report = await (await capture(workspace, plugin)).toSensor()

    expect(report.observation.status).toBe('DELTA_DETECTED')
    expect(report.observation.semanticDelta.geometryOnly).toBe(true)
    for (const item of report.observation.semanticDelta.items) {
      expect(['moved', 'resized']).toContain(item.kind)
    }
  })

  it('declares DOM drift between beforeSnap and afterClone', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)
    const mutator = {
      name: 'test-mutator',
      beforeClone() {
        workspace.querySelector('[data-testid="status"]').textContent = 'Drifted'
      },
    }

    const report = await (await capture(workspace, plugin, [mutator])).toSensor()
    expect(report.uncertainty.reasons).toContain('mutated-during-capture-prep')
    expect(report.coverage.engineFrame.mutationsDuringPrep).toBeGreaterThanOrEqual(1)
  })

  it('does not claim drift on a quiet capture', async () => {
    const { workspace } = fixture()
    const plugin = sensor()
    plugins.push(plugin)

    const report = await (await capture(workspace, plugin)).toSensor()
    expect(report.uncertainty.reasons).not.toContain('mutated-during-capture-prep')
    expect(report.coverage.engineFrame.mutationsDuringPrep).toBeUndefined()
  })
})
