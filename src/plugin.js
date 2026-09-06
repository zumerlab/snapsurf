/**
 * The semantic visitor, as a snapDOM lifecycle plugin.
 * MIT License. Copyright (c) 2026 Juan Martin Muda / zumerlab.
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
import { createCaptureRedactor, beginCaptureRedaction, capturePrivacyPolicy, assertCaptureBaseline, assertCaptureReader } from './capture-redaction.js'
import { takeSnapshot, takeSnapshotChunked, makeSlicer, getPrivacyInputs } from './snapshot.js'
import { resolveNoise } from './noise.js'
import { diffSnapshots } from './diff.js'
import { makeCheckpoint, inflateCheckpoint, inflateCheckpointChunked } from './checkpoint.js'
import { makeQueryApi } from './query.js'
import { hash } from './hash.js'

// A realm-local counter restarts after reload and in every iframe/worker realm. A
// persisted checkpoint could therefore donate an id to a genuinely new node and make the
// stable-id relabel pass collapse two nodes into one Map entry. Give EVERY observation a
// fresh 64-bit namespace instead: that covers independent realms and concurrent runs in
// one step. URL-safe base64 stores it in 11 characters (versus 13 in base36), preserving
// the checkpoint compactness budget.
const randomNamespace = () => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'
  const words = globalThis.crypto.getRandomValues(new Uint32Array(2))
  let value = (BigInt(words[0]) << 32n) | BigInt(words[1])
  let out = ''
  for (let i = 0; i < 11; i++) {
    out = alphabet[Number(value & 63n)] + out
    value >>= 6n
  }
  return out
}

const PRIVACY_VALUE_UNCERTAINTY = Object.freeze({
  sourceType: 'privacy-redacted-input-value',
  scope: 'value-change-detection',
  detection: 'presence-only',
  uncertainty: 'value changes hidden by an active privacy rule may be missed',
})

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

/** Mutable tally the redaction pass fills. Rules are tracked by INDEX, never by
 *  text: the report travels to the consumer (an LLM), and naming the rule would
 *  leak the very string the caller asked to hide. The operator who wrote the rule
 *  list maps indexes back to terms. */
function createPrivacyTally() {
  return { rules: new Map(), fields: new Map(), nodes: new Set() }
}

function recordHit(tally, ruleIndex, field, id) {
  if (!tally) return
  tally.rules.set(ruleIndex, (tally.rules.get(ruleIndex) || 0) + 1)
  tally.fields.set(field, (tally.fields.get(field) || 0) + 1)
  if (id) tally.nodes.add(id)
}

/** Serializable summary of a tally — counts only, no redacted content, no rule text. */
function summarizePrivacyTally(tally, ruleCount) {
  return {
    rulesActive: ruleCount,
    hitsByRule: [...tally.rules].sort((a, b) => a[0] - b[0]).map(([i, hits]) => ({ rule: `#${i}`, hits })),
    fields: Object.fromEntries([...tally.fields].sort()),
    nodesRedacted: tally.nodes.size,
  }
}

/** One-string redactor for consumers that read the LIVE DOM (daemon `text` verb,
 *  section headings, name upgrades): same rules, no tally. Returns the input
 *  untouched when no rules are configured. */
export function redactString(value, privacy) {
  const rules = normalizePrivacyRules(privacy)
  if (!rules.length) return value
  return redactText(value, rules)
}

function redactText(value, rules, tally, field, id) {
  if (typeof value !== 'string' || !value.trim()) return value
  const candidates = [value.toLowerCase()]
  let decoded = value
  // URLs and DOM text sometimes carry percent-encoded identifiers. Literal rules must
  // cover those representations too; redacting only the raw string leaks
  // alice%40corp.test under a rule for alice@corp.test.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      candidates.push(decoded.toLowerCase())
    } catch { break }
  }
  let matched = false
  // EVERY rule that matches is counted, not just the first one: first-match attribution
  // made `redact sec,secret` report 0 hits for `secret` even though it matched every
  // occurrence. The contract promised "hits per rule" and the implementation measured
  // something else. The replacement itself is still applied once.
  for (let i = 0; i < rules.length; i++) {
    if (candidates.some((candidate) => candidate.includes(rules[i]))) { recordHit(tally, i, field, matched ? null : id); matched = true }
  }
  return matched ? '[redacted]' : value
}

