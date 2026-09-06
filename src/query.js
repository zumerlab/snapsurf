/**
 * Playwright-shaped queries over the SNAPSHOT (§6) — not live locators. The
 * signatures are already in every model's weights; do not invent a dialect.
 * @module agent/query
 */

export const MATCH_ELEMENTS = Symbol('agent.match.elements')

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()

/** Roles getByLabel targets: Playwright's getByLabel resolves to the labelled CONTROL,
 *  never to the <label> element itself. */
const LABELLABLE = new Set([
  'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider', 'spinbutton',
  'switch', 'button', 'listbox', 'meter', 'progressbar',
])

function nameMatches(name, want) {
  if (want === undefined) return true
  if (want instanceof RegExp) return want.test(name || '')
  return norm(name) === norm(want) || norm(name).includes(norm(want))
}

function toMatch(node, api) {
  const m = {
    id: node.id,
    bbox: node.bbox,
    visible: node.visible,
    covered: node.covered,
    role: node.role,
    name: node.name,
    // Chainable scoping: further queries search this match's subtree only.
    getByRole: (role, opts) => api.queryFrom(node.id, (n) => n.role === role && nameMatches(n.name, opts && opts.name)),
    getByText: (text) => api.queryFrom(node.id, (n) => nameMatches(n.text || n.name, text)),
    getByLabel: (label) => api.queryFrom(node.id, (n) => LABELLABLE.has(n.role) && nameMatches(n.name, label)),
    getByTestId: (testid) => api.queryFrom(node.id, (n) => n.testid === testid),
  }
  Object.defineProperty(m, MATCH_ELEMENTS, { value: api.elements, enumerable: false })
  return m
}

/**
 * @param {{nodes: Map<string,object>, order: string[]}} snapshot
 * @returns {object} query surface bound to the snapshot
 */
export function makeQueryApi(snapshot, identitySnapshot = snapshot) {
  const api = { elements: snapshot.elements, identitySnapshot }
  const descendants = (rootId) => {
    const out = []
    const walk = (id) => {
      const n = snapshot.nodes.get(id)
      if (!n) return
      out.push(n)
      for (const c of n.childIds) walk(c)
    }
    walk(rootId)
    return out
  }
  api.queryFrom = (rootId, pred) => {
    const pool = rootId ? descendants(rootId) : [...snapshot.nodes.values()]
    // Skip the scope root itself so dialog.getByRole('dialog') doesn't self-match.
    const start = rootId ? 1 : 0
    for (let i = start; i < pool.length; i++) {
      const identityNode = api.identitySnapshot.nodes.get(pool[i].id) || pool[i]
      if (pred(identityNode)) return toMatch(pool[i], api)
    }
    return null
  }
  return {
    getByRole: (role, opts) => api.queryFrom(null, (n) => n.role === role && nameMatches(n.name, opts && opts.name)),
    getByText: (text) => api.queryFrom(null, (n) => nameMatches(n.text || n.name, text)),
    getByLabel: (label) => api.queryFrom(null, (n) => LABELLABLE.has(n.role) && nameMatches(n.name, label)),
    getByTestId: (testid) => api.queryFrom(null, (n) => n.testid === testid),
  }
}
