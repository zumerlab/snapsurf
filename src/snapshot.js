/**
 * The semantic visitor (§8): ONE walk over the live, computed DOM — post-style,
 * post-layout, post-stacking. Produces identity signals, the three per-node hashes
 * (§1), occlusion, and the node table every other module consumes. Never reads the
 * clone, the SVG, or the raster.
 * @module agent/snapshot
 */
import { hash } from './hash.js'
import { attribute } from './capture-redaction.js'
import { computeRole, computeName, visibleText, NAME_FROM_CONTENT_ROLES } from './aria.js'
import { normalizeText, isIgnored, collectAnimatedProps } from './noise.js'
import { isEngineInternalNode } from './engine-ownership.js'

// Raw inputs used to build the node signatures. A WeakMap lets buildUi(observe(...),
// {privacy}) rebuild safe signatures even when privacy was selected after the walk,
// without attaching values to nodes returned through the compatibility snapshot.
const PRIVACY_INPUTS = new WeakMap()
export const getPrivacyInputs = (node) => PRIVACY_INPUTS.get(node)

/** §3 initial visualStyleSubset — explicitly empirical; adjust only with corpus
 *  evidence + ADR. outline/box-shadow deliberately absent (focus-ring noise). */
const VISUAL_STYLE_SUBSET = [
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'background-image', 'font-family', 'font-size', 'font-weight', 'border', 'transform', 'z-index',
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
const SENSITIVE_AC = new Set([
  'username', 'current-password', 'new-password', 'one-time-code', 'email', 'tel',
])

function isSensitiveInput(el) {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') return false
  const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : ''
  if (type === 'password' || type === 'email' || type === 'tel') return true
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
  if (!ac) return false
  for (const t of ac.split(/\s+/)) {
    if (SENSITIVE_AC.has(t) || t.startsWith('tel-') || t.startsWith('cc-')) return true
  }
  return false
}

// A raw-value digest in a persisted checkpoint is an offline guessing oracle, even
// when the digest is truncated. Coarse buckets retain a little useful change signal
// without making a candidate password/email/card number directly verifiable.
function sensitiveValueBucket(value) {
  const length = String(value).length
  if (length <= 4) return '1-4'
  if (length <= 8) return '5-8'
  if (length <= 16) return '9-16'
  if (length <= 32) return '17-32'
  return '33+'
}

const SENSITIVE_VALUE_UNCERTAINTY = Object.freeze({
  sourceType: 'sensitive-input-value',
  scope: 'value-change-detection',
  detection: 'presence-and-coarse-length-bucket',
  uncertainty: 'value edits within one coarse length bucket, including same-length edits, may be missed',
})

/** Composed-tree nodes: shadow roots replace light children; slots expand. Text nodes
 *  matter here too. `ShadowRoot.children`/`assignedElements()` silently dropped direct
 *  text, allowing a visible open-shadow mutation to report `changed:false`. */
function composedNodes(el) {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes)
  if (el.localName === 'slot') {
    const assigned = el.assignedNodes ? el.assignedNodes({ flatten: true }) : []
    if (assigned.length) return assigned
  }
  return Array.from(el.childNodes)
}

const composedChildren = (el) => composedNodes(el).filter((node) => node.nodeType === 1)
const composedOwnText = (el, policy) => composedNodes(el)
  .filter((node) => node.nodeType === 3 && !policy?.isBlocked(node.assignedSlot))
  .map((node) => node.nodeValue || '')
  .join('')

/** Open shadow roots crossed by the same composed walk as the snapshot. MutationObserver
 *  does not cross a shadow boundary when it observes the document/root, so each root must
 *  be registered explicitly for the chunked walk's torn guarantee. */
function collectOpenShadowRoots(root) {
  const roots = new Set()
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const el = stack.pop()
    if (!el || el.nodeType !== 1 || seen.has(el) || isEngineInternalNode(el)) continue
    seen.add(el)
    if (el.shadowRoot) roots.add(el.shadowRoot)
    for (const child of composedChildren(el)) stack.push(child)
  }
  return roots
}