/** Redact the readable fields of a node/ref/change entry ({name?, label?, coveredBy?}). */
function redactRef(ref, rules, tally) {
  const next = { ...ref }
  if (next.name) next.name = redactText(next.name, rules, tally, 'name', next.id)
  if (next.nameForIdentity) next.nameForIdentity = redactText(next.nameForIdentity, rules, tally, 'name', next.id)
  if (next.label) next.label = redactText(next.label, rules, tally, 'label', next.id)
  if (next.coveredBy) next.coveredBy = redactRef(next.coveredBy, rules, tally)
  return next
}

function redactState(state, rules, tally, id) {
  const out = {}
  for (const [k, v] of Object.entries(state)) out[k] = typeof v === 'string' ? redactText(v, rules, tally, 'state', id) : v
  return out
}

/** Build the exact style serialization snapshot.js hashes, after filtering each value. */
function privateStyleHash(parts, rules, tally, id) {
  const safe = parts.map(([prop, value]) => [prop, redactText(value, rules, tally, 'style', id)])
  return hash('y', safe.map(([prop, value]) => prop + ':' + value).join(';'))
}

/**
 * Return a privacy-safe snapshot, including its identity/change signatures.
 *
 * Redacting only readable fields is insufficient: a checkpoint holder can hash a guess
 * and compare it with `nameFp`, `textFp`, `textHash`, `stateHash` or an ancestor Merkle
 * hash. snapshot.js therefore keeps the raw signature inputs on a non-enumerable Symbol
 * while this pass rebuilds every affected signature from the already-redacted values.
 * The Symbol never survives the clones below.
 */
