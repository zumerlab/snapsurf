/**
 * Change derivation (§3) + actionability delta (§4). The kind comes from WHICH
 * signature component changed; geometry is diffed separately, with tolerance,
 * and NEVER propagates ("the button moved" ≠ "the button changed").
 * @module agent/diff
 */
import { matchSnapshots, sameHash } from './match.js'

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
  const ref = (id, node) => ({ id, role: node.role, name: node.name || undefined, coveredBy: node.coveredBy })

  const inReplacement = new Set()
  for (const r of replacements) {
    inReplacement.add(r.beforeId)
    inReplacement.add(r.afterId)
  }

  for (const [aId, m] of matches) {
    const b = bGet(m.beforeId)
    const a = after.nodes.get(aId)
    idMap.set(aId, m.beforeId) // stable identity: matched nodes keep their previous id

    // Positional-only match with different content: we are NOT confident this is the
    // same node (virtualized recycling, swapped cards). Report the doubt as an
    // ambiguous replacement instead of asserting "its text changed".
    if (m.match === 'ambiguous' && !sameHash(b.textHash, a.textHash) &&
        !m.matchedBy.includes('data-testid') && !m.matchedBy.includes('role+name')) {
      changes.push({
        kind: 'possible-replacement', match: 'ambiguous',
        beforeId: m.beforeId, afterId: aId,
        role: a.role,
        name: a.name || undefined,        // after-side (what is there now)
        beforeName: b.name || undefined,  // before-side (what was there)
      })
      continue
    }
    const kinds = []
    const detail = { id: m.beforeId, match: m.match, matchedBy: m.matchedBy }

    // Gate on the COMPONENTS (a stored checkpoint doesn't carry the composed
    // contentHash — and the components are what the taxonomy needs anyway).
    if (!sameHash(b.textHash, a.textHash)) kinds.push('content')
    if (!sameHash(b.stateHash, a.stateHash)) {
      kinds.push('state')
      detail.before = { ...(b.state || {}) }
      detail.after = { ...(a.state || {}) }
    }
    if (!sameHash(b.styleHash, a.styleHash)) kinds.push('style')
    if (b.tag !== a.tag || b.role !== a.role) kinds.push('content')
    if (!sameHash(b.geometryHash, a.geometryHash) && b.rel && a.rel) {
      if (b.rel[0] !== a.rel[0] || b.rel[1] !== a.rel[1]) kinds.push('moved')
      if (b.rel[2] !== a.rel[2] || b.rel[3] !== a.rel[3]) kinds.push('resized')
    }
    if (kinds.length) {
      for (const kind of kinds) changes.push({ ...detail, kind, role: a.role, name: a.name || undefined })
    }

    const bCov = !!b.covered, aCov = !!a.covered
    const bVis = b.visible !== false, aVis = a.visible !== false
    if ((a.interactive || b.interactive)) {
      if ((!bCov && aCov) || (bVis && !aVis)) becameCovered.push(ref(m.beforeId, a))
      else if ((bCov && !aCov) || (!bVis && aVis)) becameVisible.push(ref(m.beforeId, a))
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
    changes.push({
      kind: 'possible-replacement', match: 'ambiguous',
      beforeId: r.beforeId, afterId: r.afterId,
      role: a.role,
      name: a.name || undefined,
      beforeName: b.name || undefined,
    })
  }

  return {
    changed: changes.length > 0,
    changes,
    actionabilityDelta: { becameCovered, becameVisible },
    idMap,
  }
}
