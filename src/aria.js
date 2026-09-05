/**
 * Role + accessible-name computation. Deliberately a pragmatic subset of the ACCNAME
 * spec: aria-label / aria-labelledby / <label for> / alt / title / value(button-ish) /
 * text content — enough for identity signals and Playwright-shaped queries, not a
 * conformance implementation.
 * @module agent/aria
 */

import { attribute } from './capture-redaction.js'

const IMPLICIT_ROLES = {
  a: (el, policy) => (attribute(el, 'href', policy) !== null ? 'link' : 'generic'),
  button: () => 'button',
  select: () => 'combobox',
  textarea: () => 'textbox',
  img: () => 'img',
  nav: () => 'navigation',
  main: () => 'main',
  header: () => 'banner',
  footer: () => 'contentinfo',
  aside: () => 'complementary',
  form: () => 'form',
  table: () => 'table',
  tr: () => 'row',
  td: () => 'cell',
  th: () => 'columnheader',
  ul: () => 'list',
  ol: () => 'list',
  li: () => 'listitem',
  dialog: () => 'dialog',
  summary: () => 'button',
  h1: () => 'heading', h2: () => 'heading', h3: () => 'heading',
  h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
  option: () => 'option',
  progress: () => 'progressbar',
  input: (el, policy) => {
    const t = (attribute(el, 'type', policy) || 'text').toLowerCase()
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    if (t === 'range') return 'slider'
    if (t === 'number') return 'spinbutton'
    if (t === 'search') return 'searchbox'
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
    if (t === 'hidden') return 'none'
    return 'textbox'
  },
}

/** @param {Element} el @returns {string} */
export function computeRole(el, policy) {
  const explicit = attribute(el, 'role', policy)
  if (explicit) return explicit.trim().split(/\s+/)[0]
  const f = IMPLICIT_ROLES[el.localName]
  return f ? f(el, policy) : 'generic'
}

/** Composed containment crosses open-shadow host boundaries and slot assignment. */
export function composedContains(ancestor, node) {
  let current = node
  const seen = new Set()
  while (current && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    if (current.assignedSlot) {
      current = current.assignedSlot
      continue
    }
    if (current.parentElement) {
      current = current.parentElement
      continue
    }
    const tree = current.getRootNode?.()
    current = tree?.host || null
  }
  return false
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** ARIA "name from content" roles: for these, the accessible name legitimately derives
 *  from the subtree text and is a GOOD identity signal. For every other role (notably
 *  `generic` containers) a content-derived name is unstable — when content moves between
 *  wrappers, the wrappers would swap identities. Identity scoring must know the
 *  difference (see nameFromContent in the returned tuple). */
export const NAME_FROM_CONTENT_ROLES = new Set([
  'button', 'link', 'heading', 'listitem', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'cell', 'columnheader', 'rowheader', 'row', 'checkbox', 'radio',
  'switch', 'tooltip', 'treeitem', 'legend', 'caption', 'term', 'definition', 'summary',
])

/** Tags whose text is code or metadata, never something a user reads. */
const NON_TEXTUAL = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

/**
 * `textContent` includes the source of every inline `<script>` and `<style>` in the
 * subtree, so a container that happens to hold a tracking snippet gets named after the
 * snippet. Seen in the field on a real e-commerce home, where a section's name came back
 * as "(function() { if (false) { var firstViewUrl = …". Walk text nodes and skip those.
 * @param {Element} el
 */
export function visibleText(el, maxRaw = Infinity, policy) {
  // maxRaw: names are capped at 80 normalized chars, yet this walked ENTIRE subtrees
  // — 72% of the whole walk went here (perf round profile, 13k-node article). A raw
  // cap of ~1000 yields identical first-80 normalized chars except in pathological
  // all-whitespace subtrees, and turns O(document) per container into O(cap).
  let out = ''
  const walk = (node) => {
    if (node.localName === 'textarea') return false
    if (policy && (policy.isBlocked(node) || policy.isField(node))) return false
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (out.length >= maxRaw) return true
      if (c.nodeType === 3) {
        // Text is slottable too. Its light-DOM parent can be public while its
        // assigned slot renders under a blocked shadow ancestor.
        if (!policy?.isBlocked(c.assignedSlot)) out += c.nodeValue
      }
      else if (c.nodeType === 1 && !NON_TEXTUAL.has(c.tagName)) { if (walk(c)) return true }
    }
    return out.length >= maxRaw
  }
  walk(el)
  return out
}

