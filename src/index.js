/**
 * snapDOM Agent (working name) — post-layout change oracle for in-page AI agents.
 * PRIVATE, PROPRIETARY, NEVER PUBLISHED. See package.json / LICENSE.
 *
 * Public surface (master prompt):
 *   const ui = await agent.inspect(root, { previous, noise })
 *   ui.rootHash / ui.context / ui.agentMap / ui.capabilities
 *   ui.changed / ui.changes / ui.actionabilityDelta
 *   ui.checkpoint() / ui.getByRole(...).getByText(...) / ui.rasterize(target?)
 *   agent.resolve(match) → live Element | null
 * @module agent
 */
import { takeSnapshot } from './snapshot.js'
import { resolveNoise } from './noise.js'
import { diffSnapshots } from './diff.js'
import { makeCheckpoint, inflateCheckpoint } from './checkpoint.js'
import { makeQueryApi, MATCH_ELEMENTS } from './query.js'

let runCounter = 0

/** Relabel matched after-nodes to their stable before ids (§2: identity persists). */
function applyStableIds(snapshot, idMap) {
  if (!idMap || !idMap.size) return snapshot
  const rename = (id) => idMap.get(id) || id
  const nodes = new Map()
  for (const [id, n] of snapshot.nodes) {
    const nid = rename(id)
    n.id = nid
    n.parentId = n.parentId ? rename(n.parentId) : null
    n.childIds = n.childIds.map(rename)
    // coveredBy points at another node: it has to follow the relabeling too, or a report
    // would name an id the caller cannot look up.
    if (n.coveredBy && n.coveredBy.id) n.coveredBy = { ...n.coveredBy, id: rename(n.coveredBy.id) }
    nodes.set(nid, n)
  }
  const elements = new Map()
  for (const [id, el] of snapshot.elements) elements.set(rename(id), el)
  const byElement = new Map()
  for (const [el, id] of snapshot.byElement) byElement.set(el, rename(id))
  return {
    ...snapshot,
    nodes, elements, byElement,
    order: snapshot.order.map(rename),
    rootId: rename(snapshot.rootId),
  }
}

// ── Context outline (evolution of context-export, same walk) ──────────────────
function renderContext(snapshot) {
  const lines = []
  const walk = (id, depth) => {
    const n = snapshot.nodes.get(id)
    if (!n) return
    const collapsible = n.role === 'generic' && !n.testid && !n.state && !n.text && n.childIds.length === 1
    if (collapsible) { walk(n.childIds[0], depth); return }
    let line = '  '.repeat(depth) + n.tag
    if (n.role !== 'generic') line += `[${n.role}]`
    if (n.testid) line += `#${n.testid}`
    line += ` [${n.bbox[0]},${n.bbox[1]} ${n.bbox[2]}x${n.bbox[3]}]`
    if (n.text) line += ` "${n.text.length > 120 ? n.text.slice(0, 119) + '…' : n.text}"`
    if (n.state) {
      const bits = Object.entries(n.state).map(([k, v]) => (v === true ? k : `${k}=${v}`))
      line += ` {${bits.join(' ')}}`
    }
    if (n.covered) line += ` ⊘covered${n.coveredBy ? ' by ' + (n.coveredBy.name || n.coveredBy.label || n.coveredBy.role) : ''}`
    if (n.sourceType) line += ` ⟨${n.sourceType}: no semantics⟩`
    lines.push(line)
    for (const c of n.childIds) walk(c, depth + 1)
  }
  if (snapshot.rootId) walk(snapshot.rootId, 0)
  return lines.join('\n')
}

// ── Set-of-Mark data (evolution of agent-map, same walk) ──────────────────────
function renderAgentMap(snapshot) {
  const map = []
  let i = 0
  for (const id of snapshot.order) {
    const n = snapshot.nodes.get(id)
    if (!n.interactive || !n.visible) continue
    const entry = { i: i++, id: n.id, r: n.role, b: n.bbox }
    if (n.name) entry.n = n.name
    if (n.state) entry.s = n.state
    if (n.covered) { entry.covered = true; if (n.coveredBy) entry.coveredBy = n.coveredBy }
    if (n.sourceType) { entry.sourceType = n.sourceType; entry.semanticsAvailable = false }
    map.push(entry)
  }
  return { dimensions: snapshot.rootId ? { width: snapshot.nodes.get(snapshot.rootId).bbox[2], height: snapshot.nodes.get(snapshot.rootId).bbox[3] } : { width: 0, height: 0 }, map }
}

// ── Capabilities probe (§8): report what actually works, never "bypass CSP" ───
let capsPromise = null
function probeCapabilities() {
  if (capsPromise) return capsPromise
  capsPromise = (async () => {
    const caps = { inlineStyles: false, dataUrls: false, blobUrls: false, crossOriginFonts: null }
    try {
      const st = document.createElement('style')
      st.setAttribute('data-snapdom-internal', '')
      st.textContent = '.__sd_agent_probe{color:inherit}'
      document.head.appendChild(st)
      caps.inlineStyles = !!(st.sheet && st.sheet.cssRules.length)
      st.remove()
    } catch { }
    const tryImg = (src) => new Promise((resolve) => {
      const img = new Image()
      const done = (ok) => { clearTimeout(t); resolve(ok) }
      const t = setTimeout(() => done(false), 120)
      img.onload = () => done(true)
      img.onerror = () => done(false)
      img.src = src
    })
    caps.dataUrls = await tryImg('data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==')
    try {
      const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: 'image/svg+xml' })
      const u = URL.createObjectURL(blob)
      caps.blobUrls = await tryImg(u)
      URL.revokeObjectURL(u)
    } catch { }
    return caps
  })()
  return capsPromise
}

