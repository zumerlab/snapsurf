/**
 * Corpus runner (Phase 1): load → inspect → mutate → inspect(previous) → compare
 * against hand-written ground truth. No diff feature exists without a fixture that
 * fails first. Fixtures: packages/agent/corpus/<name>/{page.html, mutate.js, expected.json}
 *
 * expected.json vocabulary:
 *   changed:          boolean — required
 *   expectEmpty:      true → changes must be []
 *   mustInclude:      [{kind, role?, name?, minCount?}] — each must match ≥ minCount (default 1)
 *   forbidKinds:      [kind] — none of these may appear
 *   allowKindsOnly:   [kind] — every change's kind must be in this list
 *   maxChanges:       number
 *   actionability:    {becameCoveredMin?, becameVisibleMin?}
 *   stableIdQueries:  [{role, name?}] — the id found before the mutation must survive it
 *   matchClassFor:    [{role, name?, expect: [classes]}] — match class of that node's change entries
 */
import { describe, it, expect } from 'vitest'
import { inspect } from '../src/index.js'

const pages = import.meta.glob('../corpus/*/page.html', { query: '?raw', import: 'default', eager: true })
const mutators = import.meta.glob('../corpus/*/mutate.js', { eager: true })
const expectations = import.meta.glob('../corpus/*/expected.json', { eager: true })

const fixtures = Object.keys(pages).map((p) => {
  const dir = p.replace('/page.html', '')
  const name = dir.split('/').pop()
  return {
    name,
    html: pages[p],
    mutate: mutators[dir + '/mutate.js']?.default,
    expected: expectations[dir + '/expected.json']?.default ?? expectations[dir + '/expected.json'],
  }
}).filter((f) => f.mutate && f.expected)

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

function assertExpected(fx, ui, before) {
  const e = fx.expected
  const changes = ui.changes || []
  const label = (c) => `${c.kind}(${c.role || '?'}${c.name ? `:"${c.name}"` : ''})`
  const summary = () => changes.map(label).join(', ') || '∅'

  expect(ui.changed, `${fx.name}: changed — got [${summary()}]`).toBe(e.changed)
  if (e.expectEmpty) {
    expect(changes, `${fx.name}: expected EMPTY diff, got [${summary()}]`).toHaveLength(0)
  }
  for (const m of e.mustInclude || []) {
    const hits = changes.filter((c) =>
      c.kind === m.kind &&
      (m.role === undefined || c.role === m.role) &&
      (m.name === undefined || (c.name || '').includes(m.name) || (c.beforeName || '').includes(m.name))
    )
    expect(hits.length, `${fx.name}: mustInclude ${JSON.stringify(m)} — got [${summary()}]`)
      .toBeGreaterThanOrEqual(m.minCount ?? 1)
  }
  for (const kind of e.forbidKinds || []) {
    const bad = changes.filter((c) => c.kind === kind)
    expect(bad, `${fx.name}: forbidden kind "${kind}" present — [${summary()}]`).toHaveLength(0)
  }
  if (e.allowKindsOnly) {
    const outside = changes.filter((c) => !e.allowKindsOnly.includes(c.kind))
    expect(outside, `${fx.name}: kinds outside ${e.allowKindsOnly} — [${summary()}]`).toHaveLength(0)
  }
  if (e.maxChanges !== undefined) {
    expect(changes.length, `${fx.name}: too many changes — [${summary()}]`).toBeLessThanOrEqual(e.maxChanges)
  }
  if (e.actionability) {
    const d = ui.actionabilityDelta || { becameCovered: [], becameVisible: [] }
    if (e.actionability.becameCoveredMin !== undefined) {
      expect(d.becameCovered.length, `${fx.name}: becameCovered`).toBeGreaterThanOrEqual(e.actionability.becameCoveredMin)
    }
    if (e.actionability.becameVisibleMin !== undefined) {
      expect(d.becameVisible.length, `${fx.name}: becameVisible`).toBeGreaterThanOrEqual(e.actionability.becameVisibleMin)
    }
  }
  for (const q of e.stableIdQueries || []) {
    const b = before.getByRole(q.role, q.name ? { name: q.name } : undefined)
    const a = ui.getByRole(q.role, q.name ? { name: q.name } : undefined)
    expect(b, `${fx.name}: stableIdQueries before-match ${JSON.stringify(q)}`).toBeTruthy()
    expect(a, `${fx.name}: stableIdQueries after-match ${JSON.stringify(q)}`).toBeTruthy()
    expect(a.id, `${fx.name}: id must survive the mutation for ${JSON.stringify(q)}`).toBe(b.id)
  }
  for (const mc of e.matchClassFor || []) {
    const a = ui.getByRole(mc.role, mc.name ? { name: mc.name } : undefined)
    expect(a, `${fx.name}: matchClassFor target`).toBeTruthy()
    const entries = changes.filter((c) => c.id === a.id)
    for (const c of entries) {
      expect(mc.expect, `${fx.name}: match class "${c.match}" for ${label(c)}`).toContain(c.match)
    }
  }
}

describe('agent corpus', () => {
  for (const fx of fixtures) {
    it(fx.name, async () => {
      const container = document.createElement('div')
      container.style.cssText = 'width:900px;position:relative'
      container.innerHTML = fx.html
      document.body.appendChild(container)
      try {
        await frame()
        const ui1 = await inspect(container)
        const checkpoint = ui1.checkpoint()
        await fx.mutate(container, { frame })
        await frame()
        const ui2 = await inspect(container, { previous: checkpoint })
        assertExpected(fx, ui2, ui1)
      } finally {
        container.remove()
      }
    }, 30000)
  }

  it('corpus has the required breadth (≥15 fixtures)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15)
  })
})