/**
 * @param {Element} el
 * @returns {{name: string, explicit: boolean}} explicit = the name came from an
 *   authored source (aria-label/labelledby, <label>, alt, title, value), not from
 *   subtree text.
 */
export function computeName(el, labelFor, boundaryRoot, policy) {
  if (policy?.isBlocked(el)) return { name: '', explicit: false }
  const ariaLabel = attribute(el, 'aria-label', policy)
  if (ariaLabel) return { name: norm(ariaLabel), explicit: true }

  const labelledBy = attribute(el, 'aria-labelledby', policy)
  if (labelledBy) {
    // IDREFs are resolved in the element's own tree scope. ownerDocument lookup can
    // cross from an open shadow root into light DOM and import an unrelated duplicate id.
    const tree = el.getRootNode?.() || el.ownerDocument
    const parts = labelledBy.split(/\s+/)
      .map((id) => {
        const node = tree.getElementById?.(id) || null
        return node && (!policy || attribute(node, 'id', policy) === id) ? node : null
      })
      .filter((node) => node && !policy?.isBlocked(node) && (!boundaryRoot || composedContains(boundaryRoot, node)))
      .map((n) => norm(visibleText(n, Infinity, policy)))
      .filter(Boolean)
    if (parts.length) return { name: parts.join(' '), explicit: true }
  }

  const id = policy ? attribute(el, 'id', policy) : el.id
  if (id) {
    // labelFor: one document scan per walk instead of one full-document
    // querySelector per id'd element (thousands on a large article)
    if (boundaryRoot && el.labels) {
      const label = [...el.labels].find((candidate) => composedContains(boundaryRoot, candidate) && !policy?.isBlocked(candidate) && (!policy || attribute(candidate, 'for', policy) === id))
      if (label && !policy?.isBlocked(label)) return { name: norm(visibleText(label, 1000, policy)), explicit: true }
    } else if (labelFor) {
      const label = labelFor.get(id)
      if (label && !policy?.isBlocked(label)) return { name: norm(visibleText(label, 1000, policy)), explicit: true }
    } else {
      try {
        const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (label && !policy?.isBlocked(label)) return { name: norm(visibleText(label, Infinity, policy)), explicit: true }
      } catch { }
    }
  }
  const wrappingLabel = el.closest && el.closest('label')
  if (wrappingLabel && wrappingLabel !== el && !policy?.isBlocked(wrappingLabel) &&
      (!boundaryRoot || composedContains(boundaryRoot, wrappingLabel))) {
    const t = norm(visibleText(wrappingLabel, 1000, policy))
    if (t) return { name: t, explicit: true }
  }

  if (el.localName === 'img') return { name: norm(attribute(el, 'alt', policy)), explicit: true }
  if (el.localName === 'input') {
    const t = (attribute(el, 'type', policy) || '').toLowerCase()
    if (t === 'submit' || t === 'button' || t === 'reset') {
      return { name: policy?.isField(el) ? t : norm(attribute(el, 'value', policy)) || t, explicit: true }
    }
    const ph = attribute(el, 'placeholder', policy)
    if (ph) return { name: norm(ph), explicit: true }
  }

  const title = attribute(el, 'title', policy)
  if (title) return { name: norm(title), explicit: true }

  // Content-derived name, capped: identity wants a fingerprint, not a transcript.
  const text = norm(visibleText(el, 1000, policy))
  return { name: text.length > 80 ? text.slice(0, 80) : text, explicit: false }
}
