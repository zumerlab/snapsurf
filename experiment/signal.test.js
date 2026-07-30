/**
 * Phase-5, layer 1 — SIGNAL QUALITY (model-free, fully automated).
 *
 * The falsifiable hypothesis is about INFORMATION: do post-layout visual signatures
 * (computed style + geometry + stacking, read from the live DOM) tell an agent things
 * that a markup-level diff cannot? That question is answerable without a model: give
 * both arms the same mutation and ask whether each arm's payload CONTAINS the answer to
 * the stratum's question.
 *
 * Arm A (screenshots) carries no structured answer by construction — its payload is
 * pixels, so its column here is "requires a model to interpret" and it is measured in
 * layer 2 (harness.mjs, gated on an API key).
 *
 * Decision rule (§Phase 5): B must beat C consistently in at least two of the three
 * critical strata — replaced node, pure noise, occlusion.
 */
import { describe, it, expect } from 'vitest'
import { inspect } from '../src/index.js'
import { startArmC, armB } from './arms.mjs'

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

function mount(html) {
  const el = document.createElement('div')
  el.style.cssText = 'width:900px;position:relative'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

/**
 * One stratum = one mutation + one question, with a checker per arm that answers ONLY
 * from that arm's payload.
 */
const STRATA = [
  {
    name: 'occlusion — a modal covers actionable elements',
    html: `
      <button data-testid="save">Guardar</button>
      <button data-testid="delete">Borrar</button>
      <p>Contenido</p>`,
    mutate: (root) => {
      const m = document.createElement('div')
      m.setAttribute('role', 'dialog')
      m.setAttribute('aria-label', 'Confirmar')
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99'
      m.innerHTML = '<button>Sí</button>'
      root.appendChild(m)
    },
    question: 'Are the previously clickable buttons now unclickable?',
    // B: actionabilityDelta.becameCovered must name them.
    checkB: (p) => (p.actionabilityDelta?.becameCovered?.length || 0) >= 2,
    // C: a markup diff sees "a dialog appeared" but nothing about the buttons' state —
    // no arrangement of its payload answers the question.
    checkC: (p) => JSON.stringify(p).includes('covered'),
  },
  {
    name: 'pure noise — CSS-in-JS class churn with identical computed style',
    html: `
      <style>.gen-a1{color:rgb(51,51,51);font-weight:600}</style>
      <div class="gen-a1" id="t">Texto estable</div>
      <button class="gen-a1">Acción</button>`,
    mutate: (root) => {
      const st = document.createElement('style')
      st.textContent = '.gen-b7{color:rgb(51,51,51);font-weight:600}'
      root.appendChild(st)
      for (const el of root.querySelectorAll('.gen-a1')) el.className = 'gen-b7'
    },
    question: 'Did anything actually change for the user?',
    // Correct answer: NO. B must report an empty diff.
    checkB: (p) => p.changed === false || (p.changes || []).length === 0,
    // C sees attribute mutations on both elements and reports change — a false positive.
    checkC: (p) => (p.mutations || []).length === 0 && (p.a11yDiff || []).length === 0,
  },
  {
    name: 'pure noise — scroll only',
    html: `<div id="sc" style="height:120px;overflow:auto">${Array.from({ length: 30 }, (_, i) => `<div style="height:40px">Fila ${i}</div>`).join('')}</div>`,
    mutate: (root) => { root.querySelector('#sc').scrollTop = 320 },
    question: 'Did anything actually change for the user?',
    checkB: (p) => p.changed === false || (p.changes || []).length === 0,
    checkC: (p) => (p.mutations || []).length === 0 && (p.a11yDiff || []).length === 0,
  },
  {
    name: 'replaced node — React-style remount, same UI',
    html: `
      <div id="app">
        <h2>Ajustes</h2>
        <button data-testid="save">Guardar</button>
        <p>Perfil de usuario</p>
      </div>`,
    mutate: (root) => {
      // Same visible UI, brand-new instances and framework classes (a fresh render).
      root.querySelector('#app').outerHTML = `
      <div id="app">
        <h2 class="c-x9">Ajustes</h2>
        <button data-testid="save" class="c-y2">Guardar</button>
        <p class="c-z5">Perfil de usuario</p>
      </div>`
    },
    question: 'Is this the same UI (no user-visible change)?',
    checkB: (p) => (p.changes || []).filter((c) => ['added', 'removed', 'content'].includes(c.kind)).length === 0,
    // C sees the whole subtree replaced: added+removed for every node.
    checkC: (p) => (p.mutations || []).filter((m) => m.type === 'added' || m.type === 'removed').length === 0,
  },
  {
    name: 'replaced node — a card swapped for a different one at the same slot',
    html: `
      <ul>
        <li>Alpha · disponible</li>
        <li>Beta · disponible</li>
        <li>Gamma · disponible</li>
      </ul>`,
    mutate: (root) => {
      const li = root.querySelectorAll('li')[2]
      const fresh = document.createElement('li')
      fresh.textContent = 'Omega · agotado'
      li.replaceWith(fresh)
    },
    question: 'Was the third item EDITED, or REPLACED by a different item?',
    // B answers with the doubt made explicit (both ids, both names) or as add+remove —
    // either way it distinguishes "replaced" from "text edited".
    checkB: (p) => (p.changes || []).some((c) => c.kind === 'possible-replacement') ||
      ((p.changes || []).some((c) => c.kind === 'added') && (p.changes || []).some((c) => c.kind === 'removed')),
    // C reports added+removed too — this is the stratum where C is competitive.
    checkC: (p) => (p.mutations || []).some((m) => m.type === 'added') && (p.mutations || []).some((m) => m.type === 'removed'),
  },
  {
    name: 'semantically important but visually tiny — a disabled button becomes enabled',
    html: `<button data-testid="go" disabled>Continuar</button><p>texto</p>`,
    mutate: (root) => root.querySelector('[data-testid="go"]').removeAttribute('disabled'),
    question: 'Can I now click Continuar?',
    checkB: (p) => (p.changes || []).some((c) => c.kind === 'state' &&
      c.before && c.after && c.before.disabled === true && !c.after.disabled),
    // C sees the attribute removal — competitive here (attributes are markup).
    checkC: (p) => (p.mutations || []).some((m) => m.type === 'attr' && m.name === 'disabled'),
  },
  {
    name: 'live noise — a clock ticks and nothing else happens',
    html: `<p data-testid="clock">Actualizado 14:32:05</p><button>Refrescar</button>`,
    mutate: (root) => { root.querySelector('[data-testid="clock"]').textContent = 'Actualizado 14:32:09' },
    question: 'Did anything actually change for the user?',
    checkB: (p) => p.changed === false || (p.changes || []).length === 0,
    checkC: (p) => (p.mutations || []).length === 0 && (p.a11yDiff || []).length === 0,
  },
]

describe('Phase 5 — signal quality (B vs C, model-free)', () => {
  const results = []

  for (const s of STRATA) {
    it(s.name, async () => {
      const root = mount(s.html)
      try {
        await frame()
        const first = await inspect(root)
        const cp = first.checkpoint()
        const cArm = startArmC(root)
        s.mutate(root)
        await frame()
        const b = await armB(inspect, root, cp)
        const c = cArm.finish()
        const okB = !!s.checkB(b.payload)
        const okC = !!s.checkC(c.payload)
        results.push({
          stratum: s.name, question: s.question,
          B: { answers: okB, bytes: b.bytes, changes: (b.payload.changes || []).length },
          C: { answers: okC, bytes: c.bytes, records: (c.payload.mutations || []).length },
        })
        // Every stratum's question must be answerable from B's payload — that is the
        // product's claim, and a failure here is a product failure, not a harness one.
        expect(okB, `B failed to answer: ${s.question}\nB payload: ${JSON.stringify(b.payload).slice(0, 900)}`).toBe(true)
      } finally {
        root.remove()
      }
    }, 30000)
  }

  it('decision rule: B beats C in ≥2 of the 3 critical strata', () => {
    const strat = (kw) => results.filter((r) => r.stratum.includes(kw))
    const wins = (rows) => rows.filter((r) => r.B.answers && !r.C.answers).length
    const critical = {
      occlusion: wins(strat('occlusion')),
      'pure noise': wins(strat('pure noise')) + wins(strat('live noise')),
      'replaced node': wins(strat('replaced node')),
    }
    const bytesB = results.reduce((a, r) => a + r.B.bytes, 0)
    const bytesC = results.reduce((a, r) => a + r.C.bytes, 0)
    console.log('SIGNAL_REPORT_JSON:' + JSON.stringify({ results, critical, bytesB, bytesC }))
    const strataWon = Object.values(critical).filter((n) => n > 0).length
    expect(strataWon, `B won only ${strataWon} critical strata: ${JSON.stringify(critical)}`).toBeGreaterThanOrEqual(2)
  })
})
