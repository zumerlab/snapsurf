/**
 * The semantic visitor (§8): ONE walk over the live, computed DOM — post-style,
 * post-layout, post-stacking. Produces identity signals, the three per-node hashes
 * (§1), occlusion, and the node table every other module consumes. Never reads the
 * clone, the SVG, or the raster.
 * @module agent/snapshot
 */
import { hash } from './hash.js'
import { computeRole, computeName, visibleText, NAME_FROM_CONTENT_ROLES } from './aria.js'
import { normalizeText, isIgnored, collectAnimatedProps } from './noise.js'

/** §3 initial visualStyleSubset — explicitly empirical; adjust only with corpus
 *  evidence + ADR. outline/box-shadow deliberately absent (focus-ring noise). */
export const VISUAL_STYLE_SUBSET = [
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'border', 'transform', 'z-index',
]

/** Properties whose animation moves/resizes the box — geometry is frozen while any of
 *  these animates (see the geometryHash call site). */
const GEOMETRY_ANIMATION_PROPS = [
  'transform', 'translate', 'rotate', 'scale', 'width', 'height', 'top', 'left',
  'right', 'bottom', 'margin', 'margin-top', 'margin-left', 'padding', 'inset',
  'font-size', 'offset-distance',
]

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE'])
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option',
])
const SENSITIVE_AC = new Set(['current-password', 'new-password', 'one-time-code'])

function isSensitiveInput(el) {
  if (el.tagName !== 'INPUT') return false
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  if (type === 'password' || type === 'email' || type === 'tel') return true
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
  if (!ac) return false
  for (const t of ac.split(/\s+/)) if (SENSITIVE_AC.has(t) || t.startsWith('cc-')) return true
  return false
}

/** Composed-tree children: shadow roots replace light children; slots expand. */
function composedChildren(el) {
  if (el.shadowRoot) return Array.from(el.shadowRoot.children)
  if (el.localName === 'slot') {
    const assigned = el.assignedElements ? el.assignedElements({ flatten: true }) : []
    if (assigned.length) return assigned
  }
  return Array.from(el.children)
}

/** Nearest positioned OR scrolling ancestor — the geometry reference frame.
 *  Coordinates are taken relative to it PLUS its scroll offsets, so a scroll of the
 *  container moves nothing (scroll-only ⇒ empty diff) while a genuinely moved
 *  element still reports `moved`. */
