/* global document, Image, Blob, URL, clearTimeout, setTimeout */

/**
 * The semantic visitor, as a snapDOM lifecycle plugin.
 * PRIVATE, PROPRIETARY, NEVER PUBLISHED. See package.json / LICENSE.
 *
 * This module is the product's single integration point with snapdom core: the walk
 * runs inside `beforeClone`, in the same task as the clone walk that follows it, with
 * no awaits in between — which is what makes the §8 same-instant guarantee real rather
 * than asserted. Pixels and semantics come out of one capture:
 *
 *   const result = await snapdom(el, { plugins: [agentOracle({ previous })] })
 *   await result.toChanges()      // what changed
 *   await result.toAgentMap()     // what can I click
 *   await result.toPng()          // …and the image, from the same instant
 *
 * Core is untouched and knows nothing about this package (§Anti-goals).
 * @module agent/plugin
 */
import { takeSnapshot, takeSnapshotChunked } from './snapshot.js'
import { resolveNoise } from './noise.js'
import { diffSnapshots } from './diff.js'
import { makeCheckpoint, inflateCheckpoint } from './checkpoint.js'
import { makeQueryApi } from './query.js'

let runCounter = 0

// ── Privacy (§9): rule-based redaction of every string that leaves the page ──────────
// Rules only — no sensitive-looking heuristics. Input VALUES never need one: snapshot.js
// hashes the raw value and stores only a mask, so the only strings that can leak are
// names/labels/text, and those the caller names explicitly.
function normalizePrivacyRules(privacy) {
  const redact = []
  if (privacy && Array.isArray(privacy.redact)) {
    for (const item of privacy.redact) {
      const value = String(item || '').trim().toLowerCase()
      if (value) redact.push(value)
    }
  }
  return redact
}

function redactText(value, rules) {
  if (typeof value !== 'string' || !value.trim()) return value
  const lower = value.toLowerCase()
  for (const rule of rules) {
    if (lower.includes(rule)) return '[redacted]'
  }
  return value
}

/** Redact the readable fields of a node/ref/change entry ({name?, label?, coveredBy?}). */
function redactRef(ref, rules) {
  const next = { ...ref }
  if (next.name) next.name = redactText(next.name, rules)
  if (next.label) next.label = redactText(next.label, rules)
  if (next.coveredBy) next.coveredBy = redactRef(next.coveredBy, rules)
  return next
}

function redactState(state, rules) {
  const out = {}
  for (const [k, v] of Object.entries(state)) out[k] = typeof v === 'string' ? redactText(v, rules) : v
  return out
}

export function applyPrivacy(snapshot, privacy) {
  const rules = normalizePrivacyRules(privacy)
  if (!snapshot || !rules.length) return snapshot
  const nodes = new Map()
  for (const [id, n] of snapshot.nodes) {
    const next = redactRef(n, rules)
    if (next.text) next.text = redactText(next.text, rules)
    if (next.state) next.state = redactState(next.state, rules)
    nodes.set(id, next)
  }
  return { ...snapshot, nodes }
}

/** The diff is the product's main output — it must honor the same rules as the views.
 *  Matching is untouched: it rides fingerprints/hashes, never the readable strings. */
export function applyDiffPrivacy(diff, privacy) {
  const rules = normalizePrivacyRules(privacy)
  if (!diff || !rules.length) return diff
  const changes = diff.changes.map((c) => {
    const next = redactRef(c, rules)
    if (next.beforeName) next.beforeName = redactText(next.beforeName, rules)
    if (next.before) next.before = redactState(next.before, rules)
    if (next.after) next.after = redactState(next.after, rules)
    return next
  })
  const delta = diff.actionabilityDelta && {
    becameCovered: diff.actionabilityDelta.becameCovered.map((r) => redactRef(r, rules)),
    becameVisible: diff.actionabilityDelta.becameVisible.map((r) => redactRef(r, rules)),
  }
  return { ...diff, changes, actionabilityDelta: delta }
}

/** Relabel matched after-nodes to their stable before ids (§2: identity persists). */
export function applyStableIds(snapshot, idMap) {
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
export function probeCapabilities() {
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
    } catch {
      // Capability probing is best-effort; failures simply leave the flag off.
    }
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
    } catch {
      // Blob URL probing is best-effort and should not break the inspection flow.
    }
    return caps
  })()
  return capsPromise
}

/**
 * THE semantic visitor. Synchronous end-to-end: every read is `getComputedStyle`,
 * `getBoundingClientRect` or `elementFromPoint`, so the page cannot drift between the
 * first node and the last, nor between this walk and the clone walk that follows it.
 *
 * @param {Element} root
 * @param {{previous?: object, noise?: any}} options
 */
function finishObserve(snapshot, options, noise) {
  // capture before applyStableIds rebuilds the snapshot object
  const torn = snapshot.torn || 0
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
  return { snapshot, diff, noise, torn }
}

