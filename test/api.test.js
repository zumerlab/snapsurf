/* global document */

/**
 * Phase 4 acceptance: the query API (§6) over the snapshot, resolve() as the only
 * bridge to the live DOM, and the surface guarantees the master prompt fixes —
 * match classes never leak floats, checkpoints carry no image/DOM/secrets,
 * canvas honesty, capabilities reporting.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { inspect, resolve } from '../src/index.js'

function app() {
  const el = document.createElement('div')
  el.style.cssText = 'width:800px;position:relative'
  el.innerHTML = `
    <nav><a href="/home">Inicio</a><a href="/docs">Documentación</a></nav>
    <main>
      <h1>Ajustes</h1>
      <label for="mail">Correo</label>
      <input id="mail" type="email" value="secreto@example.com">
      <input data-testid="nota" type="text" value="algo">
      <button data-testid="save">Guardar</button>
      <button disabled>Publicar</button>
      <div role="dialog" aria-label="Settings">
        <p>Contenido del diálogo</p>
        <button>Guardar</button>
        <button>Cancelar</button>
      </div>
      <canvas width="120" height="60"></canvas>
    </main>
  `
  document.body.appendChild(el)
  return el
}

describe('query API + resolve', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('getByRole/getByText/getByLabel/getByTestId find the right nodes', async () => {
    const ui = await inspect(app())
    expect(ui.getByRole('heading', { name: 'Ajustes' })).toBeTruthy()
    expect(ui.getByRole('link', { name: 'Documentación' })).toBeTruthy()
    expect(ui.getByTestId('save').role).toBe('button')
    expect(ui.getByLabel('Correo').role).toBe('textbox')
    expect(ui.getByText('Contenido del diálogo')).toBeTruthy()
    expect(ui.getByRole('button', { name: 'No existe' })).toBeNull()
  })

  it('chainable scoping searches inside the match only', async () => {
    const ui = await inspect(app())
    const dialog = ui.getByRole('dialog', { name: 'Settings' })
    expect(dialog).toBeTruthy()
    const save = dialog.getByRole('button', { name: 'Guardar' })
    expect(save).toBeTruthy()
    // The page-level Guardar (data-testid=save) is OUTSIDE the dialog → different node.
    expect(save.id).not.toBe(ui.getByTestId('save').id)
    expect(dialog.getByRole('button', { name: 'Inicio' })).toBeNull()
  })

  it('matches are snapshot data, not live locators; resolve() is the only bridge', async () => {
    const root = app()
    const ui = await inspect(root)
    const m = ui.getByTestId('save')
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['id', 'bbox', 'visible', 'covered', 'role', 'name']))
    const live = resolve(m)
    expect(live).toBeTruthy()
    expect(live.getAttribute('data-testid')).toBe('save')
    // Detached → null, never a stale element.
    live.remove()
    expect(resolve(m)).toBeNull()
  })

  it('never exposes float confidences — only match classes', async () => {
    const root = app()
    const ui1 = await inspect(root)
    root.querySelector('h1').textContent = 'Ajustes avanzados'
    const ui2 = await inspect(root, { previous: ui1.checkpoint() })
    expect(ui2.changed).toBe(true)
    for (const c of ui2.changes) {
      expect(['exact', 'strong', 'ambiguous', 'new', 'removed']).toContain(c.match)
      expect(JSON.stringify(c)).not.toMatch(/0\.\d{2,}/)
    }
  })

  it('privacy rules redact configured labels and text before the semantic output leaves the page', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<button>Delete account</button><input type="text" name="email" value="agent@example.com">'
    document.body.appendChild(root)

    const ui = await inspect(root, { privacy: { redact: ['delete account', 'email'] } })
    const json = JSON.stringify(ui.checkpoint())

    expect(ui.context).not.toContain('Delete account')
    expect(ui.context).toContain('[redacted]')
    expect(json).not.toContain('agent@example.com')
    expect(json).not.toContain('Delete account')
  })

  it('checkpoint is compact, versioned, image-free, DOM-free and secret-free', async () => {
    const ui = await inspect(app())
    const cp = ui.checkpoint()
    expect(cp.version).toBe(1)
    expect(cp.environment.viewport).toHaveLength(2)
    expect(cp.environment.engine).toBeTruthy()
    const json = JSON.stringify(cp)
    expect(json).not.toContain('secreto@example.com') // sensitive input value never stored
    expect(json).not.toContain('<div')                // no serialized DOM
    expect(json).not.toContain('data:image')          // no image
    const lean = JSON.stringify(ui.checkpoint({ excludeText: true }))
    expect(lean.length).toBeLessThan(json.length)
    expect(lean).not.toContain('Documentación')       // excludeText drops names too
  })

  it('canvas is reported honestly (raster available, semantics not)', async () => {
    const ui = await inspect(app())
    expect(ui.context).toContain('canvas')
    expect(ui.context).toContain('no semantics')
  })

  it('capabilities report what actually works', async () => {
    const ui = await inspect(app())
    expect(ui.capabilities).toHaveProperty('inlineStyles')
    expect(ui.capabilities).toHaveProperty('dataUrls')
    expect(ui.capabilities).toHaveProperty('blobUrls')
  })

  it('never names a node after the source code of a script inside it', async () => {
    // Found in the field pass: a Mercado Libre container reported its accessible name as
    // "(function() { if (false) { var firstViewUrl = …" — the inline tracking script's
    // body, because content-derived names read `textContent`, which includes SCRIPT and
    // STYLE descendants. It does not corrupt identity (a generic role takes no name from
    // content) but it ships noise to the model in every outline and every change entry.
    const root = document.createElement('div')
    root.style.cssText = 'width:400px'
    root.innerHTML = `
      <div data-testid="promo">
        <h3>Ofertas</h3>
        <script>window.__tracking = { ts: 1700000000 }</script>
        <style>.promo { color: red }</style>
      </div>`
    document.body.appendChild(root)

    // The vector is the change report: `changes[].name` carries the node's accessible
    // name whether or not the node is interactive.
    const before = await inspect(root)
    root.querySelector('[data-testid="promo"]').style.color = 'rgb(0, 128, 0)'
    const ui = await inspect(root, { previous: before.checkpoint() })

    const wire = JSON.stringify(ui.changes)
    expect(ui.changes.length).toBeGreaterThan(0)
    expect(wire).not.toContain('__tracking')
    expect(wire).not.toContain('color: red')
    // The visible text is still there.
    expect(ui.context).toContain('Ofertas')
  })

  it('rasterize() rides the same walk and returns a snapdom result', async () => {
    const root = app()
    const ui = await inspect(root)
    const res = await ui.rasterize()
    expect(res.url.startsWith('data:image/svg+xml')).toBe(true)
    // Region rasterization: one match instead of the page.
    const region = await ui.rasterize(ui.getByRole('dialog', { name: 'Settings' }))
    expect(region.url.startsWith('data:image/svg+xml')).toBe(true)
    // The re-signed map matches the rasterized instant.
    expect(ui.agentMap.map.length).toBeGreaterThan(0)
  })
})