function applyPrivacy(snapshot, privacy, tally) {
  const rules = normalizePrivacyRules(privacy)
  if (!snapshot || !rules.length) return snapshot
  const nodes = new Map()
  for (const [id, n] of snapshot.nodes) {
    const next = redactRef(n, rules, tally)
    const inputs = getPrivacyInputs(n)
    const safeTestid = n.testid ? redactText(n.testid, rules, tally, 'testid', id) : null
    // A shared `[redacted]` test id would become a false 100-point identity signal. Drop
    // it instead: structural/geometry signals can still match the node without creating a
    // presence oracle or merging every protected test id into one identity.
    next.testid = safeTestid === '[redacted]' ? null : safeTestid
    if (next.state) next.state = redactState(next.state, rules, tally, id)

    if (inputs) {
      let safeText = redactText(inputs.normText, rules, tally, 'text', id)
      let safeRawText = redactText(inputs.ownText, rules, tally, 'text', id)
      // Whitespace normalization can make a rule match one representation but not the
      // other. If either side is protected, both signatures must use the same sentinel;
      // otherwise rawTextHash remains an oracle for the alternate representation.
      if (safeText === '[redacted]' || safeRawText === '[redacted]') {
        safeText = '[redacted]'
        safeRawText = '[redacted]'
      }
      const safeNameForIdentity = redactText(inputs.nameForIdentity, rules, tally, 'name', id)
      const safeAuthored = inputs.authoredParts.map(([kind, value]) => [
        kind,
        redactText(value, rules, tally, kind, id),
      ])
      const authoredHash = safeAuthored.length
        ? hash('authored', ...safeAuthored.flat())
        : ''

      let valueSignal = inputs.valueSignal
      if (inputs.rawValue !== null && inputs.rawValue !== '') {
        const safeValue = redactText(inputs.rawValue, rules, tally, 'value', id)
        if (safeValue === '[redacted]') {
          valueSignal = 'privacy-redacted-value'
          // Ordinary inputs expose a bullet mask whose length is exact up to 12 chars.
          // Once the value matches a privacy rule, retain only presence: persisting the
          // mask or hashing it would still let a checkpoint holder test length guesses.
          if (next.state) {
            next.state = { ...next.state }
            delete next.state.value
          }
          // A constant signal necessarily hides edits between two protected values. Make
          // that limitation explicit instead of returning an unqualified changed:false.
          if (!next.valueChangeUncertainty) {
            next.valueChangeUncertainty = PRIVACY_VALUE_UNCERTAINTY
          }
        } else if (!inputs.sensitive) valueSignal = hash('v', inputs.rawValue)
      }

      next.text = safeText
      next.nameForIdentity = safeNameForIdentity
      next.nameFp = safeNameForIdentity && safeNameForIdentity !== '[redacted]'
        ? hash('nm', safeNameForIdentity)
        : ''
      next.textFp = safeText && safeText !== '[redacted]'
        ? hash('f', safeText.slice(0, 200))
        : ''
      next.textHash = hash('t', safeText, authoredHash)
      next.rawTextHash = safeRawText === safeText
        ? next.textHash
        : hash('t', safeRawText, authoredHash)
      next.stateHash = hash('s', JSON.stringify(next.state), valueSignal)
      next.styleHash = privateStyleHash(inputs.styleParts, rules, tally, id)
    } else {
      // Defensive fallback for a caller that invokes buildUi(rawObservation, {privacy})
      // after observing without privacy collection. Never retain opaque raw signatures:
      // deriving a smaller, structural signature is preferable to a guessing oracle.
      const safeText = redactText(next.text || '', rules, tally, 'text', id)
      next.text = safeText
      next.nameFp = next.nameForIdentity && next.nameForIdentity !== '[redacted]'
        ? hash('privacy-fallback-name', next.nameForIdentity)
        : ''
      next.textFp = safeText && safeText !== '[redacted]'
        ? hash('privacy-fallback-fp', safeText.slice(0, 200))
        : ''
      next.textHash = hash('privacy-fallback-text', safeText, next.name || '')
      next.rawTextHash = next.textHash
      next.stateHash = hash('privacy-fallback-state', JSON.stringify(next.state))
      next.styleHash = hash('privacy-fallback-style')
    }

    next.contentHash = hash(
      'c', next.tag, next.role, next.testid || '', next.textHash, next.stateHash, next.styleHash
    )
    nodes.set(id, next)
  }

  // Merkle hashes inherit every descendant signature. Rebuild them bottom-up or the root
  // itself remains a deterministic oracle even after all leaf fields are safe.
  for (let i = snapshot.order.length - 1; i >= 0; i--) {
    const n = nodes.get(snapshot.order[i])
    if (!n) continue
    const children = n.childIds.map((childId) => nodes.get(childId)?.subtreeHash || '')
    n.subtreeHash = hash('m', n.contentHash, children.join('|'))
  }
  const rootHash = snapshot.rootId && nodes.get(snapshot.rootId)
    ? nodes.get(snapshot.rootId).subtreeHash
    : hash('empty')
  return { ...snapshot, nodes, rootHash }
}

/** The diff is the product's main output — it must honor the same rules as the views.
 *  Matching is untouched: it rides fingerprints/hashes, never the readable strings. */
function applyDiffPrivacy(diff, privacy, tally) {
  const rules = normalizePrivacyRules(privacy)
  if (!diff || !rules.length) return diff
  const changes = diff.changes.map((c) => {
    const next = redactRef(c, rules, tally)
    if (next.beforeName) next.beforeName = redactText(next.beforeName, rules, tally, 'name', next.id)
    if (next.before) next.before = redactState(next.before, rules, tally, next.id)
    if (next.after) next.after = redactState(next.after, rules, tally, next.id)
    return next
  })
  const delta = diff.actionabilityDelta && {
    becameCovered: diff.actionabilityDelta.becameCovered.map((r) => redactRef(r, rules, tally)),
    becameVisible: diff.actionabilityDelta.becameVisible.map((r) => redactRef(r, rules, tally)),
  }
  return { ...diff, changes, actionabilityDelta: delta }
}

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
function* finishObserveStages(snapshot, options, noise, namespace) {
  // capture before applyStableIds rebuilds the snapshot object
  const torn = snapshot.torn || 0
  // Namespace this run's ids so unmatched (added) nodes can never collide with a
  // previous checkpoint's ids after relabeling. `namespace` is captured at observe start,
  // so interleaved chunked observations cannot borrow one another's epoch.
  const salt = namespace
  {
    const idMap = new Map()
    for (const id of snapshot.order) idMap.set(id, 'n_' + salt + id.slice(2))
    snapshot = applyStableIds(snapshot, idMap)
  }
  yield 'saltIds'
  const privacyRules = normalizePrivacyRules(options.privacy)
  const privacyTally = privacyRules.length ? createPrivacyTally() : null
  if (privacyTally) {
    // A persisted baseline and the fresh side of a diff must carry the SAME safe
    // signatures. Sanitizing only in buildUi() would compare a protected checkpoint
    // against raw current hashes and turn every unchanged secret into a false change.
    snapshot = applyPrivacy(snapshot, options.privacy, privacyTally)
    yield 'privacy'
  }
  let diff = null
  if (options.previous) {
    const prev = options.previous.nodes instanceof Map || options.previous.__inflated
      ? options.previous
      : inflateCheckpoint(options.previous)
    yield 'inflate'
    diff = diffSnapshots(prev, snapshot)
    yield 'diff'
    snapshot = applyStableIds(snapshot, diff.idMap)
  }
  return { snapshot, diff, noise, torn, privacyTally, privacyApplied: !!privacyTally }
}

