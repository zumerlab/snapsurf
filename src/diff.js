/**
 * Change derivation (§3) + actionability delta (§4). The kind comes from WHICH
 * signature component changed; geometry is diffed separately, with tolerance,
 * and NEVER propagates ("the button moved" ≠ "the button changed").
 * @module agent/diff
 */
import { matchSnapshots, sameHash } from './match.js'

// These two state bits use presence-only encoding in snapshots: absence means false.
// Change evidence is consumed as a literal matcher (`to: { disabled: false }`), so make
// that implicit endpoint explicit only when the transition actually involves the bit.
// ARIA states deliberately retain their three-way true/false/absent semantics.
const PRESENCE_BOOLEAN_STATE = ['disabled', 'hasValue']

function stateEvidence(beforeState, afterState) {
  const before = { ...(beforeState || {}) }
  const after = { ...(afterState || {}) }
  for (const key of PRESENCE_BOOLEAN_STATE) {
    if (Object.hasOwn(before, key) || Object.hasOwn(after, key)) {
      if (!Object.hasOwn(before, key)) before[key] = false
      if (!Object.hasOwn(after, key)) after[key] = false
    }
  }
  return { before, after }
}

/** A deserialized checkpoint keys nodes by id but carries no `id` field (and its
 *  parent link is `parent`, not `parentId`) — normalize before matching. */
function hydrate(before) {
  if (before.nodes instanceof Map) return before
  const nodes = {}
  for (const [id, n] of Object.entries(before.nodes)) {
    nodes[id] = n.id ? n : { ...n, id, parentId: n.parentId ?? n.parent ?? null, childIds: n.childIds || [] }
  }
  return { ...before, nodes }
}

/**
 * @param {{nodes: Map|Object, rootId: string, rootHash: string}} before - checkpoint or snapshot
 * @param {{nodes: Map, rootId: string, rootHash: string}} after - fresh snapshot
 * @returns {{ changed: boolean, changes: object[],
 *             actionabilityDelta: {becameCovered: string[], becameVisible: string[]},
 *             idMap: Map<string,string> }} idMap: afterId → stable (before) id
 */
