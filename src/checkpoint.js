import { hash } from './hash.js'
/**
 * Compact, versioned, serializable checkpoint (§7). No image. No serialized DOM.
 * With excludeText, no raw text either — matching then rides fingerprint hashes,
 * so the checkpoint is safe to store.
 *
 * Compactness is a requirement, not a nicety (§7 targets an order of magnitude BELOW
 * the page's serialized DOM), so the wire format is deliberately terse:
 *   - single-char keys, omitted when falsy;
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

/**
 * @param {{nodes: Map<string,object>, rootId: string, rootHash: string}} snapshot
 * @param {{excludeText?: boolean}} [opts]
 */
export function makeCheckpoint(snapshot, opts = {}) {
  const excludeText = !!opts.excludeText
  const nodes = {}
  for (const [id, n] of snapshot.nodes) {
    const c = { g: n.tag, r: n.role, o: n.ordinal, h: H(n.subtreeHash) }
    if (n.parentId) c.P = n.parentId
    if (n.textHash) c.t = H(n.textHash)
    if (n.rawTextHash && n.rawTextHash !== n.textHash) c.w = H(n.rawTextHash)
    if (n.stateHash) c.s = H(n.stateHash)
    if (n.styleHash) c.y = H(n.styleHash)
    if (n.textFp) c.f = H(n.textFp)
    if (n.rel) c.b = n.rel
    if (n.geometryAnimating) c.A = 1 // geometry frozen (running animation) — see snapshot.js
    if (n.testid) c.d = n.testid
    if (n.interactive) c.i = 1
    if (n.visible === false) c.v = 0
    if (n.covered) c.c = 1
    if (n.state) c.S = n.state // values are masks by construction (snapshot.js)
    if (!excludeText && n.name) c.m = n.name
    // Identity travels as a FINGERPRINT, so excludeText can drop every readable string
    // and matching still works.
    if (n.nameFp) c.M = n.nameFp.slice(0, 8)
    nodes[id] = c
  }
  return {
    version: 1,
    environment: {
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio || 1,
      engine: engine(),
    },
    rootId: snapshot.rootId,
    rootHash: H(snapshot.rootHash),
    nodes,
  }
}

/** Restore the matcher/differ node shape from the terse wire format, re-deriving the
 *  three omitted signals with the SAME formulas snapshot.js uses (semanticPath from the
 *  parent chain, ancestorFp from the parent's path, geometryHash from rel).
 *  Generator so the chunked driver below can slice it: three hash derivations per node
 *  made this the single biggest post-walk monolith (480ms on a 3.5k-node baseline in
 *  the panel's environment). */
function* inflateGen(cp) {
  const nodes = {}
  for (const [id, c] of Object.entries(cp.nodes)) {
    yield
    nodes[id] = {
      id,
      parentId: c.P || null,
      childIds: [],
      tag: c.g, role: c.r, ordinal: c.o,
      subtreeHash: c.h,
      textHash: c.t || '', rawTextHash: c.w || c.t || '', stateHash: c.s || '', styleHash: c.y || '',
      textFp: c.f || '',
      rel: c.b, testid: c.d || null,
      interactive: !!c.i, visible: c.v !== 0, covered: !!c.c,
      state: c.S || null, name: c.m || '',
      nameFp: c.M || '',
      geometryAnimating: !!c.A,
    }
  }
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