export function observe(root, options = {}) {
  const noise = resolveNoise(options.noise)
  const namespace = randomNamespace()
  const gen = finishObserveStages(takeSnapshot(root, noise, {
    strictScope: options.strictScope === true,
    engineFrame: options.engineFrame,
    capturePolicy: options.capturePolicy,
  }), options, noise, namespace)
  let r = gen.next()
  while (!r.done) r = gen.next()
  return r.value
}

/** Chunked observe: same result shape plus `torn` (see takeSnapshotChunked). */
export async function observeChunked(root, options = {}) {
  const noise = resolveNoise(options.noise)
  const namespace = randomNamespace()
  const P = typeof window !== 'undefined' && window.__SD_PROF
  // Inflate BEFORE the walk, sliced: three hash derivations per node made it the
  // biggest post-walk monolith (480ms measured by the panel). Callers that reuse a
  // baseline (assert retries) pass an already-inflated one and skip this entirely.
  if (options.previous && !(options.previous.nodes instanceof Map) && !options.previous.__inflated) {
    const t0 = performance.now()
    const prev = await inflateCheckpointChunked(options.previous, makeSlicer(options.budgetMs || 40))
    if (P) P.inflate = (P.inflate || 0) + (performance.now() - t0)
    options = { ...options, previous: prev }
  }
  const snap = await takeSnapshotChunked(root, noise, {
    budgetMs: options.budgetMs,
    strictScope: options.strictScope === true,
    engineFrame: options.engineFrame,
    capturePolicy: options.capturePolicy,
  })
  // Internal lifecycle hook for resident sensors: it fixes the semantic window boundary
  // at the instant the DOM snapshot is complete, before privacy/diff stages may yield.
  // The snapshot is not exposed by the hook and the callback must remain synchronous.
  if (typeof options.onSnapshotCaptured === 'function') options.onSnapshotCaptured()
  // The post-walk stages yield between one another: with a baseline present,
  // inflate + diff + relabel used to run as ONE task and blocked ~1s on 3.5k-node
  // pages (panel probe round) — the walk sliced, its bookends didn't.
  const pause = makeSlicer(options.budgetMs || 40)
  const gen = finishObserveStages(snap, options, noise, namespace)
  let t = performance.now()
  let r = gen.next()
  while (!r.done) {
    if (P) P[r.value] = (P[r.value] || 0) + (performance.now() - t)
    const p = pause()
    if (p) await p
    t = performance.now()
    r = gen.next()
  }
  if (P) P.relabel = (P.relabel || 0) + (performance.now() - t)
  return r.value
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
  const privacyRules = normalizePrivacyRules(options.privacy)
  const tally = observation.privacyTally || (privacyRules.length ? createPrivacyTally() : null)
  const viewSnapshot = observation.privacyApplied
    ? snapshot
    : applyPrivacy(snapshot, options.privacy, tally)
  const viewDiff = applyDiffPrivacy(diff, options.privacy, tally)
  // Queries are public output too. Binding them to the raw snapshot leaked configured
  // secrets through match.name even while context/map/diff were redacted. Element maps
  // survive applyPrivacy(), so resolution still reaches the original live node.
  const querySnapshot = viewSnapshot
  // Privacy applies to predicates as well as returned matches. Consulting the raw graph
  // here allowed getByTestId(secret) / getByRole({name: secret}) to act as a presence
  // oracle even when the returned fields themselves were redacted.
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
    // Sensitive input values deliberately do not participate in a per-value digest.
    // Keep role/name/state semantics available, but make the resulting change-detection
    // limit travel on the existing report surface instead of returning a silent false.
    if (n.valueChangeUncertainty) {
      unobservable.push({
        id: n.id,
        role: n.role,
        bbox: n.bbox,
        semanticsAvailable: true,
        ...n.valueChangeUncertainty,
      })
    }
  }

  const ui = {
    rootHash: viewSnapshot.rootHash,
    unobservable,
    // context is LAZY: the outline is pure string building over every node (13k on a
    // large article) and the assert path never reads it — rendering it eagerly was
    // measurable dead weight in throttled environments (panel perf round).
    get context() {
      if (this.__context === undefined) this.__context = renderContext(viewSnapshot)
      return this.__context
    },
    agentMap: renderAgentMap(viewSnapshot),

    changed: viewDiff ? viewDiff.changed : undefined,
    changes: viewDiff ? viewDiff.changes : undefined,
    actionabilityDelta: viewDiff ? viewDiff.actionabilityDelta : undefined,
    geometryOnly: viewDiff ? viewDiff.geometryOnly : undefined,
    foldedWrappers: viewDiff ? viewDiff.foldedWrappers : undefined,

    // Auditable redaction report (only when rules are active): counts by rule index
    // and field, never the redacted content or the rule text itself.
    privacy: tally ? summarizePrivacyTally(tally, privacyRules.length) : undefined,

    checkpoint: (opts) => makeCheckpoint(viewSnapshot, { excludeText: options.excludeText, ...(opts || {}) }),

    getByRole: query.getByRole,
    getByText: query.getByText,
    getByLabel: query.getByLabel,
    getByTestId: query.getByTestId,

    // Kept for compatibility, but never expose a less-private graph than the public API.
    __snapshot: viewSnapshot,
    // The privacy-filtered view. Consumers that render page strings themselves
    // (the daemon digest, click echoes) MUST read names/text from here.
    __view: viewSnapshot,
  }
  return ui
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
 *          privacy?: { redact?: string[] }, captureRedaction?: object}} [options]
 */
