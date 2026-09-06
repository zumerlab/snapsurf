/**
 * Probabilistic identity matching (§2). Signals, strongest first: data-testid →
 * role+accessibleName (unique) → tag+semanticPath+ordinal → textFingerprint →
 * ancestorFingerprint → relative geometry (tiebreak only).
 *
 * Internal scores are numeric; the public surface exposes ONLY classes:
 * exact | strong | ambiguous | new (after-side) / removed (before-side).
 * Candidates are bucketed by role+tag before scoring — never unpruned O(n²).
 * @module agent/match
 */

/** Hash equality that tolerates the checkpoint's 8-char truncation (§checkpoint.js):
 *  a stored checkpoint and a fresh snapshot must compare identically. */
export function sameHash(a, b) {
  if (!a || !b) return a === b || (!a && !b)
  const n = Math.min(a.length, b.length)
  return a.slice(0, n) === b.slice(0, n)
}

const W = {
  testid: 100, roleName: 40, pathOrdinal: 25,
  pathOrdinalContradicted: 8, // same slot but different text — weaker than a text match
  textFp: 20, ancestorFp: 10, geometry: 5,
}
const STRONG_MIN = 45
const AMBIG_MIN = 22
const RUNNERUP_GAP = 10

function bucketKey(n) { return n.role + '|' + n.tag }

function geomClose(a, b) {
  if (!a.rel || !b.rel) return false
  return Math.abs(a.rel[0] - b.rel[0]) <= 8 && Math.abs(a.rel[1] - b.rel[1]) <= 8
}

/** Score one candidate pair; returns {score, matchedBy}. */
function score(b, a, nameUnique) {
  let s = 0
  const by = []
  if (b.testid && a.testid && b.testid === a.testid) { s += W.testid; by.push('data-testid') }
  if (b.role === a.role && b.nameFp && sameHash(b.nameFp, a.nameFp)) {
    s += nameUnique ? W.roleName : W.roleName / 2
    by.push('role+name')
  }
  // §2 orders path+ordinal ABOVE textFingerprint, but Phase-2 acceptance also demands
  // "ids follow content, not position" (reordered lists). Both hold if position only
  // carries full weight when text does not CONTRADICT it: when the texts disagree, a
  // same-position candidate is demoted below a same-text candidate elsewhere.
  const textsAgree = b.textFp === a.textFp || (!b.textFp && !a.textFp) ||
    (!!b.textFp && sameHash(b.textFp, a.textFp))
  if (sameHash(b.spHash, a.spHash) && b.ordinal === a.ordinal) {
    s += textsAgree ? W.pathOrdinal : W.pathOrdinalContradicted
    by.push('semanticPath+ordinal')
  }
  if (b.textFp && sameHash(b.textFp, a.textFp)) { s += W.textFp; by.push('textFingerprint') }
  if (sameHash(b.ancestorFp, a.ancestorFp)) { s += W.ancestorFp; by.push('ancestorFingerprint') }
  if (geomClose(b, a)) { s += W.geometry; by.push('geometry') }
  return { score: s, matchedBy: by }
}

function classify(best, runnerUp) {
  if (!best) return null
  const { score: s, matchedBy } = best
  if (matchedBy.includes('data-testid')) return 'exact'
  if (runnerUp && runnerUp.score >= AMBIG_MIN && s - runnerUp.score < RUNNERUP_GAP) return 'ambiguous'
  if (matchedBy.includes('role+name') && (matchedBy.includes('semanticPath+ordinal') || matchedBy.includes('textFingerprint'))) return 'exact'
  if (s >= STRONG_MIN && matchedBy.length >= 2) return 'strong'
  if (s >= AMBIG_MIN) return 'ambiguous'
  return null
}