/** Nearest positioned OR scrolling ancestor — the geometry reference frame.
 *  Coordinates are taken relative to it PLUS its scroll offsets, so a scroll of the
 *  container moves nothing (scroll-only ⇒ empty diff) while a genuinely moved
 *  element still reports `moved`.
 *
 *  Resolved per PARENT and memoised, because the answer is a property of the ancestor
 *  chain, not of the node: every child of a given parent shares it. Unmemoised this was
 *  a getComputedStyle per ancestor per node — O(nodes x depth) — and it showed:
 *  relativeBBox cost 10ms at wrap depth 1 and 145ms at depth 30 on the same 640 cards.
 *  The frame's own rect is memoised for the same reason: thousands of nodes usually
 *  resolve to one frame, and each was re-measuring it.
 *
 *  Both caches are cleared at every yield of the chunked walk (see makeWalker), so a
 *  value can never outlive the layout it was measured in. */
function makeGeometry(root, styleCache) {
  const frameOfParent = new Map()
  const frameMetrics = new Map()

  const styleFor = (element) => styleCache?.get?.(element) ||
    element.ownerDocument.defaultView.getComputedStyle(element)

  const isFrame = (p) => {
    const cs = styleFor(p)
    if (cs.position !== 'static') return true
    return (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') &&
      (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)
  }

  // Iterative, not recursive: a pathologically deep document should not risk the stack.
  const frameFor = (parent) => {
    const chain = []
    let p = parent
    let answer = root
    while (p && p !== root) {
      const cached = frameOfParent.get(p)
      if (cached) { answer = cached; break }
      if (isFrame(p)) { answer = p; break }
      chain.push(p)
      p = p.parentElement
    }
    for (const link of chain) frameOfParent.set(link, answer)
    if (p && p !== root && !frameOfParent.has(p)) frameOfParent.set(p, answer)
    return answer
  }

  const metricsOf = (frame) => {
    let m = frameMetrics.get(frame)
    if (!m) {
      const fr = frame.getBoundingClientRect()
      m = { left: fr.left, top: fr.top, sx: frame.scrollLeft || 0, sy: frame.scrollTop || 0 }
      frameMetrics.set(frame, m)
    }
    return m
  }

  return {
    reset() { frameOfParent.clear(); frameMetrics.clear() },
    bbox(el, tolerance) {
      const r = el.getBoundingClientRect()
      const frame = frameFor(el.parentElement)
      const m = metricsOf(frame)
      const q = tolerance > 0 ? (v) => Math.round(v / tolerance) * tolerance : (v) => Math.round(v * 100) / 100
      return {
        frameIsRoot: frame === root,
        x: q(r.left - m.left + m.sx),
        y: q(r.top - m.top + m.sy),
        w: q(r.width),
        h: q(r.height),
        viewport: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      }
    },
  }
}

function interactionState(el, policy) {
  const s = {}
  try {
    if (!policy?.redactsAttribute(el, 'disabled') && el.matches(':disabled')) s.disabled = true
    if (!policy?.redactsAttribute(el, 'checked') && el.matches(':checked')) s.checked = true
    else if (!policy?.redactsAttribute(el, 'checked') && (el.type === 'checkbox' || el.type === 'radio')) s.checked = false
  } catch { }
  const bools = [
    ['aria-expanded', 'expanded'],
    ['aria-pressed', 'pressed'],
    ['aria-selected', 'selected'],
    ['aria-checked', 'checked'],
  ]
  for (const [attr, key] of bools) {
    const v = attribute(el, attr, policy)
    if (v === 'true') s[key] = true
    else if (v === 'false') s[key] = false
  }
  if (el.localName === 'details' && !policy?.redactsAttribute(el, 'open')) s.open = el.hasAttribute('open')
  const selected = policy && el.localName === 'select' ? [...el.selectedOptions] : []
  const fieldRedacted = policy?.isField(el) || policy?.redactsAttribute(el, 'value') ||
    selected.some(option => policy.isBlocked(option) || policy.redactsAttribute(option, 'value'))
  const sensitive = fieldRedacted || isSensitiveInput(el)
  let valueSignal = ''
  const isValueControl = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  let rawValue = isValueControl ? String(el.value || '') : null
  if (selected.length && !fieldRedacted && !selected[0].hasAttribute('value')) {
    rawValue = visibleText(selected[0], Infinity, policy).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '')
  }
  if (isValueControl && rawValue) {
    // Sensitive values must never feed a deterministic checkpoint hash: that turns
    // the checkpoint into an offline password/email/card-number guessing oracle.
    // Presence plus a coarse length bucket still detects empty/fill and larger edits.
    valueSignal = fieldRedacted ? 'redacted-value' : sensitive
      ? `sensitive:${sensitiveValueBucket(rawValue)}`
      : hash('v', rawValue)
    if (!sensitive) s.value = '•'.repeat(Math.min(rawValue.length, 12))
    s.hasValue = true
  }
  return {
    state: Object.keys(s).length ? s : null,
    valueSignal,
    valueChangeUncertainty: fieldRedacted ? {
      sourceType: 'capture-redacted-input-value', scope: 'value-change-detection',
      detection: 'presence-only', uncertainty: 'filled-to-filled edits hidden by captureRedaction are not observed',
    } : sensitive ? SENSITIVE_VALUE_UNCERTAINTY : null,
    // A sensitive value is never needed for semantic output. Do not even retain it in
    // the realm-local privacy sidecar: presence/coarse bucket plus explicit uncertainty
    // are the full supported observation contract for these controls.
    rawValue: sensitive ? null : rawValue,
    sensitive,
  }
}

