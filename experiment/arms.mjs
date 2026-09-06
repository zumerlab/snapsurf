/**
 * The three arms of the Phase-5 experiment, as in-page implementations.
 *
 *  A — screenshots:  before/after raster only. No structure. (Payload = PNG bytes.)
 *  B — this product: inspect(previous) → changes + actionabilityDelta + localized context.
 *  C — the free alternative: MutationObserver log + attribute/a11y diff, with NO
 *      post-render signals (no occlusion, no computed visibility, no paint order).
 *      This is what a competent team builds in a week — the honest baseline to beat.
 *
 * Every arm produces `{ payload, bytes }`: what a model would actually be shown.
 * @module agent/experiment/arms
 */

// ── Arm C: the free path ──────────────────────────────────────────────────────
// Deliberately limited to markup-level information. It may read attributes, roles
// and the mutation log; it must NOT consult layout, computed style, stacking or
// elementFromPoint — that limitation IS the hypothesis under test.
export function startArmC(root) {
  const records = []
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        records.push({
          type: 'attr', target: describe(m.target), name: m.attributeName,
          from: m.oldValue, to: m.target.getAttribute(m.attributeName),
        })
      } else if (m.type === 'characterData') {
        records.push({ type: 'text', target: describe(m.target.parentElement), from: m.oldValue, to: m.target.nodeValue })
      } else {
        for (const n of m.addedNodes) if (n.nodeType === 1) records.push({ type: 'added', target: describe(n) })
        for (const n of m.removedNodes) if (n.nodeType === 1) records.push({ type: 'removed', target: describe(n) })
      }
    }
  })
  obs.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true })
  const tree = a11yTree(root)
  return {
    finish() {
      obs.takeRecords().forEach(() => {})
      obs.disconnect()
      const after = a11yTree(root)
      const payload = { mutations: records, a11yDiff: diffTrees(tree, after) }
      return { payload, bytes: JSON.stringify(payload).length }
    },
  }
}

function describe(el) {
  if (!el || el.nodeType !== 1) return null
  const bits = [el.localName]
  if (el.id) bits.push('#' + el.id)
  const role = el.getAttribute('role')
  if (role) bits.push('[' + role + ']')
  const testid = el.getAttribute('data-testid')
  if (testid) bits.push('@' + testid)
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (t) bits.push(`"${t}"`)
  return bits.join('')
}

/** Markup-level a11y-ish tree: role, name, key attributes. No layout, no computed style. */
function a11yTree(root) {
  const out = []
  const walk = (el, depth) => {
    if (el.nodeType !== 1) return
    const tag = el.localName
    if (tag === 'script' || tag === 'style') return
    out.push({
      d: depth, tag,
      role: el.getAttribute('role') || implicitRole(tag, el),
      name: (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
        (el.children.length === 0 ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '')),
      testid: el.getAttribute('data-testid') || undefined,
      disabled: el.hasAttribute('disabled') || undefined,
      hidden: el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || undefined,
      cls: (el.getAttribute('class') || '').slice(0, 40) || undefined,
    })
    for (const c of el.children) walk(c, depth + 1)
  }
  walk(root, 0)
  return out
}

function implicitRole(tag, el) {
  if (tag === 'button') return 'button'
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
  if (tag === 'input') return (el.getAttribute('type') || 'text') === 'checkbox' ? 'checkbox' : 'textbox'
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'dialog') return 'dialog'
  return ''
}

function diffTrees(before, after) {
  const key = (n) => `${n.d}|${n.tag}|${n.role}|${n.testid || ''}`
  const bMap = new Map(before.map((n) => [key(n) + '|' + n.name, n]))
  const aMap = new Map(after.map((n) => [key(n) + '|' + n.name, n]))
  const changes = []
  for (const [k, n] of aMap) if (!bMap.has(k)) changes.push({ kind: 'appeared', node: n })
  for (const [k, n] of bMap) if (!aMap.has(k)) changes.push({ kind: 'gone', node: n })
  return changes
}

// ── Arm B: the product ───────────────────────────────────────────────────────
export async function armB(inspectFn, root, previous) {
  const ui = await inspectFn(root, { previous })
  const payload = {
    changed: ui.changed,
    changes: ui.changes,
    actionabilityDelta: ui.actionabilityDelta,
    // Regions the DOM cannot answer for (canvas/blocked iframe): shipped alongside the
    // diff so "no changes" is never mistaken for "nothing happened anywhere".
    unobservable: ui.unobservable,
    // Localized context: only the regions that changed, not the whole outline — this is
    // what makes B cheap in tokens compared to shipping the full tree.
    context: localizedContext(ui),
  }
  return { ui, payload, bytes: JSON.stringify(payload).length }
}

function localizedContext(ui) {
  if (!ui.changes || !ui.changes.length) return ''
  const ids = new Set(ui.changes.flatMap((c) => [c.id, c.beforeId, c.afterId].filter(Boolean)))
  return ui.context.split('\n').filter((line) => {
    for (const id of ids) if (line.includes(id)) return true
    return false
  }).join('\n')
}