function geometryFrame(el, root) {
  let p = el.parentElement
  while (p && p !== root) {
    const cs = getComputedStyle(p)
    if (cs.position !== 'static') return p
    if ((cs.overflowY !== 'visible' || cs.overflowX !== 'visible') &&
        (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p
    p = p.parentElement
  }
  return root
}

function relativeBBox(el, root, tolerance) {
  const r = el.getBoundingClientRect()
  const frame = geometryFrame(el, root)
  const fr = frame.getBoundingClientRect()
  const q = tolerance > 0 ? (v) => Math.round(v / tolerance) * tolerance : (v) => Math.round(v * 100) / 100
  return {
    frameIsRoot: frame === root,
    x: q(r.left - fr.left + (frame.scrollLeft || 0)),
    y: q(r.top - fr.top + (frame.scrollTop || 0)),
    w: q(r.width),
    h: q(r.height),
    viewport: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  }
}

function interactionState(el) {
  const s = {}
  try {
    if (el.matches(':disabled')) s.disabled = true
    if (el.matches(':checked')) s.checked = true
    else if (el.type === 'checkbox' || el.type === 'radio') s.checked = false
  } catch { }
  const bools = [['aria-expanded', 'expanded'], ['aria-pressed', 'pressed'], ['aria-selected', 'selected']]
  for (const [attr, key] of bools) {
    const v = el.getAttribute(attr)
    if (v === 'true') s[key] = true
    else if (v === 'false') s[key] = false
  }
  if (el.localName === 'details') s.open = el.hasAttribute('open')
  let valueHash = ''
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.value) {
    // The HASH sees the raw value (so real edits are detected even at equal length);
    // the state OBJECT only ever carries a mask — checkpoints stay safe to store.
    valueHash = hash('v', el.value)
    if (!isSensitiveInput(el)) s.value = '•'.repeat(Math.min(String(el.value).length, 12))
    s.hasValue = true
  }
  return { state: Object.keys(s).length ? s : null, valueHash }
}

function styleSubset(el, cs, animatedProps) {
  const skip = animatedProps
  const parts = []
  for (const prop of VISUAL_STYLE_SUBSET) {
    if (skip && (skip.has('*') || skip.has(prop))) continue
    parts.push(prop + ':' + cs.getPropertyValue(prop))
  }
  return parts.join(';')
}

/**
 * The element that would receive a click aimed at `el`'s centre, when that is something
 * other than `el` itself — i.e. the occluder. Returning the element rather than a boolean
 * is what lets the report say *what* is in the way: an agent told only that a button is
 * covered has to clear every candidate overlay, which costs it an action per candidate.
 * @returns {Element|null}
 */
function occluderAt(el, rect) {
  const cx = rect[0] + rect[2] / 2
  const cy = rect[1] + rect[3] / 2
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null
  try {
    const doc = el.ownerDocument
    const top = (el.getRootNode()?.elementFromPoint || doc.elementFromPoint).call(el.getRootNode?.() || doc, cx, cy)
    if (!top) return null
    return (top === el || el.contains(top) || top.contains(el)) ? null : top
  } catch { return null }
}

/**
 * Walk the live DOM under `root` producing the snapshot node table.
 * Synchronous end-to-end — that is what makes the same-instant guarantee (§8) hold
 * when a render visitor rides the same task.
 *
 * @param {Element} root
 * @param {Required<import('./noise.js').NoiseRules>} noise
 * @returns {{ nodes: Map<string, object>, order: string[], rootId: string,
 *             byElement: Map<Element, string>, elements: Map<string, Element>, rootHash: string }}
 */
export function takeSnapshot(root, noise) {
  const animated = noise.ignoreAnimations ? collectAnimatedProps(root) : new Map()
  const nodes = new Map()
  const order = []
  const byElement = new Map()
  const elements = new Map()
  // node id → occluding Element, resolved to a node reference once the walk has seen it.
  const occluders = new Map()
  let seq = 0

  /** @returns {string|null} node id */
  function visit(el, parentId, semanticPath, ordinalKeyCounts, depth) {
    if (el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) return null
    if (isIgnored(el, noise)) return null
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return null

    const id = 'n_' + (++seq).toString(36)
    const tag = el.localName
    const role = computeRole(el)
    const { name, explicit: nameExplicit } = computeName(el)
    // Identity may only trust the name when it's authored, or when the role takes its
    // name from content per ARIA. A content-derived name on a generic container is
    // unstable: move the content and two wrappers would swap identities.
    const nameForIdentity = (nameExplicit || NAME_FROM_CONTENT_ROLES.has(role)) ? name : ''
    // Identity compares a FINGERPRINT, never the text: an excludeText checkpoint can then
    // omit every human-readable string and still match.
    const nameFp = nameForIdentity ? hash('nm', nameForIdentity) : ''
    const testid = el.getAttribute('data-testid') || null
    const ordKey = tag + '|' + role
    const ordinal = (ordinalKeyCounts[ordKey] = (ordinalKeyCounts[ordKey] || 0) + 1)
    const path = semanticPath + '/' + tag + (role !== 'generic' ? `[${role}]` : '')

    const bbox = relativeBBox(el, root, noise.geometryTolerance)
    const visible = cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 &&
      bbox.viewport[2] > 0 && bbox.viewport[3] > 0
    const interactive = INTERACTIVE_ROLES.has(role) ||
      el.hasAttribute('onclick') || el.tabIndex >= 0
    const occluder = interactive && visible ? occluderAt(el, bbox.viewport) : null
    const covered = !!occluder
    if (occluder) occluders.set(id, occluder)

    // Own text only — subtree text belongs to the children (Merkle locality).
    let ownText = ''
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) ownText += c.nodeValue
    }
    const normText = normalizeText(ownText, el, noise)
    const { state, valueHash } = interactionState(el)

    const isCanvas = tag === 'canvas'
    const isBlockedIframe = tag === 'iframe' && (() => { try { return !el.contentDocument } catch { return true } })()

    // §1 — the three hashes. Identity core inside contentHash is tag+role+testid only:
    // accessibleName can derive from SUBTREE text, and letting it in would produce two
    // changes for one text edit (the text node's and every named ancestor's).
    const textHash = hash('t', normText)
    const stateHash = hash('s', JSON.stringify(state), valueHash)
    const sHash = hash('y', styleSubset(el, cs, animated.get(el)))
    const contentHash = hash('c', tag, role, testid || '', textHash, stateHash, sHash)
    // A running animation on a layout/transform property moves the box every frame.
    // §5 demands zero-config suppression, so the geometry signature is FROZEN while
    // such an animation runs — the element reports neither style nor moved noise.
    // (Its content/state still sign normally: a real change during an animation is
    // still a real change.)
    const animProps = animated.get(el)
    const geometryAnimating = !!animProps && (animProps.has('*') ||
      GEOMETRY_ANIMATION_PROPS.some((p) => animProps.has(p)))
    const geometryHash = geometryAnimating
      ? hash('g', 'animating')
      : hash('g', bbox.x, bbox.y, bbox.w, bbox.h)

    const node = {
      id, parentId, tag, role, name, nameForIdentity, nameFp, testid, ordinal,
      semanticPath: path,
      spHash: hash('p', path),
      textFp: normText ? hash('f', normText.slice(0, 200)) : '',
      text: normText,
      bbox: bbox.viewport,
      rel: [bbox.x, bbox.y, bbox.w, bbox.h],
      visible, covered, interactive,
      state,
      textHash, stateHash, styleHash: sHash, contentHash, geometryHash,
      subtreeHash: '', // filled after children
      geometryAnimating,
      childIds: [],
    }
    if (isCanvas) {
      node.sourceType = 'canvas'
      node.semanticsAvailable = false
      node.rasterAvailable = true
      if (role === 'generic') node.role = 'img'
    }
    if (isBlockedIframe) {
      node.sourceType = 'iframe'
      node.semanticsAvailable = false
      node.rasterAvailable = false
    }

    nodes.set(id, node)
    order.push(id)
    byElement.set(el, id)
    elements.set(id, el)

    const childCounts = {}
    const childHashes = []
    for (const child of composedChildren(el)) {
      const cid = visit(child, id, path, childCounts, depth + 1)
      if (cid) {
        node.childIds.push(cid)
        childHashes.push(nodes.get(cid).subtreeHash)
      }
    }
    // Merkle: paint order ≈ document order here (deterministic; z-reordering shows up
    // as style change via z-index, not as a tree reorder).
    node.subtreeHash = hash('m', contentHash, childHashes.join('|'))
    // ancestorFp last (cheap): identity tiebreaker derived from the semantic path.
    node.ancestorFp = hash('a', semanticPath)
    return id
  }

  const rootId = visit(root, null, '', {}, 0)
  // Occluders are resolved only now, after every element has been walked and AFTER all
  // hashes are computed: `coveredBy` describes another node, so letting it into a
  // signature would propagate that node's geometry into this one's identity (§1).
  for (const [id, el] of occluders) {
    let hit = el
    let hitId = byElement.get(el)
    while (!hitId && hit.parentElement) { hit = hit.parentElement; hitId = byElement.get(hit) }
    const n = hitId ? nodes.get(hitId) : null
    // The occluding element's full text is the label an agent can act on ("the bar that
    // says Usamos cookies…"); a bare overlay div has no role and no accessible name.
    const label = visibleText(el).replace(/\s+/g, ' ').trim().slice(0, 60)
    const name = n && n.name ? n.name : ''
    nodes.get(id).coveredBy = {
      ...(hitId ? { id: hitId } : {}),
      role: n ? n.role : computeRole(el),
      ...(name ? { name } : {}),
      ...(label && label !== name ? { label } : {}),
    }
  }
  return { nodes, order, rootId, byElement, elements, rootHash: rootId ? nodes.get(rootId).subtreeHash : hash('empty') }
}
