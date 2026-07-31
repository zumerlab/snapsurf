/**
 * Companion content script (source — bundled into content.bundle.js).
 *
 * Runs in the ISOLATED WORLD: immune to page CSP (what killed page-world injection:
 * CSP on wikipedia/ebay + Private Network Access toward localhost), with a shared
 * DOM. The oracle lives here; the page world (and any agent with a javascript tool,
 * like the Claude extension) talks to it via postMessage and reads the result from
 * a DOM node:
 *
 *   window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId }, '*')
 *   // await SNAPDOM_DIGEST_READY (echoes obsId), then:
 *   JSON.parse(document.getElementById('__snapdom_digest').textContent)
 *
 * The digest includes the DIFF against the previous observation of the same
 * document — the Claude extension stops paying screenshots to know what changed.
 */
import { observe, buildUi } from '../src/plugin.js'

const NODE_ID = '__snapdom_digest'
let prev = null

// CSS selector the READER can act with (its own click tools) — feedback from the
// Claude-extension panel: our n_xxx ids aren't actionable from outside the oracle.
// Read-only: no DOM stamping, no self-inflicted diff noise.
// UNIQUE or ABSENT — never a selector that resolves to a different element (panel
// round 6: 3/6 relative selectors matched 24-134 elements and querySelector returned
// the WRONG headline; acting on that clicks the wrong thing). Full nth-of-type path
// up to the nearest #id ancestor or the root, then VERIFIED against the element.
function selectorOf(el) {
  if (!el) return null
  if (el.id) return '#' + CSS.escape(el.id)
  const parts = []
  let cur = el
  while (cur && cur !== document.documentElement) {
    if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break }
    let p = cur.localName
    const parent = cur.parentElement
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.localName === cur.localName)
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(cur) + 1})`
    }
    parts.unshift(p)
    cur = parent
  }
  const sel = parts.join(' > ')
  try { if (document.querySelector(sel) === el) return sel } catch { /* invalid sel */ }
  return null
}

const vboxOf = (b) => b ? [b[0] - Math.round(scrollX), b[1] - Math.round(scrollY), b[2], b[3]] : undefined
// out-of-viewport vbox is numerically valid but useless for clicking — flag it
const inViewOf = (v) => !!v && v[0] < innerWidth && v[0] + v[2] > 0 && v[1] < innerHeight && v[1] + v[3] > 0

// Parent-section context ("belongs to MÁS LEÍDAS") — panel feedback on lanacion:
// without it, placing a heading required an extra DOM query. Climbs to the nearest
// sectioning ancestor and returns its own heading text (or aria-label). If that
// heading IS the element we're describing, keep climbing.
function sectionOf(el) {
  const ownText = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  let cur = el && el.parentElement
  let depth = 0
  while (cur && cur !== document.body && depth < 12) {
    if (/^(section|article|aside|nav|main|header|footer)$/.test(cur.localName) || cur.getAttribute('role') === 'region') {
      // page-wide wrappers make EVERYTHING report the lead story as its section
      // (lanacion) — a real section box ("MÁS LEÍDAS") is bounded; keep climbing
      // past huge ancestors without taking their heading.
      const tall = cur.getBoundingClientRect().height > 8000
      if (!tall) {
        const hs = cur.querySelectorAll('h1,h2,h3,h4,[role="heading"]')
        // flat result LISTS are heading collections, not titled sections — taking
        // their first heading labeled every item with the previous item's title
        // (panel, lanacion buscador). Ambiguous container → absent beats wrong.
        const isFlatList = hs.length > 3
        const h = hs[0]
        if (!isFlatList && h && h !== el && !h.contains(el) && !el.contains(h)) {
          const t = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
          if (t && t !== ownText) return t
        }
        const al = cur.getAttribute('aria-label')
        if (al && al.slice(0, 60) !== ownText) return al.slice(0, 60)
      }
    }
    cur = cur.parentElement
    depth++
  }
  return undefined
}

function digestOf(ui, topN, headsN) {
  const marks = []
  const heads = []
  const LANDMARKS = { navigation: 1, main: 1, banner: 1, contentinfo: 1, search: 1, form: 1, complementary: 1 }
  for (const id of ui.__snapshot.order) {
    const n = ui.__snapshot.nodes.get(id)
    if (!n) continue
    if (n.role === 'heading' && heads.length < headsN) {
      const el = ui.__snapshot.elements.get(id)
      heads.push({ id, text: (n.name || n.text || '').slice(0, 120), section: sectionOf(el) })
    } else if (LANDMARKS[n.role] && marks.length < 10) marks.push({ id, role: n.role, name: (n.name || '').slice(0, 60), bbox: n.bbox })
  }
  const top = ui.agentMap.map.slice(0, topN).map((e) => {
    const el = ui.__snapshot.elements.get(e.id)
    // href: the panel's read_page gave hrefs without names, our digest names without
    // hrefs — neither sufficed alone (lanacion buscador). Together the digest does.
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = (u.pathname + u.search).slice(0, 300) }
    } catch { /* noop */ }
    const v = vboxOf(e.b)
    return {
      id: e.id, role: e.r, name: (e.n || '').slice(0, 120),
      bbox: e.b, vbox: v, inView: inViewOf(v),
      selector: selectorOf(el),
      href: href || undefined,
      section: sectionOf(el),
      covered: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined,
    }
  })
  return { marks, heads, top }
}

// match: the in-page find — searches the WHOLE snapshot (names + text), not the
// top-N window. Panel round 5: lanacion's front page outran top:100/heads:60 (38kB
// and still not found) while a text match is one call and ~2kB. Full text up to
// 300 chars — its native find and read_page both truncate at 100.
function findMatches(ui, query) {
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const q = norm(query)
  const out = new Map()
  const add = (id, role, name) => {
    if (!name || out.has(id) || !norm(name).includes(q)) return
    const el = ui.__snapshot.elements.get(id)
    const n = ui.__snapshot.nodes.get(id)
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      // navigable, not a teaser: 100 chars cut "…nid28072026/" mid-id (panel round 6)
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = (u.pathname + u.search).slice(0, 500) }
    } catch { /* noop */ }
    // snapshot name/text arrive pre-truncated (~80c) — take the LONGER of snapshot
    // vs live DOM text so the 300c contract holds (the h2 was 127c, arrived 80c)
    const fromSnap = ((n && (n.name || n.text)) || name || '').replace(/\s+/g, ' ').trim()
    const fromDom = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const full = (fromDom.length > fromSnap.length ? fromDom : fromSnap).slice(0, 300)
    const v = vboxOf(n && n.bbox)
    out.set(id, {
      id, role, text: full, href: href || undefined,
      selector: selectorOf(el), section: sectionOf(el),
      bbox: n && n.bbox, vbox: v, inView: inViewOf(v),
    })
  }
  for (const e of ui.agentMap.map) add(e.id, e.r, e.n)
  for (const id of ui.__snapshot.order) {
    if (out.size >= 20) break
    const n = ui.__snapshot.nodes.get(id)
    add(id, n.role, n.name || n.text)
  }
  return [...out.values()].slice(0, 20)
}

function runObserve(opts = {}) {
  const t0 = performance.now()
  const ui = buildUi(observe(document.body, prev ? { previous: prev } : {}), {})
  prev = ui.checkpoint()
  // Every change carries a readable label: name, else the node's own text, else the
  // subtree text — 29/30 anonymous `generic` changes made the panel's first diff
  // useless. Named changes sort first.
  const describeChange = (c) => {
    let label = c.name && String(c.name).slice(0, 60)
    if (!label && c.id) {
      const n = ui.__snapshot.nodes.get(c.id)
      if (n) label = ((n.name || n.text || '')).slice(0, 60) || undefined
      if (!label) {
        const el = ui.__snapshot.elements.get(c.id)
        if (el) label = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined
      }
    }
    return { kind: c.kind, role: c.role, name: label, id: c.id, selector: selectorOf(ui.__snapshot.elements.get(c.id)) || undefined }
  }
  const out = {
    // origin+pathname only: the Claude extension's sanitizer redacts URLs carrying
    // query strings ("[BLOCKED: Cookie/query string data]")
    url: location.origin + location.pathname,
    // opt-in full URL (query included): the default stays sanitized because the
    // Claude-extension sanitizer redacts query-bearing urls, but on a search-results
    // page the query IS the meaning — the reader decides.
    urlFull: opts.fullUrl ? location.href : undefined,
    ts: Date.now(),
    // obsId, NOT "token": the panel's JS bridge censors any key literally named
    // token ("[BLOCKED: Sensitive key]") — the echo was unverifiable from its side.
    obsId: opts.obsId ?? undefined,
    // Coordinate contract (panel round 3): vbox is CSS px of THIS viewport; readers
    // whose screenshots are scaled (dpr) compute scale = screenshotWidth / viewport.width.
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
    walkMs: Math.round(performance.now() - t0),
    actionables: ui.agentMap.map.length,
    unobservable: ui.unobservable.length,
    changed: ui.changed,
    changes: ui.changes
      ? ui.changes.map(describeChange).sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0)).slice(0, 40)
      : undefined,
    actionabilityDelta: ui.actionabilityDelta,
    // match present → matches only (~2kB); digest only otherwise (a 38kB top:100
    // digest that still misses the target is the wrong tool for long front pages)
    matches: opts.match ? findMatches(ui, opts.match) : undefined,
    digest: opts.match ? undefined : digestOf(ui, Math.min(100, opts.top || 25), Math.min(60, opts.heads || 15)),
  }
  let node = document.getElementById(NODE_ID)
  if (!node) {
    node = document.createElement('script')
    node.type = 'application/json'
    node.id = NODE_ID
    document.documentElement.appendChild(node)
  }
  node.textContent = JSON.stringify(out)
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SNAPDOM_OBSERVE') {
    const obsId = e.data.obsId ?? e.data.token ?? null // token kept for old snippets
    try { runObserve({ top: e.data.top, heads: e.data.heads, fullUrl: e.data.fullUrl, match: e.data.match, obsId }) } catch (err) {
      const node = document.getElementById(NODE_ID) || Object.assign(document.documentElement.appendChild(document.createElement('script')), { type: 'application/json', id: NODE_ID })
      node.textContent = JSON.stringify({ error: String(err), url: location.origin + location.pathname, ts: Date.now(), obsId })
    }
    // Readiness signal (panel round 3): awaiting this instead of a fixed 800ms sleep
    // cuts the round from ~830ms to ~walk time.
    window.postMessage({ type: 'SNAPDOM_DIGEST_READY', obsId }, '*')
  }
})

// Presence marker: agents check this before requesting observations.
const marker = document.createElement('meta')
marker.name = '__snapdom_companion'
marker.content = '0.1.0'
document.documentElement.appendChild(marker)