function styleSubset(el, cs, animatedProps) {
  const skip = animatedProps
  const parts = []
  for (const prop of VISUAL_STYLE_SUBSET) {
    if (skip && (skip.has('*') || skip.has(prop))) continue
    parts.push([prop, cs.getPropertyValue(prop)])
  }
  return { parts, text: parts.map(([prop, value]) => prop + ':' + value).join(';') }
}

/** Authored/readable content that is not represented by own text nodes. These values
 *  alter what an agent can understand or where it will navigate, so they belong in the
 *  content component of the signature. Values are hashed immediately and never exposed
 *  through this field (privacy views still govern the readable name/text surfaces). */
function authoredContentParts(el, name, nameExplicit, policy) {
  const parts = []
  if (nameExplicit) parts.push(['accessible-name', name])
  if (attribute(el, 'href', policy) !== null) parts.push(['href', attribute(el, 'href', policy) || ''])
  if (attribute(el, 'src', policy) !== null) parts.push(['src', attribute(el, 'src', policy) || ''])
  if (el.localName === 'img') {
    if (attribute(el, 'srcset', policy) !== null) parts.push(['srcset', attribute(el, 'srcset', policy) || ''])
    // currentSrc catches responsive-source changes caused by <picture>/media selection;
    // the authored src/srcset above still catches a mutation before the new image loads.
    if (el.currentSrc && !policy?.redactsAttribute(el, 'src') && !policy?.redactsAttribute(el, 'srcset')) parts.push(['current-src', el.currentSrc])
  }
  return parts
}

/** There is no platform API that distinguishes a closed shadow root from no shadow root.
 *  A defined custom element with no open root is therefore an honest uncertainty: it may
 *  render an opaque closed tree. Mark it instead of claiming the walk saw everything. */
