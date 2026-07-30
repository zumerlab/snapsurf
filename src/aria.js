/**
 * Role + accessible-name computation. Deliberately a pragmatic subset of the ACCNAME
 * spec: aria-label / aria-labelledby / <label for> / alt / title / value(button-ish) /
 * text content — enough for identity signals and Playwright-shaped queries, not a
 * conformance implementation.
 * @module agent/aria
 */

const IMPLICIT_ROLES = {
  a: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
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
  input: (el) => {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
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
export function computeRole(el) {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.trim().split(/\s+/)[0]
  const f = IMPLICIT_ROLES[el.localName]
  return f ? f(el) : 'generic'
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

/** @param {Element} el @returns {string} */
export function computeAccessibleName(el) {
  return computeName(el).name
}

/**
 * @param {Element} el
 * @returns {{name: string, explicit: boolean}} explicit = the name came from an
 *   authored source (aria-label/labelledby, <label>, alt, title, value), not from
 *   subtree text.
 */
export function computeName(el) {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return { name: norm(ariaLabel), explicit: true }

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const doc = el.ownerDocument
    const parts = labelledBy.split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((n) => norm(n.textContent))
      .filter(Boolean)
    if (parts.length) return { name: parts.join(' '), explicit: true }
  }

  if (el.id) {
    try {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (label) return { name: norm(label.textContent), explicit: true }
    } catch { }
  }
  const wrappingLabel = el.closest && el.closest('label')
  if (wrappingLabel && wrappingLabel !== el) {
    const t = norm(wrappingLabel.textContent)
    if (t) return { name: t, explicit: true }
  }

  if (el.localName === 'img') return { name: norm(el.getAttribute('alt')), explicit: true }
  if (el.localName === 'input') {
    const t = (el.getAttribute('type') || '').toLowerCase()
    if (t === 'submit' || t === 'button' || t === 'reset') {
      return { name: norm(el.getAttribute('value')) || t, explicit: true }
    }
    const ph = el.getAttribute('placeholder')
    if (ph) return { name: norm(ph), explicit: true }
  }

  const title = el.getAttribute('title')
  if (title) return { name: norm(title), explicit: true }

  // Content-derived name, capped: identity wants a fingerprint, not a transcript.
  const text = norm(el.textContent)
  return { name: text.length > 80 ? text.slice(0, 80) : text, explicit: false }
}
