import { hash } from './hash.js'
/**
 * Compact, versioned, serializable checkpoint (§7). No image. No serialized DOM.
 * With excludeText, no raw text either — matching then rides fingerprint hashes,
 * so the checkpoint is safe to store.
 *
 * Compactness is a requirement, not a nicety. Comparing checkpoint bytes to DOM bytes
 * is not a universal ratio (an empty element has almost no HTML but still needs an id,
 * hashes and geometry), so the enforceable budget is PER SEMANTIC NODE. The wire format
 * is deliberately terse:
 *   - positional rows with a presence/flags bitset instead of per-node object keys;
 *   - parent row indexes instead of repeated parent ids;
 *   - interned tag, role and style-hash tables;
 *   - canonical empty text/state hashes omitted and restored on load;
 *   - hashes truncated to 8 hex chars (32 bits) — this is a same-page change oracle,
 *     not a security digest: a collision means one missed change on one node, and the
 *     Merkle parent plus the sibling signals still move;
 *   - parent links only (children are rebuilt on load);
 *   - geometry as a 4-number array;
 *   - contentHash NOT stored: the differ gates on its COMPONENTS (text/state/style),
 *     which is what it needs for the kind taxonomy anyway;
 *   - spHash / ancestorFp / geometryHash NOT stored either: all three are DERIVED at
 *     inflate time from data that is stored (the parent chain of tag/role, and rel).
 * `inflateCheckpoint()` restores the shape the matcher/differ expect.
 * @module agent/checkpoint
 */