export function observe(root, options = {}) {
  const noise = resolveNoise(options.noise)
  runCounter++
  return finishObserve(takeSnapshot(root, noise), options, noise)
}

/** Chunked observe: same result shape plus `torn` (see takeSnapshotChunked). */
export async function observeChunked(root, options = {}) {
  const noise = resolveNoise(options.noise)
  runCounter++
  const snap = await takeSnapshotChunked(root, noise, { budgetMs: options.budgetMs })
  return finishObserve(snap, options, noise)
}

/** Most recent walk — the fallback table `agent.resolve()` uses for bare node ids. */
let LAST_SNAPSHOT = null
export const getLastSnapshot = () => LAST_SNAPSHOT

/**
 * Shape the walk's output into the public `ui` object. Kept separate from `observe`
 * so the plugin can expose the same data through `defineExports` without building it
 * twice.
 */
export function buildUi(observation, options = {}) {
  const { snapshot, diff } = observation
  const viewSnapshot = applyPrivacy(snapshot, options.privacy)
  const viewDiff = applyDiffPrivacy(diff, options.privacy)
  const querySnapshot = snapshot
  const query = makeQueryApi(querySnapshot)
  LAST_SNAPSHOT = querySnapshot

  // Regions whose semantics this walk cannot read (canvas pixels, blocked iframes).
  // This must travel WITH the change report: "nothing changed in the DOM" is a
  // dangerously incomplete answer when a chart may have repainted — blind-judge runs
  // showed a model concluding "nothing happened" on a canvas redraw. The honest report
  // says: nothing changed that I can see, AND here is what I cannot see.
  const unobservable = []
  for (const id of viewSnapshot.order) {
    const n = viewSnapshot.nodes.get(id)
    if (n.semanticsAvailable === false) {
      unobservable.push({ id: n.id, role: n.role, sourceType: n.sourceType, bbox: n.bbox, rasterAvailable: !!n.rasterAvailable })
    }
  }

  return {
    rootHash: viewSnapshot.rootHash,
    unobservable,
    context: renderContext(viewSnapshot),
    agentMap: renderAgentMap(viewSnapshot),

    changed: viewDiff ? viewDiff.changed : undefined,
    changes: viewDiff ? viewDiff.changes : undefined,
    actionabilityDelta: viewDiff ? viewDiff.actionabilityDelta : undefined,

    checkpoint: (opts) => makeCheckpoint(viewSnapshot, { excludeText: options.excludeText, ...(opts || {}) }),

    getByRole: query.getByRole,
    getByText: query.getByText,
    getByLabel: query.getByLabel,
    getByTestId: query.getByTestId,

    __snapshot: querySnapshot,
  }
}

/**
 * The snapDOM plugin. One instance per capture (it carries that capture's observation).
 *
 * Deliberately **not** `pure: true`. Purity would opt this capture back into snapdom's
 * memoization and differential recapture, and a memo serve skips lifecycle hooks — the
 * change oracle would then answer from a stale walk, which is the one failure it must
 * never have. Suspending the fast paths is the correct trade for a plugin whose whole
 * job is to read fresh state.
 *
 * @param {{previous?: object, noise?: any, excludeText?: boolean,
 *          privacy?: { redact?: string[] }}} [options]
 */
export function agentOracle(options = {}) {
  const state = { observation: null, ui: null }

  return {
    name: 'agent-oracle',

    /**
     * The walk. Runs before `prepareClone`, synchronously, in the same task — so the
     * snapshot, the clone and therefore the pixels all describe one instant.
     */
    beforeClone(ctx) {
      // A single snapdom() call can run the pipeline more than once — on real pages a
      // pass over `document.body` is followed by one over `documentElement`. Keeping
      // whichever ran last silently replaced the caller's subtree with `<html>`, which
      // is how three of five field sites reported an empty snapshot. The first pass is
      // the element the caller asked about; later passes are the engine's own business.
      if (state.observation) return
      state.observation = observe(ctx.element, options)
      state.ui = buildUi(state.observation, options)
    },

    // The exports read this instance's closure, not the hook context: lifecycle hooks
    // and export hooks are handed different context objects by the core, and one
    // oracle instance belongs to exactly one capture anyway.
    defineExports() {
      const ui = () => {
        if (!state.ui) throw new Error('[agent-oracle] no walk recorded — reuse one oracle instance per capture')
        return state.ui
      }
      return {
        changes: async () => ({
          changed: ui().changed,
          changes: ui().changes,
          actionabilityDelta: ui().actionabilityDelta,
          unobservable: ui().unobservable,
        }),
        agentMap: async () => ui().agentMap,
        agentContext: async () => ui().context,
        checkpoint: async (_ctx, opts) => ui().checkpoint(opts),
        // §8: what actually worked in this environment — never "we bypass CSP".
        capabilities: async () => probeCapabilities(),
      }
    },

    /** The observation this instance produced — how `inspect()` collects its result. */
    get ui() { return state.ui },
  }
}
