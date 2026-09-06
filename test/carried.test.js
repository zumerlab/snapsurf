import { describe, expect, it } from 'vitest'
import { carriedIndex, carriedDiff } from '../src/carried.js'

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
})