export function diffSnapshots(before, after) {
  before = hydrate(before)
  const bGet = (id) => (before.nodes instanceof Map ? before.nodes.get(id) : before.nodes[id])
  const { matches, removedIds, addedIds, replacements } = matchSnapshots(before, after)
  const changes = []
  // Actionability entries carry role+name, not a bare id: a consumer (or a model) must be
  // able to tell WHICH button stopped being clickable without cross-referencing anything.
  // Blind-judge runs showed bare ids are unusable — the judge could count the covered
  // elements but not name them, while a screenshot judge said "Guardar, Borrar".
  const becameCovered = []
  const becameVisible = []
  const idMap = new Map()
  // `coveredBy` names the occluder for the same reason: an end-to-end loop showed an agent
  // that knows only THAT a button is covered clearing every candidate overlay in turn,
  // spending one wasted action per candidate.
  const ref = (id, node, identity) => ({
    id,
    role: node.role,
    name: node.name || undefined,
    coveredBy: node.coveredBy,
    ...(identity || {}),
  })

  // Render-level actionability is independent from semantic identity confidence. A
  // virtualized/remounted button can be an ambiguous replacement *and* become covered
  // in the same frame. Record the hit-test transition before any semantic early return,
  // otherwise the uncertainty that most needs escalation disappears from the report.
  const recordActionability = (b, a, { publicId, beforeId, afterId, match }) => {
    const was = !!b.interactive && b.visible !== false && !b.covered
    const now = !!a.interactive && a.visible !== false && !a.covered
    if (was === now) return
    const identity = match === 'ambiguous' ? { match, beforeId, afterId } : undefined
    ;(was ? becameCovered : becameVisible).push(ref(publicId, a, identity))
  }

  const inReplacement = new Set()
  for (const r of replacements) {
    inReplacement.add(r.beforeId)
    inReplacement.add(r.afterId)
  }

  for (const [aId, m] of matches) {
    const b = bGet(m.beforeId)
    const a = after.nodes.get(aId)
    idMap.set(aId, m.beforeId) // stable identity: matched nodes keep their previous id
    recordActionability(b, a, {
      publicId: m.beforeId,
      beforeId: m.beforeId,
      afterId: aId,
      match: m.match,
    })

    // Positional-only match with different content: we are NOT confident this is the
    // same node (virtualized recycling, swapped cards). Report the doubt as an
    // ambiguous replacement instead of asserting "its text changed".
    if (m.match === 'ambiguous' && !sameHash(b.textHash, a.textHash) &&
        !m.matchedBy.includes('data-testid') && !m.matchedBy.includes('role+name')) {
      changes.push({
        kind: 'possible-replacement', match: 'ambiguous',
        beforeId: m.beforeId, afterId: aId,
        role: a.role,
        beforeRole: b.role,
        name: a.name || undefined,        // after-side (what is there now)
        beforeName: b.name || undefined,  // before-side (what was there)
      })
      continue
    }
    const kinds = []
    const detail = { id: m.beforeId, match: m.match, matchedBy: m.matchedBy }

    // Gate on the COMPONENTS (a stored checkpoint doesn't carry the composed
    // contentHash — and the components are what the taxonomy needs anyway).
    // textHash also frames authored semantic/resource content (accessible name, href,
    // img/src). Checkpoints already persist this component, so those changes survive a
    // serialized baseline without adding a second wire field.
    if (!sameHash(b.textHash, a.textHash)) kinds.push('content')
    if (!sameHash(b.stateHash, a.stateHash)) {
      kinds.push('state')
      const evidence = stateEvidence(b.state, a.state)
      detail.before = evidence.before
      detail.after = evidence.after
    }
    if (!sameHash(b.styleHash, a.styleHash)) kinds.push('style')
    if (b.tag !== a.tag || b.role !== a.role) kinds.push('content')
    if (!sameHash(b.geometryHash, a.geometryHash) && b.rel && a.rel) {
      // A normalized-equivalent text change (clock tick, relative time) still nudges
      // the box in proportional fonts. If the RAW text changed while the normalized
      // text did not, the geometry delta is the same non-change — suppress it here,
      // on THIS node only (ripples to siblings still report; they carry no raw-text
      // change of their own). Found by the codex assert round: changed:false went
      // flaky 1.1s after a no-op because the demo clock span resized by one digit.
      const normalizedTextSideEffect = sameHash(b.textHash, a.textHash) &&
        !sameHash(b.rawTextHash || b.textHash, a.rawTextHash || a.textHash)
      if (!normalizedTextSideEffect) {
        if (b.rel[0] !== a.rel[0] || b.rel[1] !== a.rel[1]) kinds.push('moved')
        if (b.rel[2] !== a.rel[2] || b.rel[3] !== a.rel[3]) kinds.push('resized')
      }
    }
    if (kinds.length) {
      for (const kind of kinds) changes.push({ ...detail, kind, role: a.role, name: a.name || undefined })
    }

  }

  for (const id of addedIds) {
    if (inReplacement.has(id)) continue
    const a = after.nodes.get(id)
    changes.push({ id, kind: 'added', match: 'new', role: a.role, name: a.name || undefined })
    if (a.interactive && a.visible && !a.covered) becameVisible.push(ref(id, a))
  }
  for (const id of removedIds) {
    if (inReplacement.has(id)) continue
    const b = bGet(id)
    changes.push({ id, kind: 'removed', match: 'removed', role: b.role, name: b.name || undefined })
  }
  for (const r of replacements) {
    const b = bGet(r.beforeId)
    const a = after.nodes.get(r.afterId)
    // A replacement has no stable identity. Use the after id so consumers can still
    // resolve its current geometry/occluder without pretending it is the old node.
    recordActionability(b, a, {
      publicId: r.afterId,
      beforeId: r.beforeId,
      afterId: r.afterId,
      match: 'ambiguous',
    })
    changes.push({
      kind: 'possible-replacement', match: 'ambiguous',
      beforeId: r.beforeId, afterId: r.afterId,
      role: a.role,
      beforeRole: b.role,
      name: a.name || undefined,
      beforeName: b.name || undefined,
    })
  }

  // ── Presentation annotations (additive: nothing is removed, totals stay honest) ──
  // An ADDED subtree reports every node, so the wrapper chain between its top and its
  // salient leaves is pure reading noise (a suggestion dropdown produced 30 generic
  // wrappers around 7 meaningful changes). Mark those wrappers `folded` so a projection
  // can collapse them; matchers and counts keep seeing the full list.
  // Added-side ONLY: the after snapshot carries full node facts. A removed node may come
  // from a checkpoint baseline that persists no text/sourceType, where "looks like a
  // wrapper" is absence of evidence — folding there hid real content (adversarial round).
  // nameFp is the engine's own identity rule: it is set only for AUTHORED names
  // (aria-label et al) or name-from-content roles — those never fold; a generic whose
  // name is merely concatenated content carries no identity and may.
  const addedSet = new Set()
  for (const c of changes) {
    if (c.kind === 'added') addedSet.add(c.id)
  }
  const wrapper = (n) => !!n && n.role === 'generic' && !n.testid && !n.interactive &&
    !n.state && !n.text && !n.nameFp && !n.sourceType
  let foldedWrappers = 0
  for (const c of changes) {
    if (c.kind !== 'added') continue
    const a = after.nodes.get(c.id)
    if (wrapper(a) && addedSet.has(a.parentId)) { c.folded = true; foldedWrappers++ }
  }

  return {
    changed: changes.length > 0,
    changes,
    actionabilityDelta: { becameCovered, becameVisible },
    idMap,
    // Every change is positional AND nothing gained/lost clickability: the scope
    // reflowed (scrollbar, container resize) with no semantic or actionability effect.
    // Occlusion is not hashed, so a geometry-only move CAN cover a control — the
    // actionability delta must be empty before this flag invites skimming past.
    geometryOnly: changes.length > 0 &&
      changes.every((c) => c.kind === 'moved' || c.kind === 'resized') &&
      becameCovered.length === 0 && becameVisible.length === 0,
    foldedWrappers,
  }
}
