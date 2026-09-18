import { afterEach, describe, expect, it } from 'vitest'
import { carriedIndex, carriedDiff } from '../src/carried.js'
import { observe, buildUi } from '../src/plugin.js'

afterEach(() => { document.body.innerHTML = '' })

function page(html, options = {}) {
  const root = document.createElement('section')
  root.innerHTML = html
  document.body.replaceChildren(root)
  const ui = buildUi(observe(root, options))
  return { root, ui, index: carriedIndex(ui.__view || ui.__snapshot) }
}

const view = (nodes) => ({ nodes: new Map(nodes.map((n, i) => [n.id || `n_${i}`, n])) })

const badge = (text, extra = {}) => ({
  role: 'generic', testid: 'cart-badge', text, name: text,
  textHash: `th:${text}`, stateHash: 's0', styleHash: 'y0', ...extra,
})
const navLink = (name) => ({
  role: 'link', nameFp: `fp:${name}`, name,
  textHash: `th:${name}`, stateHash: 's0', styleHash: 'y0',
})
const anon = (text) => ({
  role: 'generic', text, textHash: `th:${text}`, stateHash: 's0', styleHash: 'y0',
})

describe('carried identity across navigations', () => {
  it('indexes only strong identity and drops ambiguous keys', () => {
    const index = carriedIndex(view([
      badge('1'),
      navLink('Carrito'),
      anon('sin identidad'),
      { role: 'button', testid: 'dup', textHash: 'a', stateHash: 'b', styleHash: 'c' },
      { role: 'button', testid: 'dup', textHash: 'a', stateHash: 'b', styleHash: 'c' },
    ]))
    expect(index.entries.map((e) => e.key).sort()).toEqual(['n:link|fp:Carrito', 't:cart-badge'])
    expect(index.ambiguousDropped).toBe(1)
  })

  it('reports the badge changing across the navigation, counts the rest without describing it', () => {
    const pageA = carriedIndex(view([
      badge('1'), navLink('Carrito'), anon('contenido de la home'), navLink('Ayuda'),
    ]))
    const pageB = carriedIndex(view([
      badge('2'), navLink('Carrito'), anon('contenido del producto'),
      { role: 'heading', nameFp: 'fp:Producto', name: 'Producto', textHash: 'tp', stateHash: 's0', styleHash: 'y0' },
    ]))
    const diff = carriedDiff(pageA, pageB)

    expect(diff.comparedBy).toBe('CROSS_PAGE_STRONG_IDENTITY_ONLY')
    expect(diff.matches).toBe(2)
    expect(diff.unchanged).toBe(1)
    expect(diff.changed).toEqual([expect.objectContaining({
      key: 't:cart-badge', by: 'data-testid', kinds: ['content'],
      from: expect.objectContaining({ text: '1' }),
      to: expect.objectContaining({ text: '2' }),
    })])
    // Page-A-only "Ayuda" and page-B-only heading are counted, never itemized.
    expect(diff.onlyBefore).toBe(1)
    expect(diff.onlyAfter).toBe(1)
    expect(JSON.stringify(diff.changed)).not.toContain('Ayuda')
  })

  it('caps the index and declares the truncation', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      role: 'link', testid: `item-${i}`, textHash: `t${i}`, stateHash: 's', styleHash: 'y',
    }))
    const index = carriedIndex(view(many))
    expect(index.entries.length).toBe(200)
    expect(index.truncated).toBe(50)
  })

  it('state transitions carry from/to state objects', () => {
    const a = carriedIndex(view([badge('1', { state: { expanded: false }, stateHash: 'sA' })]))
    const b = carriedIndex(view([badge('1', { state: { expanded: true }, stateHash: 'sB' })]))
    const diff = carriedDiff(a, b)
    expect(diff.changed[0].kinds).toEqual(['state'])
    expect(diff.changed[0].from.state).toEqual({ expanded: false })
    expect(diff.changed[0].to.state).toEqual({ expanded: true })
  })

  it('a redacted label is a placeholder, never cross-page identity', () => {
    // Two DIFFERENT hidden accounts, one per page, same role: matching them would
    // claim persistence about two values nobody compared — and confirm cross-page
    // presence of what the policy hides.
    const a = carriedIndex(view([
      { role: 'button', nameFp: 'fp:redacted-common', name: '[redacted]', textHash: 'ta', stateHash: 's', styleHash: 'y' },
      navLink('Carrito'),
    ]))
    const b = carriedIndex(view([
      { role: 'button', nameFp: 'fp:redacted-common', name: '[redacted]', textHash: 'tb', stateHash: 's', styleHash: 'y' },
      navLink('Carrito'),
    ]))
    expect(a.entries.map((e) => e.key)).toEqual(['n:link|fp:Carrito'])
    const diff = carriedDiff(a, b)
    expect(diff.matches).toBe(1)
    expect(JSON.stringify(diff)).not.toContain('fp:redacted-common')
  })

  it('a testid entry keeps identity even when its label is redacted', () => {
    // The authored testid is the identity; a redacted testid never reaches this layer
    // (the privacy pass drops it), so a surviving testid is safe to match on.
    const a = carriedIndex(view([badge('[redacted]', { textHash: 'ta' })]))
    const b = carriedIndex(view([badge('[redacted]', { textHash: 'tb' })]))
    const diff = carriedDiff(a, b)
    expect(diff.matches).toBe(1)
    expect(diff.changed[0].key).toBe('t:cart-badge')
  })

  it('a key unique on one side but ambiguous on the other never matches', () => {
    const a = carriedIndex(view([navLink('Cuenta')]))
    const b = carriedIndex(view([navLink('Cuenta'), navLink('Cuenta')]))
    expect(b.entries.length).toBe(0)
    expect(b.ambiguousDropped).toBe(1)
    const diff = carriedDiff(a, b)
    expect(diff.matches).toBe(0)
    expect(diff.onlyBefore).toBe(1)
    expect(diff.ambiguousDropped).toBe(1)
  })

  it('an empty page yields an empty, honest report', () => {
    const diff = carriedDiff(carriedIndex(view([])), carriedIndex(view([badge('1')])))
    expect(diff.matches).toBe(0)
    expect(diff.changed).toEqual([])
    expect(diff.onlyAfter).toBe(1)
  })

  it('treats equivalent relative/absolute destinations as unchanged only across pages', () => {
    const first = page('<a data-testid="destination" href="/carried-target?edition=1#details">Read report</a>')
    const previous = first.ui.checkpoint()
    const resolved = first.root.querySelector('a').href
    first.root.querySelector('a').setAttribute('href', resolved)
    const samePage = buildUi(observe(first.root, { previous }))
    expect(samePage.changes.some(change => change.kind === 'content')).toBe(true)
    const second = page(`<a data-testid="destination" href="${resolved}">Read report</a>`)
    const crossPage = carriedDiff(first.index, second.index)
    expect(crossPage.matches).toBe(1)
    expect(crossPage.unchanged).toBe(1)
    expect(crossPage.changed).toEqual([])
  })

  it('explains real destination changes even when the readable label and text are identical', () => {
    const first = page('<a data-testid="destination" href="/carried-target?edition=1#details">Read report</a>')
    const second = page('<a data-testid="destination" href="/carried-target?edition=2#details">Read report</a>')
    const diff = carriedDiff(first.index, second.index)
    expect(diff.changed[0]).toMatchObject({ kinds: ['content'], contentChanges: ['href'] })
    expect(diff.changed[0].from.text).toBe(diff.changed[0].to.text)
    expect(JSON.stringify(diff)).not.toContain('edition=')
  })

  it('detects the same relative spelling resolving to a different destination', () => {
    const first = page('<base href="https://example.test/a/"><a data-testid="destination" href="report">Read report</a>')
    const second = page('<base href="https://example.test/b/"><a data-testid="destination" href="report">Read report</a>')
    expect(carriedDiff(first.index, second.index).changed[0].contentChanges).toEqual(['href'])
  })

  it('explains authored names and image sources, and preserves an unknown fallback', () => {
    const first = page('<button data-testid="save" aria-label="Save draft"></button><img data-testid="image" alt="Cover" src="data:image/svg+xml,first">')
    const second = page('<button data-testid="save" aria-label="Publish draft"></button><img data-testid="image" alt="Cover" src="data:image/svg+xml,second">')
    const diff = carriedDiff(first.index, second.index)
    expect(diff.changed.find(change => change.key === 't:save')).toMatchObject({
      contentChanges: ['accessible-name'], from: { name: 'Save draft' }, to: { name: 'Publish draft' },
    })
    expect(diff.changed.find(change => change.key === 't:image').contentChanges).toContain('src')
    expect(carriedDiff(carriedIndex(view([badge('1')])), carriedIndex(view([badge('2')]))).changed[0].contentChanges).toEqual(['unknown'])
  })

  it('explains same-length value changes without disclosing either value', () => {
    const first = page('<input data-testid="field" value="alpha">')
    const second = page('<input data-testid="field" value="omega">')
    const diff = carriedDiff(first.index, second.index)
    expect(diff.changed[0]).toMatchObject({ kinds: ['state'], stateChanges: ['value-fingerprint'] })
    expect(JSON.stringify(diff)).not.toMatch(/alpha|omega/)
  })

  it('rebuilds component evidence after privacy and never exposes URL or input secrets', () => {
    const privacy = { redact: ['alice', 'betty', 'alpha', 'omega'] }
    const first = page('<a data-testid="destination" href="/users/alice">Account</a><input data-testid="field" value="alpha">', { privacy })
    const second = page('<a data-testid="destination" href="/users/betty">Account</a><input data-testid="field" value="omega">', { privacy })
    const diff = carriedDiff(first.index, second.index)
    expect(diff.changed).toEqual([])
    expect(JSON.stringify({ before: first.index, after: second.index, diff })).not.toMatch(/alice|betty|alpha|omega/)
    const firstContent = first.index.entries.find(entry => entry.key === 't:destination').contentComparison
    const secondContent = second.index.entries.find(entry => entry.key === 't:destination').contentComparison
    expect(firstContent.components).toEqual(secondContent.components)
    expect(JSON.stringify(first.ui.checkpoint())).not.toContain('contentComparison')
  })

  it('redacts resolved/encoded href evidence before comparing it', () => {
    const privacy = { redact: ['alice', 'betty'] }
    const first = page('<base href="https://example.test/users/alice/"><a data-testid="destination" href="report">Account</a>', { privacy })
    const second = page('<base href="https://example.test/users/betty/"><a data-testid="destination" href="report">Account</a>', { privacy })
    expect(carriedDiff(first.index, second.index).changed).toEqual([])
    const encodedBefore = page('<a data-testid="destination" href="/users/%61lice">Account</a>', { privacy })
    const encodedAfter = page('<a data-testid="destination" href="/users/%62etty">Account</a>', { privacy })
    expect(carriedDiff(encodedBefore.index, encodedAfter.index).changed).toEqual([])
  })
})