/**
 * Inspect a live subtree: identity, signatures, occlusion, context, Set-of-Mark,
 * and (with `previous`) what changed. The walk is synchronous over the live,
 * computed DOM; when only inspect() is called no clone is ever built.
 *
 * @param {Element} root
 * @param {{previous?: object, noise?: 'agent'|'none'|object, excludeText?: boolean}} [options]
 */
export async function inspect(root, options = {}) {
  if (!root || root.nodeType !== 1) throw new Error('[agent.inspect] element required')
  const noise = resolveNoise(options.noise)
  runCounter++

  let snapshot = takeSnapshot(root, noise)
  // Namespace this run's ids so unmatched (added) nodes can never collide with a
  // previous checkpoint's ids after relabeling.
  const salt = runCounter.toString(36) + 'r'
  {
    const idMap = new Map()
    for (const id of snapshot.order) idMap.set(id, 'n_' + salt + id.slice(2))
    snapshot = applyStableIds(snapshot, idMap)
  }

  let diff = null
  if (options.previous) {
    const prev = options.previous.nodes instanceof Map || options.previous.__inflated
      ? options.previous
      : inflateCheckpoint(options.previous)
    diff = diffSnapshots(prev, snapshot)
    snapshot = applyStableIds(snapshot, diff.idMap)
  }

  const query = makeQueryApi(snapshot)

  // Regions whose semantics this walk cannot read (canvas pixels, blocked iframes).
  // This must travel WITH the change report: "nothing changed in the DOM" is a
  // dangerously incomplete answer when a chart may have repainted — blind-judge runs
  // showed a model concluding "nothing happened" on a canvas redraw. The honest report
  // says: nothing changed that I can see, AND here is what I cannot see.
  const unobservable = []
  for (const id of snapshot.order) {
    const n = snapshot.nodes.get(id)
    if (n.semanticsAvailable === false) {
      unobservable.push({ id: n.id, role: n.role, sourceType: n.sourceType, bbox: n.bbox, rasterAvailable: !!n.rasterAvailable })
    }
  }

  const ui = {
    rootHash: snapshot.rootHash,
    unobservable,
    context: renderContext(snapshot),
    agentMap: renderAgentMap(snapshot),
    capabilities: await probeCapabilities(),

    changed: diff ? diff.changed : undefined,
    changes: diff ? diff.changes : undefined,
    actionabilityDelta: diff ? diff.actionabilityDelta : undefined,

    checkpoint: (opts) => makeCheckpoint(snapshot, { excludeText: options.excludeText, ...(opts || {}) }),

    getByRole: query.getByRole,
    getByText: query.getByText,
    getByLabel: query.getByLabel,
    getByTestId: query.getByTestId,

    /**
     * Optional render visitor on the same walk (§8): the semantic snapshot is
     * re-taken synchronously inside beforeClone — the SAME task as the clone walk,
     * no awaits in between — so pixels, structure and bboxes share one instant.
     * @param {object} [target] - a query match; captures that region instead of the page
     */
    rasterize: async (target) => {
      const { snapdom } = await import('../../../src/api/snapdom.js')
      const el = target ? resolve(target) : root
      if (!el) throw new Error('[agent.rasterize] target no longer in the DOM')
      const ride = {
        name: 'agent-semantic-ride',
        pure: true,
        beforeClone: () => {
          // Same-task re-sign: this ui's snapshot now matches the clone's instant.
          let fresh = takeSnapshot(root, noise)
          const salt2 = (++runCounter).toString(36) + 'r' // fresh namespace: no id collisions
          const idMap2 = new Map()
          for (const id of fresh.order) idMap2.set(id, 'n_' + salt2 + id.slice(2))
          fresh = applyStableIds(fresh, idMap2)
          const d = diffSnapshots(snapshot, fresh)
          fresh = applyStableIds(fresh, d.idMap)
          Object.assign(snapshot, fresh)
          ui.rootHash = fresh.rootHash
          ui.context = renderContext(fresh)
          ui.agentMap = renderAgentMap(fresh)
        },
      }
      const result = await snapdom(el, { plugins: [ride] })
      ui.capabilities = await probeCapabilities()
      return result
    },
  }
  LAST_SNAPSHOT = snapshot
  return ui
}

let LAST_SNAPSHOT = null

/**
 * Resolve a snapshot match (or node id) to the live element — or null if it left
 * the DOM. Action execution is out of scope; this is the whole bridge.
 * @param {{id: string}|string} match
 * @returns {Element|null}
 */
export function resolve(match) {
  const id = typeof match === 'string' ? match : match && match.id
  if (!id) return null
  // A match carries its own elements table (immune to later inspections); bare ids
  // fall back to the most recent snapshot.
  const table = (match && match[MATCH_ELEMENTS]) || (LAST_SNAPSHOT && LAST_SNAPSHOT.elements)
  const el = table && table.get(id)
  return el && el.isConnected ? el : null
}

export const agent = { inspect, resolve }
export default agent
