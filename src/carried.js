/**
 * Carried identity across navigations (§cross-page continuity).
 *
 * A navigation resets the observation protocol by design: two different pages produce
 * a useless "everything changed" diff. What an agent actually needs across that boundary
 * is narrower and answerable: of the elements whose identity is STRONG enough to survive
 * a page change — an authored `data-testid`, or an authored accessible name on a role —
 * which ones persisted, and how did their state/content change? (The canonical case: the
 * cart badge going "1" → "2" after navigating to another page of the same site.)
 *
 * Honesty contract:
 * - identity here is weaker than same-document matching: every report says it compared
 *   BY STRONG FINGERPRINTS ONLY and carries `by` per item;
 * - unmatched content is COUNTED, never described and never read as "removed"/"added" —
 *   a different page's content is different, not changed;
 * - ambiguous identities (a key appearing twice on either side) are dropped from
 *   comparison and counted as such, never guessed.
 *
 * Pure data-in/data-out: builds run in the page (over the privacy view, so redaction is
 * already applied); diffs run wherever the caller keeps the baseline (the daemon keeps
 * it in its own process — page realms die with the document, which is exactly why this
 * module exists).
 * @module agent/carried
 */

const DEFAULT_CAP = 200

/**
 * Compact identity slice of one observation. Only nodes with cross-page-strong identity
 * enter: `data-testid`, or `nameFp` (set by the walk ONLY for authored names / ARIA
 * name-from-content roles — a content-derived generic name never carries identity).
 * @param {{nodes: Map}} view privacy view of a snapshot (names/text already redacted)
 * @param {{cap?: number}} [options]
 */
export function carriedIndex(view, options = {}) {
  const cap = options.cap || DEFAULT_CAP
  const seen = new Map()
  const ambiguous = new Set()
  let considered = 0
  for (const node of view.nodes.values()) {
    const keys = []
    if (node.testid) keys.push({ key: `t:${node.testid}`, by: 'data-testid' })
    else if (node.nameFp) keys.push({ key: `n:${node.role}|${node.nameFp}`, by: 'role+authored-name' })
    if (!keys.length) continue
    considered++
    for (const { key, by } of keys) {
      if (ambiguous.has(key)) continue
      if (seen.has(key)) { seen.delete(key); ambiguous.add(key); continue }
      seen.set(key, {
        key,
        by,
        role: node.role,
        name: node.name ? String(node.name).slice(0, 120) : undefined,
        text: node.text ? String(node.text).slice(0, 120) : undefined,
        state: node.state && typeof node.state === 'object' ? { ...node.state } : undefined,
        textHash: node.textHash,
        stateHash: node.stateHash,
        styleHash: node.styleHash,
      })
    }
  }
  const entries = [...seen.values()].slice(0, cap)
  return {
    entries,
    total: seen.size,
    truncated: Math.max(0, seen.size - cap),
    ambiguousDropped: ambiguous.size,
    considered,
  }
}

/**
 * Compare two identity slices from DIFFERENT observations (typically different pages).
 * @param {ReturnType<typeof carriedIndex>} before
 * @param {ReturnType<typeof carriedIndex>} after
 */
export function carriedDiff(before, after) {
  const beforeByKey = new Map(before.entries.map((entry) => [entry.key, entry]))
  const changed = []
  let unchanged = 0
  let matches = 0
  for (const entry of after.entries) {
    const prior = beforeByKey.get(entry.key)
    if (!prior) continue
    beforeByKey.delete(entry.key)
    matches++
    const kinds = []
    if (prior.textHash !== entry.textHash) kinds.push('content')
    if (prior.stateHash !== entry.stateHash) kinds.push('state')
    if (prior.styleHash !== entry.styleHash) kinds.push('style')
    if (!kinds.length) { unchanged++; continue }
    changed.push({
      key: entry.key,
      by: entry.by,
      role: entry.role,
      name: entry.name,
      kinds,
      from: { text: prior.text, state: prior.state },
      to: { text: entry.text, state: entry.state },
    })
  }
  return {
    comparedBy: 'CROSS_PAGE_STRONG_IDENTITY_ONLY',
    matches,
    unchanged,
    changed,
    // Different-page content is DIFFERENT, not "removed"/"added": counted, never listed.
    onlyBefore: before.entries.length - matches,
    onlyAfter: after.entries.length - matches,
    ambiguousDropped: (before.ambiguousDropped || 0) + (after.ambiguousDropped || 0),
    truncated: (before.truncated || 0) + (after.truncated || 0),
  }
}
