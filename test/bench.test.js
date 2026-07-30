/**
 * Benchmarks (§Phase 3/4): report, don't gate. inspect() p50/p95 vs snapdom.capture()
 * on the same pages, and checkpoint size vs the serialized DOM of the same page.
 */
import { describe, it, expect } from 'vitest'
import { inspect } from '../src/index.js'
import { snapdom } from '../../../src/api/snapdom.js'

function scene(cards) {
  const el = document.createElement('div')
  el.style.cssText = 'width:900px;padding:16px;position:relative'
  for (let i = 0; i < cards; i++) {
    const card = document.createElement('div')
    card.style.cssText = 'padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:6px'
    card.innerHTML = `<h3 style="margin:0">Card ${i}</h3>` +
      `<p style="margin:2px 0">Descripción del item ${i}</p>` +
      `<button data-testid="open-${i}">Abrir</button>` +
      `<input type="text" placeholder="nota ${i}">`
    el.appendChild(card)
  }
  document.body.appendChild(el)
  return el
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2)
}

describe('agent benchmarks (report only)', () => {
  it('inspect() vs snapdom.capture(), and checkpoint size vs serialized DOM', async () => {
    const report = []
    for (const cards of [12, 48, 120]) {
      const el = scene(cards)
      try {
        const iT = []
        const cT = []
        let ui
        for (let i = 0; i < 12; i++) {
          const t0 = performance.now()
          ui = await inspect(el)
          iT.push(performance.now() - t0)
        }
        for (let i = 0; i < 8; i++) {
          const t0 = performance.now()
          await snapdom(el, { cache: 'disabled', burst: false })
          cT.push(performance.now() - t0)
        }
        // Diff cost: inspect with a previous checkpoint on an unchanged page.
        const cp = ui.checkpoint()
        const dT = []
        for (let i = 0; i < 12; i++) {
          const t0 = performance.now()
          await inspect(el, { previous: cp })
          dT.push(performance.now() - t0)
        }
        const cpBytes = JSON.stringify(cp).length
        const cpLean = JSON.stringify(ui.checkpoint({ excludeText: true })).length
        const domBytes = el.outerHTML.length
        const nodes = Object.keys(cp.nodes).length
        report.push({
          cards, nodes,
          inspect_p50: pct(iT, 0.5), inspect_p95: pct(iT, 0.95),
          diff_p50: pct(dT, 0.5), diff_p95: pct(dT, 0.95),
          capture_p50: pct(cT, 0.5), capture_p95: pct(cT, 0.95),
          checkpoint_bytes: cpBytes, checkpoint_excludeText_bytes: cpLean,
          serialized_dom_bytes: domBytes,
          checkpoint_vs_dom: +(cpBytes / domBytes).toFixed(2),
          context_bytes: ui.context.length,
        })
      } finally {
        el.remove()
      }
    }
    console.log('AGENT_BENCH_JSON:' + JSON.stringify(report))
    expect(report.length).toBe(3)
  }, 300000)
})
