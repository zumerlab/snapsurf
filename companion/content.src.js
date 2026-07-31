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

function digestOf(ui) {
  const marks = []
  const heads = []
  const LANDMARKS = { navigation: 1, main: 1, banner: 1, contentinfo: 1, search: 1, form: 1, complementary: 1 }
  for (const id of ui.__snapshot.order) {
    const n = ui.__snapshot.nodes.get(id)
    if (!n) continue
    if (n.role === 'heading' && heads.length < 15) heads.push({ id, text: (n.name || n.text || '').slice(0, 70) })
    else if (LANDMARKS[n.role] && marks.length < 10) marks.push({ id, role: n.role, name: (n.name || '').slice(0, 40), bbox: n.bbox })
  }
  const top = ui.agentMap.map.slice(0, 25).map((e) => ({
    id: e.id, role: e.r, name: (e.n || '').slice(0, 70), bbox: e.b,
    covered: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined,
  }))
  return { marks, heads, top }
}

function runObserve() {
  const t0 = performance.now()
  const ui = buildUi(observe(document.body, prev ? { previous: prev } : {}), {})
  prev = ui.checkpoint()
  const out = {
    url: location.href,
    ts: Date.now(),
    walkMs: Math.round(performance.now() - t0),
    actionables: ui.agentMap.map.length,
    unobservable: ui.unobservable.length,
    changed: ui.changed,
    changes: ui.changes ? ui.changes.slice(0, 40).map((c) => ({ kind: c.kind, role: c.role, name: c.name && String(c.name).slice(0, 50), id: c.id })) : undefined,
    actionabilityDelta: ui.actionabilityDelta,
    digest: digestOf(ui),
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
    try { runObserve() } catch (err) {
      const node = document.getElementById(NODE_ID) || Object.assign(document.documentElement.appendChild(document.createElement('script')), { type: 'application/json', id: NODE_ID })
      node.textContent = JSON.stringify({ error: String(err), url: location.href, ts: Date.now() })
    }
  }
})

// Marcador de presencia: los agentes chequean esto antes de pedir observaciones.
const marker = document.createElement('meta')
marker.name = '__snapdom_companion'
marker.content = '0.1.0'
document.documentElement.appendChild(marker)
