/**
 * Companion content script (fuente — se bundlea a content.bundle.js).
 *
 * Corre en ISOLATED WORLD: inmune a la CSP de la página (lo que mató la inyección
 * page-world: CSP en wikipedia/ebay + Private Network Access hacia localhost), con
 * DOM compartido. El oráculo vive acá; el mundo de la página (y cualquier agente con
 * un tool de javascript, como la extensión de Claude) le habla por postMessage y lee
 * el resultado de un nodo DOM:
 *
 *   window.postMessage({ type: 'SNAPDOM_OBSERVE' }, '*')
 *   // …~100ms después:
 *   JSON.parse(document.getElementById('__snapdom_digest').textContent)
 *
 * El digest incluye el DIFF contra la observación anterior del mismo documento —
 * la extensión de Claude deja de pagar screenshots para saber qué cambió.
 */
import { observe, buildUi } from '../src/plugin.js'

const NODE_ID = '__snapdom_digest'
let prev = null

// CSS selector the READER can act with (its own click tools) — feedback from the
// Claude-extension panel: our n_xxx ids aren't actionable from outside the oracle.
// Read-only: no DOM stamping, no self-inflicted diff noise.
function selectorOf(el) {
  if (!el) return null
  if (el.id) return '#' + CSS.escape(el.id)
  const parts = []
  let cur = el
  while (cur && cur !== document.body && parts.length < 5) {
    let p = cur.localName
    const parent = cur.parentElement
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.localName === cur.localName)
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(cur) + 1})`
    }
    parts.unshift(p)
    if (parent && parent.id) { parts.unshift('#' + CSS.escape(parent.id)); break }
    cur = parent
  }
  return parts.join(' > ')
}

const vboxOf = (b) => b ? [b[0] - Math.round(scrollX), b[1] - Math.round(scrollY), b[2], b[3]] : undefined

// Parent-section context ("belongs to MÁS LEÍDAS") — panel feedback on lanacion:
// without it, placing a heading required an extra DOM query. Climbs to the nearest
// sectioning ancestor and returns its own heading text (or aria-label). If that
// heading IS the element we're describing, keep climbing.
function sectionOf(el) {
  const ownText = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  let cur = el && el.parentElement
  let depth = 0
  while (cur && cur !== document.body && depth < 12) {
    if (/^(section|article|aside|nav|main|header|footer)$/.test(cur.localName) || cur.getAttribute('role') === 'region') {
      // page-wide wrappers make EVERYTHING report the lead story as its section
      // (lanacion) — a real section box ("MÁS LEÍDAS") is bounded; keep climbing
      // past huge ancestors without taking their heading.
      const tall = cur.getBoundingClientRect().height > 8000
      if (!tall) {
        const h = cur.querySelector('h1,h2,h3,h4,[role="heading"]')
        if (h && h !== el && !h.contains(el) && !el.contains(h)) {
          const t = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
          if (t && t !== ownText) return t
        }
        const al = cur.getAttribute('aria-label')
        if (al) return al.slice(0, 40)
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
      heads.push({ id, text: (n.name || n.text || '').slice(0, 90), section: sectionOf(el) })
    } else if (LANDMARKS[n.role] && marks.length < 10) marks.push({ id, role: n.role, name: (n.name || '').slice(0, 60), bbox: n.bbox })
  }
  const top = ui.agentMap.map.slice(0, topN).map((e) => {
    const el = ui.__snapshot.elements.get(e.id)
    return {
      id: e.id, role: e.r, name: (e.n || '').slice(0, 90),
      bbox: e.b, vbox: vboxOf(e.b),
      selector: selectorOf(el),
      section: sectionOf(el),
      covered: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined,
    }
  })
  return { marks, heads, top }
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
    ts: Date.now(),
    token: opts.token ?? undefined,
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
    digest: digestOf(ui, Math.min(100, opts.top || 25), Math.min(60, opts.heads || 15)),
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
    const token = e.data.token ?? null
    try { runObserve({ top: e.data.top, heads: e.data.heads, token }) } catch (err) {
      const node = document.getElementById(NODE_ID) || Object.assign(document.documentElement.appendChild(document.createElement('script')), { type: 'application/json', id: NODE_ID })
      node.textContent = JSON.stringify({ error: String(err), url: location.origin + location.pathname, ts: Date.now(), token })
    }
    // Readiness signal (panel round 3): awaiting this instead of a fixed 800ms sleep
    // cuts the round from ~830ms to ~walk time.
    window.postMessage({ type: 'SNAPDOM_DIGEST_READY', token }, '*')
  }
})

// Marcador de presencia: los agentes chequean esto antes de pedir observaciones.
const marker = document.createElement('meta')
marker.name = '__snapdom_companion'
marker.content = '0.1.0'
document.documentElement.appendChild(marker)
