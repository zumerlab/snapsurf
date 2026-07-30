/**
 * The integration contract (§Mission): this package is a plugin layer on snapdom, so
 * the plugin — not `inspect()` — is the surface under test here. Everything an agent
 * needs must be reachable from a plain capture:
 *
 *   const result = await snapdom(el, { plugins: [agentOracle({ previous })] })
 *
 * Also pins the two properties that only hold because the visitor rides the capture:
 * one instant for pixels and semantics, and no memo serving a stale walk.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../../../src/api/snapdom.js'
import { agentOracle } from '../src/plugin.js'

function app() {
  const el = document.createElement('div')
  el.style.cssText = 'width:600px;position:relative'
  el.innerHTML = `
    <h1>Pedidos</h1>
    <button data-testid="save">Guardar</button>
    <p data-testid="status">Sin guardar</p>`
  document.body.appendChild(el)
  return el
}

afterEach(() => { document.querySelectorAll('body > div').forEach((n) => n.remove()) })

describe('agentOracle plugin', () => {
  it('exposes the whole agent surface as exports on a normal capture', async () => {
    const el = app()
    const result = await snapdom(el, { plugins: [agentOracle()] })

    // Custom exports are wired as to<Name>() by the plugin system.
    expect(typeof result.toChanges).toBe('function')
    expect(typeof result.toAgentMap).toBe('function')
    expect(typeof result.toAgentContext).toBe('function')
    expect(typeof result.toCheckpoint).toBe('function')

    const map = await result.toAgentMap()
    expect(map.map.some((e) => e.n === 'Guardar' && e.r === 'button')).toBe(true)

    const outline = await result.toAgentContext()
    expect(outline).toContain('Pedidos')

    const cp = await result.toCheckpoint()
    expect(cp.version).toBe(1)
    // §7: a checkpoint carries no image and no serialized DOM.
    const wire = JSON.stringify(cp)
    expect(wire).not.toContain('data:image')
    expect(wire).not.toContain('<button')

    // The core exporters still work on the same result — one capture, two outputs.
    expect(typeof result.toPng).toBe('function')
    expect(result.url.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('diffs against a previous checkpoint through the plugin path', async () => {
    const el = app()
    const before = await snapdom(el, { plugins: [agentOracle()] })
    const cp = await before.toCheckpoint()

    el.querySelector('[data-testid="status"]').textContent = 'Guardado'

    const after = await snapdom(el, { plugins: [agentOracle({ previous: cp })] })
    const report = await after.toChanges()
    expect(report.changed).toBe(true)
    expect(report.changes.some((c) => c.kind === 'content')).toBe(true)
    // The unchanged button keeps its identity across the two captures.
    expect(report.changes.some((c) => c.role === 'button')).toBe(false)
  })

  it('never serves a memoized walk: repeated captures re-read the live DOM', async () => {
    // The oracle deliberately does not declare `pure`, so snapdom suspends memoization
    // and differential recapture for its captures. If that ever regressed, this test
    // would return the first walk's answer and the change would go unreported.
    const el = app()
    const first = await snapdom(el, { plugins: [agentOracle()] })
    const cp = await first.toCheckpoint()

    el.querySelector('[data-testid="status"]').textContent = 'Cambiado'
    const second = await snapdom(el, { plugins: [agentOracle({ previous: cp })] })

    expect((await second.toChanges()).changed).toBe(true)
  })

  it('keeps the caller subtree when the engine runs the pipeline more than once', async () => {
    // Field pass: on lanacion.com.ar, mercadolibre and stripe a single snapdom() call
    // fired beforeClone twice — once for document.body, then once for documentElement.
    // Keeping the last walk replaced the caller's page with <html> and the report came
    // back empty. The first pass is the one that was asked for.
    const el = app()
    const oracle = agentOracle()
    oracle.beforeClone({ element: el })
    const asked = oracle.ui.context
    oracle.beforeClone({ element: document.documentElement })
    expect(oracle.ui.context).toBe(asked)
    expect(oracle.ui.context).toContain('Guardar')
  })

  it('reports the region an agent cannot read, and offers the raster instead (§9)', async () => {
    const el = app()
    const canvas = document.createElement('canvas')
    canvas.width = 120; canvas.height = 40
    el.appendChild(canvas)

    const result = await snapdom(el, { plugins: [agentOracle()] })
    const report = await result.toChanges()
    expect(report.unobservable.length).toBe(1)
    expect(report.unobservable[0]).toMatchObject({ sourceType: 'canvas', rasterAvailable: true })
  })
})