/** Greedy best-first matching inside one role+tag bucket. */
function matchBucket(befores, afters, out) {
  if (!befores.length || !afters.length) return
  const nameCounts = new Map()
  const idName = (n) => n.nameFp || ''
  for (const n of [...befores, ...afters]) {
    const nm = idName(n)
    if (nm) nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1)
  }
  const pairs = []
  for (const b of befores) {
    for (const a of afters) {
      const nameUnique = idName(b) ? nameCounts.get(idName(b)) === 2 : false
      const r = score(b, a, nameUnique)
      if (r.score >= AMBIG_MIN) pairs.push({ b, a, ...r })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  const usedB = new Set(), usedA = new Set()
  for (const p of pairs) {
    if (usedB.has(p.b.id) || usedA.has(p.a.id)) continue
    const runnerUp = pairs.find((q) => q !== p && (q.b === p.b || q.a === p.a) &&
      !usedB.has(q.b.id) && !usedA.has(q.a.id))
    const cls = classify(p, runnerUp)
    if (!cls) continue
    usedB.add(p.b.id)
    usedA.add(p.a.id)
    out.set(p.a.id, { beforeId: p.b.id, match: cls, matchedBy: p.matchedBy })
  }
}

/**
 * Match a before node-table against an after node-table, tree-guided with Merkle
 * short-circuit, then a global pass for cross-tree moves (portals).
 *
 * @param {{nodes: Map<string,object>|Object, rootId: string}} before
 * @param {{nodes: Map<string,object>, rootId: string}} after
 * @returns {{ matches: Map<string, {beforeId: string, match: string, matchedBy: string[]}>,
 *             removedIds: string[], addedIds: string[],
 *             replacements: Array<{beforeId: string, afterId: string}> }}
 */
export function matchSnapshots(before, after) {
  const bGet = (id) => (before.nodes instanceof Map ? before.nodes.get(id) : before.nodes[id])
  const aGet = (id) => after.nodes.get(id)
  const matches = new Map()
  const bMatched = new Set()
  const poolB = []
  const poolA = []

  function matchWholeSubtree(bId, aId) {
    const b = bGet(bId), a = aGet(aId)
    matches.set(aId, matches.get(aId) || { beforeId: bId, match: 'exact', matchedBy: ['subtree'] })
    bMatched.add(bId)
    const bc = b.childIds || [], ac = a.childIds || []
    for (let i = 0; i < Math.min(bc.length, ac.length); i++) matchWholeSubtree(bc[i], ac[i])
  }

  function recurse(bId, aId, cls, matchedBy) {
    const b = bGet(bId), a = aGet(aId)
    matches.set(aId, { beforeId: bId, match: cls, matchedBy })
    bMatched.add(bId)
    if (b.subtreeHash && sameHash(b.subtreeHash, a.subtreeHash)) {
      // Merkle short-circuit: identical subtrees pair positionally, no scoring.
      const bc = b.childIds || [], ac = a.childIds || []
      for (let i = 0; i < Math.min(bc.length, ac.length); i++) matchWholeSubtree(bc[i], ac[i])
      return
    }
    const bKids = (b.childIds || []).map(bGet)
    const aKids = (a.childIds || []).map(aGet)
    const buckets = new Map()
    for (const k of bKids) {
      const key = bucketKey(k)
      let e = buckets.get(key)
      if (!e) buckets.set(key, (e = { b: [], a: [] }))
      e.b.push(k)
    }
    for (const k of aKids) {
      const key = bucketKey(k)
      let e = buckets.get(key)
      if (!e) buckets.set(key, (e = { b: [], a: [] }))
      e.a.push(k)
    }
    const local = new Map()
    for (const e of buckets.values()) matchBucket(e.b, e.a, local)
    for (const [aId2, m] of local) {
      recurse(m.beforeId, aId2, m.match, m.matchedBy)
    }
    for (const k of bKids) if (!bMatched.has(k.id)) poolB.push(k)
    for (const k of aKids) if (!local.has(k.id)) poolA.push(k)
  }

  if (before.rootId && after.rootId) {
    recurse(before.rootId, after.rootId, 'exact', ['capture-root'])
  }

  // Global cross-tree pass: nodes that moved between parents (portals, reparenting).
  const globalBuckets = new Map()
  for (const k of poolB) {
    if (bMatched.has(k.id)) continue
    const key = bucketKey(k)
    let e = globalBuckets.get(key)
    if (!e) globalBuckets.set(key, (e = { b: [], a: [] }))
    e.b.push(k)
  }
  for (const k of poolA) {
    if (matches.has(k.id)) continue
    const key = bucketKey(k)
    let e = globalBuckets.get(key)
    if (!e) globalBuckets.set(key, (e = { b: [], a: [] }))
    e.a.push(k)
  }
  const globalMatches = new Map()
  for (const e of globalBuckets.values()) matchBucket(e.b, e.a, globalMatches)
  for (const [aId2, m] of globalMatches) {
    matches.set(aId2, m)
    bMatched.add(m.beforeId)
    // Their descendants remain in pools and resolve on their own signals.
    const b = bGet(m.beforeId), a = aGet(aId2)
    if (b.subtreeHash && sameHash(b.subtreeHash, a.subtreeHash)) matchWholeSubtree(m.beforeId, aId2)
  }

  const allBefore = before.nodes instanceof Map ? [...before.nodes.keys()] : Object.keys(before.nodes)
  const removedIds = allBefore.filter((id) => !bMatched.has(id))
  const addedIds = [...after.nodes.keys()].filter((id) => !matches.has(id))

  // Ambiguous replacements: a removed and an added sharing tag+role+path+ordinal.
  const replacements = []
  const remByKey = new Map()
  for (const id of removedIds) {
    const n = bGet(id)
    remByKey.set(n.tag + '|' + n.role + '|' + n.spHash.slice(0, 8) + '|' + n.ordinal, id)
  }
  for (const id of addedIds) {
    const n = aGet(id)
    const key = n.tag + '|' + n.role + '|' + n.spHash.slice(0, 8) + '|' + n.ordinal
    const hit = remByKey.get(key)
    if (hit) {
      replacements.push({ beforeId: hit, afterId: id })
      remByKey.delete(key)
    }
  }
  return { matches, removedIds, addedIds, replacements }
}