function mayHaveClosedShadow(el) {
  if (el.shadowRoot || !el.localName.includes('-')) return false
  try {
    return !!el.ownerDocument?.defaultView?.customElements?.get(el.localName)
  } catch { return false }
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
  const view = el.ownerDocument?.defaultView || globalThis
  if (cx < 0 || cy < 0 || cx > view.innerWidth || cy > view.innerHeight) return null
  try {
    const doc = el.ownerDocument
    const top = (el.getRootNode()?.elementFromPoint || doc.elementFromPoint).call(el.getRootNode?.() || doc, cx, cy)
    if (!top) return null
    if (top === el || el.contains(top) || top.contains(el)) return null
    // A click on an associated label activates the control — a label (or its styled
    // contents) over its own input is a proxy, not an occluder.
    if (el.labels) for (const l of el.labels) if (l === top || l.contains(top)) return null
    return top
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
function makeWalker(root, noise, { strictScope = false, engineFrame, capturePolicy } = {}) {
  const policy = capturePolicy || engineFrame?.capturePolicy
  const styleCache = engineFrame?.styleCache
  const includedElements = engineFrame?.nodeMap instanceof Map
    ? new Set([...engineFrame.nodeMap.values()].filter((node) => node?.nodeType === 1))
    : null
  if (includedElements) includedElements.add(root)
  const styleFor = (element) => styleCache?.get?.(element) ||
    element.ownerDocument.defaultView.getComputedStyle(element)
  const geo = makeGeometry(root, styleCache)
  const animated = noise.ignoreAnimations ? collectAnimatedProps(root) : new Map()
  // one label[for] scan per walk — computeName used to run a full-document
  // querySelector for every element with an id
  const labelFor = strictScope ? null : new Map()
  if (labelFor) {
    try {
      for (const l of (root.ownerDocument || document).querySelectorAll('label[for]')) {
        const f = attribute(l, 'for', policy)
        if (f && !policy?.isBlocked(l) && !labelFor.has(f)) labelFor.set(f, l)
      }
    } catch { /* no doc */ }
  }
  const nodes = new Map()
  const order = []
  const byElement = new Map()
  const elements = new Map()
  // node id → occluding Element, resolved to a node reference once the walk has seen it.
  const occluders = new Map()
  // A slot can render a light-DOM node that is not a DOM descendant of the capture
  // root. The semantic walk may still include it, but a MutationObserver on `root`
  // cannot promise torn detection for that external assigned subtree.
  let externalAssignedNodes = false
  let seq = 0

  /** @returns {string|null} node id */
  const P = typeof window !== 'undefined' && window.__SD_PROF
  const pnow = P ? () => performance.now() : () => 0
  const pacc = (k, t) => { if (P) P[k] = (P[k] || 0) + (performance.now() - t) }
  function* visit(el, parentId, semanticPath, ordinalKeyCounts, depth, frozenGeo) {
    // Renderer-owned helpers (notably the retained image-decode iframe) are not
    // page content. Only the renderer's private provenance can exclude them;
    // data-snapdom-internal and other author-set markers are never authority.
    if (el.nodeType !== 1 || isEngineInternalNode(el) || SKIP_TAGS.has(el.tagName) || policy?.isBlocked(el)) return null
    if (includedElements && !includedElements.has(el)) return null
    if (isIgnored(el, noise)) return null
    if (el.localName === 'slot' && el.assignedNodes) {
      try {
        for (const assigned of el.assignedNodes({ flatten: true })) {
          if (assigned !== root && !root.contains(assigned)) {
            externalAssignedNodes = true
            break
          }
        }
      } catch { /* slot assignment is best-effort */ }
    }
    let _t = pnow()
    const cs = styleFor(el)
    pacc('getComputedStyle', _t)
    if (cs.display === 'none') return null

    const id = 'n_' + (++seq).toString(36)
    const tag = el.localName
    _t = pnow()
    const role = computeRole(el, policy)
    pacc('computeRole', _t)
    _t = pnow()
    const { name, explicit: nameExplicit } = computeName(el, labelFor, strictScope ? root : undefined, policy)
    pacc('computeName', _t)
    // Identity may only trust the name when it's authored, or when the role takes its
    // name from content per ARIA. A content-derived name on a generic container is
    // unstable: move the content and two wrappers would swap identities.
    const nameForIdentity = (nameExplicit || NAME_FROM_CONTENT_ROLES.has(role)) ? name : ''
    // Identity compares a FINGERPRINT, never the text: an excludeText checkpoint can then
    // omit every human-readable string and still match.
    const nameFp = nameForIdentity ? hash('nm', nameForIdentity) : ''
    const testid = attribute(el, 'data-testid', policy) || null
    const ordKey = tag + '|' + role
    const ordinal = (ordinalKeyCounts[ordKey] = (ordinalKeyCounts[ordKey] || 0) + 1)
    const path = semanticPath + '/' + tag + (role !== 'generic' ? `[${role}]` : '')

    _t = pnow()
    const bbox = geo.bbox(el, noise.geometryTolerance)
    pacc('relativeBBox', _t)
    let visible = cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 &&
      bbox.viewport[2] > 0 && bbox.viewport[3] > 0
    // Hidden-input proxy (FIELD.md visual pass): design systems render the native
    // control at opacity:0 with a styled label as its visible face. The control is
    // real, laid out and clickable — dropping it as invisible erases every custom
    // checkbox/radio from the agent map. If any associated label is visible, the
    // control is visible.
    if (!visible && el.labels && el.labels.length && cs.visibility !== 'hidden' &&
        bbox.viewport[2] > 0 && bbox.viewport[3] > 0) {
      for (const l of el.labels) {
        const lcs = styleFor(l)
        const lr = l.getBoundingClientRect()
        if (lcs.display !== 'none' && lcs.visibility !== 'hidden' &&
            parseFloat(lcs.opacity) > 0 && lr.width > 0 && lr.height > 0) { visible = true; break }
      }
    }
    const interactive = INTERACTIVE_ROLES.has(role) ||
      attribute(el, 'onclick', policy) !== null || (!policy?.redactsAttribute(el, 'tabindex') && el.tabIndex >= 0)
    _t = pnow()
    const occluder = interactive && visible ? occluderAt(el, bbox.viewport) : null
    pacc('occluderAt', _t)
    const covered = !!occluder
    if (occluder) occluders.set(id, occluder)

    // Own COMPOSED text only — subtree text belongs to the children (Merkle locality).
    // This includes a Text node directly under an open ShadowRoot or assigned to a slot.
    const ownText = tag === 'textarea' || policy?.isField(el) ? '' : composedOwnText(el, policy)
    const normText = normalizeText(ownText, el, noise)
    const authoredParts = authoredContentParts(el, name, nameExplicit, policy)
    const authoredHash = authoredParts.length
      ? hash('authored', ...authoredParts.flat())
      : ''
    _t = pnow()
    const { state, valueSignal, valueChangeUncertainty, rawValue, sensitive } = interactionState(el, policy)
    pacc('interactionState', _t)

    const isCanvas = tag === 'canvas'
    const isIframe = tag === 'iframe'
    let iframeReadable = false
    if (isIframe) {
      try { iframeReadable = !!el.contentDocument?.documentElement } catch { /* cross-origin */ }
    }
    const possibleClosedShadow = mayHaveClosedShadow(el)

    // §1 — the three hashes. Identity core inside contentHash is tag+role+testid only:
    // accessibleName can derive from SUBTREE text, and letting it in would produce two
    // changes for one text edit (the text node's and every named ancestor's).
    const textHash = hash('t', normText, authoredHash)
    // Raw-text hash rides along so the diff can attribute geometry side-effects of
    // NORMALIZED text changes (a clock tick shifts the span width in proportional
    // fonts — the resize is the same non-change as the digits; codex assert round).
    const rawTextHash = ownText === normText ? textHash : hash('t', ownText, authoredHash)
    const stateHash = hash('s', JSON.stringify(state), valueSignal)
    _t = pnow()
    const style = styleSubset(el, cs, animated.get(el))
    const sHash = hash('y', style.text)
    pacc('styleSubset', _t)
    const contentHash = hash('c', tag, role, testid || '', textHash, stateHash, sHash)
    // A running animation on a layout/transform property moves the box every frame.
    // §5 demands zero-config suppression, so the geometry signature is FROZEN while
    // such an animation runs — the element reports neither style nor moved noise.
    // (Its content/state still sign normally: a real change during an animation is
    // still a real change.)
    // The freeze INHERITS (field pass: a transform animation on a container moves every
    // descendant while only the container reports an animation — 162 of github's 162
    // at-rest false positives were descendants of one animating logo strip).
    const animProps = animated.get(el)
    const geometryAnimating = frozenGeo || (!!animProps && (animProps.has('*') ||
      GEOMETRY_ANIMATION_PROPS.some((p) => animProps.has(p))))
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
      textHash, rawTextHash, stateHash, styleHash: sHash, contentHash, geometryHash,
      subtreeHash: '', // filled after children
      geometryAnimating,
      childIds: [],
    }
    PRIVACY_INPUTS.set(node, {
      ownText,
      normText,
      authoredParts,
      nameForIdentity,
      rawValue,
      sensitive,
      valueSignal,
      styleParts: style.parts,
    })
    if (valueChangeUncertainty) node.valueChangeUncertainty = valueChangeUncertainty
    if (isCanvas) {
      node.sourceType = 'canvas'
      node.semanticsAvailable = false
      node.rasterAvailable = true
      if (role === 'generic') node.role = 'img'
    }
    // Even a same-origin iframe is a separate document and is not part of this composed
    // walk. Declaring it unobservable is preferable to a false `changed:false`; callers
    // can inspect that document separately. Same-origin content can at least be rasterized.
    if (isIframe) {
      node.sourceType = 'iframe'
      node.semanticsAvailable = false
      node.rasterAvailable = iframeReadable
    }
    if (possibleClosedShadow && node.semanticsAvailable !== false) {
      node.sourceType = 'possible-closed-shadow'
      node.semanticsAvailable = false
      node.rasterAvailable = true
    }

    nodes.set(id, node)
    order.push(id)
    byElement.set(el, id)
    elements.set(id, el)
    // one yield per node: the sync path drains without pausing; the chunked path
    // parks here every sliceSize nodes so the tab never freezes for seconds
    yield

    const childCounts = {}
    const childHashes = []
    for (const child of composedChildren(el)) {
      const cid = yield* visit(child, id, path, childCounts, depth + 1, geometryAnimating)
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

  const finish = (rootId) => {
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
    const label = !strictScope || n
      ? visibleText(el, 600, policy).replace(/\s+/g, ' ').trim().slice(0, 60)
      : ''
    // An occluder outside the capture root has no snapshot node, but its authored
    // accessible name is still the safest compact description of what blocks the
    // target. Scope reports disclose this external render reference explicitly.
    const externalName = !n && !strictScope ? computeName(el, null, undefined, policy).name : ''
    const name = n && n.name ? n.name : externalName
    nodes.get(id).coveredBy = {
      ...(hitId ? { id: hitId } : {}),
      role: n ? n.role : policy?.isBlocked(el) ? 'generic' : computeRole(el, policy),
      ...(name ? { name } : {}),
      ...(label && label !== name ? { label } : {}),
    }
  }
  return {
    nodes, order, rootId, byElement, elements,
    rootHash: rootId ? nodes.get(rootId).subtreeHash : hash('empty'),
    externalAssignedNodes,
  }
  }
  return { walk: () => visit(root, null, '', {}, 0), finish, resetGeometryCache: geo.reset }
}

export function takeSnapshot(root, noise, options = {}) {
  const w = makeWalker(root, noise, options)
  const gen = w.walk()
  let r = gen.next()
  while (!r.done) r = gen.next()
  return w.finish(r.value)
}

// TIME-budget slicing over a MessageChannel task, NOT count-based setTimeout(0):
// in a busy real-Chrome tab, timer yields get clamped/throttled and every yield
// hands the thread to arbitrary pending work — a 6s walk inflated to 24s in the
// field (panel gate round). MessageChannel posts are plain tasks: no 4ms clamp,
// no background throttling; and yielding only after budgetMs of actual work keeps
// the yield count proportional to work done. The main node walk is sliced; synchronous
// prelude/finalization work is measured separately and is not bounded by `budgetMs`.
const yieldToLoop = () => new Promise((res) => {
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = () => { port1.close(); res() }
  port2.postMessage(0)
})

/** Time-budget slicer shared by every loop that must not block the tab (the walk,
 *  the digest, assert evidence). Call the returned pause() between units of work;
 *  it returns null (no promise, no microtask) until budgetMs of continuous work has
 *  accrued, then a yield. Slice stats land in __SD_PROF when profiling.
 *
 *  Every ~150ms of work the yield goes through setTimeout(0) instead of the
 *  MessageChannel: a chain of posted-message tasks can be serviced ahead of the
 *  TIMER queue, so a walk that slices perfectly still reads as one giant block to
 *  a setInterval probe (panel round: internal maxSliceMs 88ms vs external 1017ms —
 *  and its own safety timeouts starve the same way). Draining the timer queue at a
 *  bounded interval costs a few 4ms clamps per walk and makes the external
 *  measurement converge with the internal one. */
export function makeSlicer(budgetMs = 40) {
  // __SD_SLICES: slice-stats-only sink for consumers that want maxSliceMs/slices
  // auditable on EVERY walk without paying the per-node phase accumulators of the
  // full profiler (codex v5: "the ≤90ms-block property is not auditable from the
  // consumer surface")
  const P = typeof window !== 'undefined' && (window.__SD_PROF || window.__SD_SLICES)
  let last = performance.now()
  let lastTimerYield = last
  const pause = () => {
    const now = performance.now()
    if (now - last < budgetMs) return null
    if (P) { P.slices = (P.slices || 0) + 1; P.maxSliceMs = Math.max(P.maxSliceMs || 0, Math.round(now - last)) }
    const viaTimer = now - lastTimerYield >= 150
    const p = viaTimer ? new Promise((res) => setTimeout(res, 0)) : yieldToLoop()
    return p.then(() => {
      last = performance.now()
      if (viaTimer) lastTimerYield = last
    })
  }
  // Call after awaiting FOREIGN async work (which slices itself): wall time spent
  // there is not this slicer's continuous work — counting it reported maxSliceMs 255
  // for a pipeline whose real slices were ≤45ms (falsely alarming, the mirror image
  // of the falsely-reassuring self-report the panel warned about).
  pause.reset = () => { last = performance.now() }
  return pause
}

/**
 * Chunked walk: identical semantics, but the expensive style/geometry reads yield
 * to the event loop every `budgetMs` of work so a 13k-node page no longer freezes
 * the tab for seconds (panel: 5-7s freezes blew CDP budgets and orphaned loops).
 * The "one instant" guarantee is traded for an HONEST flag: `torn` counts DOM
 * mutations observed while the walk was parked — a torn observation says so
 * instead of pretending.
 */
export async function takeSnapshotChunked(root, noise, {
  budgetMs = 40,
  strictScope = false,
  engineFrame,
  capturePolicy,
} = {}) {
  const P = typeof window !== 'undefined' && window.__SD_PROF
  let t = P ? performance.now() : 0
  const w = makeWalker(root, noise, { strictScope, engineFrame, capturePolicy })
  if (P) P.prelude = (P.prelude || 0) + (performance.now() - t)
  let torn = 0
  let mo = null
  let mutationMonitorInstalled = false
  let mutationMonitorFailures = 0
  const observedShadowRoots = new Set()
  const attemptedShadowRoots = new Set()
  const mutationOptions = { subtree: true, childList: true, attributes: true, characterData: true }
  const observeOpenShadowRoots = () => {
    if (!mo) return 0
    let added = 0
    for (const shadow of collectOpenShadowRoots(root)) {
      if (attemptedShadowRoots.has(shadow)) continue
      attemptedShadowRoots.add(shadow)
      try {
        mo.observe(shadow, mutationOptions)
        observedShadowRoots.add(shadow)
        added++
      } catch {
        mutationMonitorFailures++
      }
    }
    return added
  }
  try {
    mo = new MutationObserver((recs) => { torn += recs.length })
    mo.observe(root, mutationOptions)
    mutationMonitorInstalled = true
    observeOpenShadowRoots()
  } catch { /* no MutationObserver: torn stays 0 */ }
  const pause = makeSlicer(budgetMs)
  const gen = w.walk()
  let r = gen.next()
  while (!r.done) {
    const p = pause()
    // Geometry memos are only valid for one uninterrupted stretch of layout. Parking the
    // walk lets the page move, so they are dropped at every yield rather than risking a
    // rect measured before a reflow being reused after it.
    if (p) { await p; w.resetGeometryCache() }
    r = gen.next()
  }
  if (mo) {
    // Attaching a ShadowRoot is not itself observable from the host. A final composed scan
    // catches roots that appeared while parked; their pre-observation contents may already
    // have been read inconsistently, so each is an honest torn event.
    torn += observeOpenShadowRoots()
    torn += mo.takeRecords().length
    mo.disconnect()
  }
  if (P) t = performance.now()
  const out = w.finish(r.value)
  out.mutationMonitorInstalled = mutationMonitorInstalled
  out.mutationMonitorCoverage = out.externalAssignedNodes || mutationMonitorFailures > 0
    ? 'INCOMPLETE'
    : 'ROOT_AND_DISCOVERED_OPEN_SHADOW_ROOTS'
  out.mutationMonitorFailures = mutationMonitorFailures
  if (P) P.finish = (P.finish || 0) + (performance.now() - t)
  out.torn = torn
  return out
}