export function agentOracle(options = {}) {
  const redactor = createCaptureRedactor(options.captureRedaction)
  assertCaptureBaseline(options.previous, redactor)
  const state = { observation: null, ui: null }

  return {
    name: 'agent-oracle',
    ...(redactor ? {
      beforeSnap: ctx => beginCaptureRedaction(redactor, ctx),
      afterClone: ctx => redactor.afterClone(ctx),
      ...(redactor.beforeRender ? { beforeRender: ctx => redactor.beforeRender(ctx) } : {}),
    } : {}),

    /**
     * The walk. Runs before `prepareClone`, synchronously, in the same task — so the
     * snapshot, the clone and therefore the pixels all describe one instant.
     */
    beforeClone(ctx) {
      assertCaptureReader(redactor, ctx)
      // A single snapdom() call can run the pipeline more than once — on real pages a
      // pass over `document.body` is followed by one over `documentElement`. Keeping
      // whichever ran last silently replaced the caller's subtree with `<html>`, which
      // is how three of five field sites reported an empty snapshot. The first pass is
      // the element the caller asked about; later passes are the engine's own business.
      if (state.observation) return
      state.observation = observe(ctx.element, { ...options, capturePolicy: redactor ? capturePrivacyPolicy(ctx) : null })
      state.ui = buildUi(state.observation, options)
      if (redactor) {
        const checkpoint = state.ui.checkpoint
        state.ui.checkpoint = opts => ({ ...checkpoint(opts), captureRedactionPolicy: redactor.capturePolicyId })
        state.ui.__snapshot.captureRedactionPolicy = redactor.capturePolicyId
      }
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
