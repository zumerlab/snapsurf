/**
 * Benchmarks (§Phase 3/4): timings report, checkpoint compactness gates. Three costs
 * on the same pages, because
 * `inspect()` now runs a real snapdom capture with the oracle plugin attached and the
 * only interesting question is how that splits:
 *
 *   walk_*     the semantic visitor alone (what the plugin hook does)
 *   inspect_*  walk + capture — what a caller actually pays for one observation
 *   capture_*  a bare capture with cache and memoization off (the cold-path reference)
 *
 * Plus checkpoint size vs the serialized DOM of the same page.
 */
import { describe, it, expect } from 'vitest'
import { inspect } from '../src/index.js'
import { observe } from '../src/plugin.js'
import { snapdom } from '@zumer/snapdom'

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

describe('agent benchmarks and checkpoint budget', () => {
  it('inspect() vs snapdom.capture(), and checkpoint size vs serialized DOM', async () => {
    const report = []
    for (const cards of [12, 48, 120]) {
      const el = scene(cards)
      try {
        const iT = []
        const cT = []
        const wT = []
        let ui
        for (let i = 0; i < 12; i++) {
          const t0 = performance.now()
          observe(el)
          wT.push(performance.now() - t0)
        }
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
        // Exercise the actual wire boundary, not an in-memory object that could carry
        // accidental prototypes/references the persisted JSON does not.
        const persistedCp = JSON.parse(JSON.stringify(cp))
        const dT = []
        let diffChanged
        for (let i = 0; i < 12; i++) {
          const t0 = performance.now()
          const after = await inspect(el, { previous: persistedCp })
          diffChanged = after.changed
          dT.push(performance.now() - t0)
        }
        expect(diffChanged).toBe(false)
        const cpBytes = JSON.stringify(cp).length
        const cpLean = JSON.stringify(ui.checkpoint({ excludeText: true })).length
        const domBytes = el.outerHTML.length
        const nodes = cp.nodes.length
        report.push({
          cards, nodes,
          walk_p50: pct(wT, 0.5), walk_p95: pct(wT, 0.95),
          inspect_p50: pct(iT, 0.5), inspect_p95: pct(iT, 0.95),
          diff_p50: pct(dT, 0.5), diff_p95: pct(dT, 0.95),
          capture_p50: pct(cT, 0.5), capture_p95: pct(cT, 0.95),
          checkpoint_bytes: cpBytes, checkpoint_excludeText_bytes: cpLean,
          checkpoint_bytes_per_node: +(cpBytes / nodes).toFixed(2),
          checkpoint_excludeText_bytes_per_node: +(cpLean / nodes).toFixed(2),
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
    // A DOM ratio is not a stable compactness contract: `<div></div>` is 11 bytes but
    // its checkpoint still needs identity, change hashes and geometry. Marginal bytes
    // per semantic node are stable across page sizes and directly budget the wire.
    // The pre-columnar object format measured ~180 B/node (~158 without names) here.
    // These ceilings leave headroom for real content while preventing that regression.
    for (const row of report) {
      expect(row.checkpoint_bytes_per_node).toBeLessThanOrEqual(110)
      expect(row.checkpoint_excludeText_bytes_per_node).toBeLessThanOrEqual(90)
    }
  }, 300000)
})
