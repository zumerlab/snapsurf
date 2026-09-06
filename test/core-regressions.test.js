import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'
import { hash } from '../src/hash.js'
import { inflateCheckpoint } from '../src/checkpoint.js'
import { observeChunked, buildUi } from '../src/plugin.js'
import { diffSnapshots } from '../src/diff.js'

function mount(html) {
  const root = document.createElement('main')
  root.style.cssText = 'position:relative;width:500px'
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

async function freshRealm(html) {
  const frame = document.createElement('iframe')
  frame.srcdoc = `<main style="position:relative;width:500px">${html}</main>`
  document.body.appendChild(frame)
  await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
  const moduleUrl = new URL('../src/plugin.js', import.meta.url).href
  // Import from the iframe's global so each call gets an independent module graph and
  // runCounter, exactly like a reload or a new tab/process.
  const loadModule = frame.contentWindow.Function('url', 'return import(url)')
  const core = await loadModule(moduleUrl)
  return { frame, core, root: frame.contentDocument.querySelector('main') }
}

describe('core honesty regressions', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('frames hash parts so distinct coordinate tuples cannot concatenate identically', () => {
    expect(hash('g', 1, 23, 4, 5)).not.toBe(hash('g', 12, 3, 4, 5))
    expect(hash('stable', 1)).toMatch(/^[0-9a-f]{16}$/)
    expect(hash('stable', 1)).toBe(hash('stable', 1))
  })

  it('rejects v1 checkpoints instead of comparing incompatible hashes', () => {
    expect(() => inflateCheckpoint({ version: 1, nodes: {} }))
      .toThrow(/unsupported checkpoint version 1/)
  })

  it.each([
    { label: 'ambiguous match', afterX: 0, expectedId: 'before-button', matched: true },
    { label: 'unmatched replacement', afterX: 20, expectedId: 'after-button', matched: false },
  ])('keeps render actionability when a renamed remount is an $label', ({ afterX, expectedId, matched }) => {
    const node = (id, name, x, covered) => ({
      id,
      parentId: 'root',
      childIds: [],
      tag: 'button',
      role: 'button',
      name,
      nameFp: `name-${name}`,
      textFp: `text-${name}`,
      textHash: `hash-${name}`,
      rawTextHash: `hash-${name}`,
      stateHash: 'state',
      styleHash: 'style',
      geometryHash: `geometry-${x}`,
      subtreeHash: `subtree-${name}`,
      spHash: 'same-path',
      ancestorFp: 'same-ancestor',
      ordinal: 1,
      rel: [x, 0, 100, 30],
      bbox: [x, 0, 100, 30],
      interactive: true,
      visible: true,
      covered,
      ...(covered ? { coveredBy: { role: 'dialog' } } : {}),
    })
    const root = (childId) => ({
      id: 'root', parentId: null, childIds: [childId], tag: 'section', role: 'generic',
      nameFp: '', textFp: '', textHash: 'root-text', rawTextHash: 'root-text',
      stateHash: 'root-state', styleHash: 'root-style', geometryHash: 'root-geometry',
      subtreeHash: 'force-recursion', spHash: 'root-path', ancestorFp: '', ordinal: 1,
      rel: [0, 0, 300, 80], bbox: [0, 0, 300, 80], visible: true, covered: false,
      interactive: false,
    })
    const before = {
      rootId: 'root',
      nodes: new Map([
        ['root', root('before-button')],
        ['before-button', node('before-button', 'Continue', 0, false)],
      ]),
    }
    const after = {
      rootId: 'root',
      nodes: new Map([
        ['root', { ...root('after-button'), subtreeHash: 'different-after-root' }],
        ['after-button', node('after-button', 'Proceed', afterX, true)],
      ]),
    }

    const diff = diffSnapshots(before, after)
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'possible-replacement',
        beforeId: 'before-button',
        afterId: 'after-button',
      }),
    ]))
    expect(diff.actionabilityDelta.becameCovered).toEqual([
      expect.objectContaining({
        id: expectedId,
        name: 'Proceed',
        match: 'ambiguous',
        beforeId: 'before-button',
        afterId: 'after-button',
        coveredBy: { role: 'dialog' },
      }),
    ])
    expect(diff.actionabilityDelta.becameVisible).toEqual([])
    expect(diff.idMap.has('after-button')).toBe(matched)
  })

  it('namespaces new ids across independent realms so a persisted baseline cannot collapse nodes', async () => {
    const first = await freshRealm(
      '<button data-testid="a">A</button><button data-testid="b">B</button>'
    )
    const firstUi = first.core.buildUi(first.core.observe(first.root), {})
    const previous = JSON.parse(JSON.stringify(firstUi.checkpoint()))
    first.frame.remove()

    const second = await freshRealm(
      '<button data-testid="x">X</button><button data-testid="a">A</button><button data-testid="b">B</button>'
    )
    const after = second.core.buildUi(second.core.observe(second.root, { previous }), {})
    const ids = after.__snapshot.order

    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(ids.length)
    expect(after.__snapshot.nodes.size).toBe(4)
    const added = after.changes.find((change) => change.kind === 'added' && change.name === 'X')
    expect(added).toBeTruthy()
    expect(added.id).not.toBe(after.getByTestId('a').id)
    expect(after.checkpoint().nodes).toHaveLength(4)
  })

  it.each([
    {
      label: 'href',
      html: '<a id="target" href="/before">Destination</a>',
      mutate: (el) => el.setAttribute('href', '/after'),
    },
    {
      label: 'accessible name',
      html: '<button id="target" aria-label="Before"></button>',
      mutate: (el) => el.setAttribute('aria-label', 'After'),
    },
  ])('reports a changed $label', async ({ html, mutate }) => {
    const root = mount(html)
    const before = await inspect(root)
    mutate(root.querySelector('#target'))
    const after = await inspect(root, { previous: before.checkpoint() })

    expect(after.changed).toBe(true)
    // With no stable authored identity, changing the only accessible name is honestly
    // classified as a possible replacement; either taxonomy is still a detected change.
    expect(after.changes.some((c) => c.kind === 'content' || c.kind === 'possible-replacement')).toBe(true)
  })

  it('materializes only presence-boolean false endpoints in state change evidence', async () => {
    const root = mount(`
      <input data-testid="disabled-target" aria-label="Disabled target" disabled>
      <input data-testid="value-target" aria-label="Value target">
      <button data-testid="expanded-target" aria-expanded="true">Expanded target</button>
    `)
    const before = await inspect(root)
    const ids = {
      disabled: before.getByTestId('disabled-target').id,
      value: before.getByTestId('value-target').id,
      expanded: before.getByTestId('expanded-target').id,
    }

    root.querySelector('[data-testid="disabled-target"]').disabled = false
    root.querySelector('[data-testid="value-target"]').value = 'filled'
    root.querySelector('[data-testid="expanded-target"]').removeAttribute('aria-expanded')
    const after = await inspect(root, { previous: before.checkpoint() })
    const stateChange = (id) => after.changes.find((change) => change.kind === 'state' && change.id === id)

    expect(stateChange(ids.disabled)).toMatchObject({
      before: { disabled: true },
      after: { disabled: false },
    })
    expect(stateChange(ids.value)).toMatchObject({
      before: { hasValue: false },
      after: { hasValue: true },
    })
    const expanded = stateChange(ids.expanded)
    expect(expanded.before).toEqual({ expanded: true })
    expect(expanded.after).toEqual({})
    expect(expanded.after).not.toHaveProperty('disabled')
    expect(expanded.after).not.toHaveProperty('hasValue')
  })

  it('reports a rendered img src change as content', async () => {
    const svg = (fill) => 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${fill}"/></svg>`
    )
    const root = mount(`<img id="target" alt="stable" width="20" height="20" src="${svg('red')}">`)
    const image = root.querySelector('#target')
    await image.decode()
    const before = await inspect(root)
    image.src = svg('blue')
    await image.decode()
    const after = await inspect(root, { previous: before.checkpoint() })

    expect(after.changed).toBe(true)
    expect(after.changes.some((c) => c.kind === 'content')).toBe(true)
  })

  it('reports a computed background-image change as style', async () => {
    const root = mount('<div id="target" style="width:20px;height:20px;background-image:linear-gradient(red,red)"></div>')
    const before = await inspect(root)
    root.querySelector('#target').style.backgroundImage = 'linear-gradient(blue, blue)'
    const after = await inspect(root, { previous: before.checkpoint() })

    expect(after.changed).toBe(true)
    expect(after.changes.some((c) => c.kind === 'style')).toBe(true)
  })

  it('declares same-origin iframe contents unobservable instead of silently complete', async () => {
    const root = mount('')
    const frame = document.createElement('iframe')
    // The initial about:blank document can already be complete while srcdoc is
    // still navigating. Wait for that navigation, with the listener attached first.
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<button>Before</button>'
    root.appendChild(frame)
    await loaded
    const frameDocument = frame.contentDocument
    expect(frameDocument.body.textContent).toBe('Before')
    const before = await inspect(root)
    expect(frame.contentDocument).toBe(frameDocument)
    expect(frameDocument.body.textContent).toBe('Before')
    frame.contentDocument.body.innerHTML = '<button>After</button>'
    const after = await inspect(root, { previous: before.checkpoint() })

    expect(before.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'iframe', rasterAvailable: true }),
    ]))
    expect(after.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'iframe', rasterAvailable: true }),
    ]))
  })

  it('signals a defined custom element whose possible closed shadow cannot be walked', async () => {
    const tag = `x-agent-closed-${Date.now()}`
    customElements.define(tag, class extends HTMLElement {
      constructor() {
        super()
        this.attachShadow({ mode: 'closed' }).innerHTML = '<button>Opaque</button>'
      }
    })
    const root = mount(`<${tag}></${tag}>`)
    const ui = await inspect(root)

    expect(ui.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'possible-closed-shadow', rasterAvailable: true }),
    ]))
  })

  it('detects visible text stored directly under an open shadow root', async () => {
    const root = mount('<div id="host" style="display:block"></div>')
    const shadow = root.querySelector('#host').attachShadow({ mode: 'open' })
    const text = document.createTextNode('Before visible text')
    shadow.appendChild(text)
    const before = await inspect(root)

    text.nodeValue = 'After visible text'
    const after = await inspect(root, { previous: before.checkpoint() })

    expect(before.context).toContain('Before visible text')
    expect(after.context).toContain('After visible text')
    expect(after.changed).toBe(true)
    expect(after.changes.some((change) =>
      change.kind === 'content' || change.kind === 'possible-replacement'
    )).toBe(true)
    expect(after.unobservable).toEqual([])
  })

  it('marks a chunked observation torn when an already-read open shadow root mutates', async () => {
    const host = document.createElement('div')
    host.style.cssText = 'display:block;width:300px'
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const text = document.createTextNode('Before visible text')
    shadow.appendChild(text)
    const before = await inspect(host)
    // Pre-inflate so observeChunked reaches the walk synchronously. With budgetMs:0 it
    // reads the host, then parks at the first node yield before returning this promise.
    const previous = inflateCheckpoint(before.checkpoint())

    const pending = observeChunked(host, { previous, budgetMs: 0 })
    text.nodeValue = 'After visible text'
    const observation = await pending
    const ui = buildUi(observation)

    // The captured node is intentionally the already-read value; honesty comes from the
    // explicit torn flag, which tells the caller to re-observe rather than trust no-change.
    expect(ui.context).toContain('Before visible text')
    expect(text.nodeValue).toBe('After visible text')
    expect(ui.changed).toBe(false)
    expect(observation.torn).toBeGreaterThan(0)
  })

  it("makes noise:'none' preserve dynamic clock text", async () => {
    const root = mount('<span id="clock">10:10</span>')
    const before = await inspect(root, { noise: 'none' })
    root.querySelector('#clock').textContent = '10:11'
    const after = await inspect(root, { previous: before.checkpoint(), noise: 'none' })

    expect(after.changed).toBe(true)
    expect(after.changes).not.toHaveLength(0)
    expect(JSON.stringify(after.changes)).toContain('10:11')
  })

  it("makes noise:'none' preserve authored whitespace", async () => {
    const root = mount('<span id="text">one two</span>')
    const before = await inspect(root, { noise: 'none' })
    root.querySelector('#text').textContent = 'one  two'
    const after = await inspect(root, { previous: before.checkpoint(), noise: 'none' })

    expect(after.changed).toBe(true)
  })

  it('composes capture plugins supplied by the caller', async () => {
    const root = mount('<button>Save</button>')
    let calls = 0
    const callerPlugin = { name: 'caller-probe', beforeClone: () => { calls++ } }

    await inspect(root, { capture: { plugins: [callerPlugin] } })

    expect(calls).toBeGreaterThan(0)
  })
})