const engine = () => {
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrom(e|ium)\//.test(ua)) return 'chromium'
  if (/Safari\//.test(ua)) return 'webkit'
  return 'unknown'
}

const H = (h) => (h ? h.slice(0, 8) : '')

// snapshot.js always hashes these components, including when there is no authored
// text or interaction state. Persisting the same 8-byte digest on almost every node
// was pure wire overhead; derive it from the checkpoint version instead.
const EMPTY_TEXT_HASH = H(hash('t', '', ''))
const EMPTY_STATE_HASH = H(hash('s', JSON.stringify(null), ''))

// Compact row: [id, parentRow, tagRef, roleRef, ordinal, subtreeHash, styleRef,
//               rel, presenceAndFlags, ...present optional values]
// Optional values are appended in this bit order. The four high bits are flags and
// consume no value. Keeping this table here makes v2's wire contract auditable.
const TEXT = 1 << 0
const RAW_TEXT = 1 << 1
const STATE_HASH = 1 << 2
const TEXT_FP = 1 << 3
const NAME_FP = 1 << 4
const TESTID = 1 << 5
const STATE = 1 << 6
const NAME = 1 << 7
const INTERACTIVE = 1 << 8
const HIDDEN = 1 << 9
const COVERED = 1 << 10
const ANIMATING = 1 << 11

function intern(value, values, indexes) {
  let i = indexes.get(value)
  if (i !== undefined) return i
  i = values.length
  values.push(value)
  indexes.set(value, i)
  return i
}

/**
 * @param {{nodes: Map<string,object>, rootId: string, rootHash: string}} snapshot
 * @param {{excludeText?: boolean}} [opts]
 */
export function makeCheckpoint(snapshot, opts = {}) {
  const excludeText = !!opts.excludeText
  const tags = [], roles = [], styles = []
  const tagIndexes = new Map(), roleIndexes = new Map(), styleIndexes = new Map()
  const ids = [...snapshot.nodes.keys()]
  const rowById = new Map(ids.map((id, i) => [id, i]))
  const nodes = []
  for (const [id, n] of snapshot.nodes) {
    const textHash = H(n.textHash)
    const rawTextHash = H(n.rawTextHash)
    const stateHash = H(n.stateHash)
    let bits = 0
    const optional = []
    const add = (bit, value) => { bits |= bit; optional.push(value) }

    if (textHash && textHash !== EMPTY_TEXT_HASH) add(TEXT, textHash)
    if (rawTextHash && rawTextHash !== textHash) add(RAW_TEXT, rawTextHash)
    if (stateHash && stateHash !== EMPTY_STATE_HASH) add(STATE_HASH, stateHash)
    if (n.textFp) add(TEXT_FP, H(n.textFp))
    // Identity travels as a FINGERPRINT, so excludeText can drop every readable string
    // and matching still works.
    if (n.nameFp) add(NAME_FP, H(n.nameFp))
    if (n.testid) add(TESTID, n.testid)
    if (n.state) add(STATE, n.state) // values are masks by construction (snapshot.js)
    if (!excludeText && n.name) add(NAME, n.name)
    if (n.interactive) bits |= INTERACTIVE
    if (n.visible === false) bits |= HIDDEN
    if (n.covered) bits |= COVERED
    if (n.geometryAnimating) bits |= ANIMATING

    nodes.push([
      id,
      n.parentId ? rowById.get(n.parentId) : -1,
      intern(n.tag, tags, tagIndexes),
      // Generic is overwhelmingly common and needs neither a table entry nor bytes.
      n.role === 'generic' ? -1 : intern(n.role, roles, roleIndexes),
      n.ordinal,
      H(n.subtreeHash),
      intern(H(n.styleHash), styles, styleIndexes),
      n.rel || null,
      bits,
      ...optional,
    ])
  }
  return {
    // v2 uses length-framed hashes. A v1 digest cannot be upgraded without the raw
    // strings it intentionally omitted, so accepting one would manufacture changes.
    version: 2,
    environment: {
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio || 1,
      engine: engine(),
    },
    rootId: snapshot.rootId,
    rootHash: H(snapshot.rootHash),
    // Tables correspond to tag, non-generic role and styleHash, respectively.
    tables: [tags, roles, styles],
    nodes,
  }
}

function* decodeCompactNodes(cp) {
  const [tags = [], roles = [], styles = []] = cp.tables || []
  const nodes = {}
  const ids = cp.nodes.map((row) => row[0])
  for (const row of cp.nodes) {
    if (!Array.isArray(row) || row.length < 9) {
      throw new Error('[agent.checkpoint] invalid v2 node row')
    }
    const [id, parentRow, tagRef, roleRef, ordinal, subtreeHash, styleRef, rel, bits] = row
    if (typeof id !== 'string' || !Number.isInteger(parentRow) ||
        !Number.isInteger(tagRef) || !Number.isInteger(roleRef) ||
        !Number.isInteger(ordinal) || typeof subtreeHash !== 'string' ||
        !Number.isInteger(styleRef) || !Number.isInteger(bits) ||
        tagRef < 0 || tagRef >= tags.length || styleRef < 0 || styleRef >= styles.length ||
        roleRef < -1 || roleRef >= roles.length || parentRow >= ids.length || parentRow < -1) {
      throw new Error('[agent.checkpoint] invalid v2 node row')
    }
    let i = 9
    const take = (bit, fallback = '') => (bits & bit ? row[i++] : fallback)
    const textHash = take(TEXT, EMPTY_TEXT_HASH)
    const rawTextHash = take(RAW_TEXT, textHash)
    const stateHash = take(STATE_HASH, EMPTY_STATE_HASH)
    const textFp = take(TEXT_FP)
    const nameFp = take(NAME_FP)
    const testid = take(TESTID, null)
    const state = take(STATE, null)
    const name = take(NAME)
    if (i !== row.length) throw new Error('[agent.checkpoint] invalid v2 node row')
    nodes[id] = {
      id,
      parentId: parentRow < 0 ? null : ids[parentRow],
      childIds: [],
      tag: tags[tagRef], role: roleRef < 0 ? 'generic' : roles[roleRef], ordinal,
      subtreeHash,
      textHash, rawTextHash, stateHash, styleHash: styles[styleRef] || '',
      textFp,
      rel: rel || undefined, testid,
      interactive: !!(bits & INTERACTIVE), visible: !(bits & HIDDEN), covered: !!(bits & COVERED),
      state, name, nameFp,
      geometryAnimating: !!(bits & ANIMATING),
    }
    yield
  }
  return nodes
}

// Transitional decoder for object-shaped v2 checkpoints produced while the framed-hash
// change and this codec were being developed concurrently. It costs nothing on the new
// wire and prevents an in-memory baseline captured by an older bundle from exploding.
function* decodeObjectNodes(cp) {
  const nodes = {}
  for (const [id, c] of Object.entries(cp.nodes)) {
    nodes[id] = {
      id,
      parentId: c.P || null,
      childIds: [],
      tag: c.g, role: c.r, ordinal: c.o,
      subtreeHash: c.h,
      textHash: c.t || EMPTY_TEXT_HASH,
      rawTextHash: c.w || c.t || EMPTY_TEXT_HASH,
      stateHash: c.s || EMPTY_STATE_HASH,
      styleHash: c.y || '',
      textFp: c.f || '',
      rel: c.b, testid: c.d || null,
      interactive: !!c.i, visible: c.v !== 0, covered: !!c.c,
      state: c.S || null, name: c.m || '',
      nameFp: c.M || '',
      geometryAnimating: !!c.A,
    }
    yield
  }
  return nodes
}

/** Restore the matcher/differ node shape from the terse wire format, re-deriving the
 *  three omitted signals with the SAME formulas snapshot.js uses (semanticPath from the
 *  parent chain, ancestorFp from the parent's path, geometryHash from rel).
 *  Generator so the chunked driver below can slice it: three hash derivations per node
 *  made this the single biggest post-walk monolith (480ms on a 3.5k-node baseline in
 *  the panel's environment). */
function* inflateGen(cp) {
  if (!cp || cp.version !== 2) {
    throw new Error(`[agent.checkpoint] unsupported checkpoint version ${cp?.version ?? 'missing'}; capture a fresh v2 baseline`)
  }
  if (!cp.nodes || (Array.isArray(cp.nodes) && !Array.isArray(cp.tables))) {
    throw new Error('[agent.checkpoint] invalid v2 checkpoint')
  }
  const nodes = yield* (Array.isArray(cp.nodes) ? decodeCompactNodes(cp) : decodeObjectNodes(cp))
  for (const n of Object.values(nodes)) {
    if (n.parentId && nodes[n.parentId]) nodes[n.parentId].childIds.push(n.id)
  }
  const paths = new Map()
  const derive = (n) => {
    if (paths.has(n.id)) return paths.get(n.id)
    const parentPath = n.parentId && nodes[n.parentId] ? derive(nodes[n.parentId]) : ''
    const path = parentPath + '/' + n.tag + (n.role !== 'generic' ? `[${n.role}]` : '')
    paths.set(n.id, path)
    n.spHash = hash('p', path).slice(0, 8)
    n.ancestorFp = hash('a', parentPath).slice(0, 8)
    n.geometryHash = (n.geometryAnimating
      ? hash('g', 'animating')
      : (n.rel ? hash('g', n.rel[0], n.rel[1], n.rel[2], n.rel[3]) : '')).slice(0, 8)
    return path
  }
  for (const n of Object.values(nodes)) {
    yield
    derive(n)
  }
  return { ...cp, nodes, __inflated: true }
}

export function inflateCheckpoint(cp) {
  const gen = inflateGen(cp)
  let r = gen.next()
  while (!r.done) r = gen.next()
  return r.value
}

/** Sliced inflate: `pause` is a makeSlicer() pause fn (snapshot.js). */
export async function inflateCheckpointChunked(cp, pause) {
  const gen = inflateGen(cp)
  let r = gen.next()
  while (!r.done) {
    const p = pause()
    if (p) await p
    r = gen.next()
  }
  return r.value
}
