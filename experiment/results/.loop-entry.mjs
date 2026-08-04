
import { inspect } from '/Users/martin/GitHub/zumerlab/snapdom/packages/agent/src/index.js'
import { startArmC } from '/Users/martin/GitHub/zumerlab/snapdom/packages/agent/experiment/arms.mjs'
let prev = null, cArm = null
window.__observe = async (arm) => {
  if (arm === 'B') {
    const ui = await inspect(document.body, prev ? { previous: prev } : {})
    const out = {
      interactive: ui.agentMap.map.map((e) => ({ name: e.n, role: e.r, box: e.b, covered: e.covered || false, coveredBy: e.coveredBy })),
      changesSinceLastObservation: prev ? ui.changes : 'first observation',
      actionabilityDelta: prev ? ui.actionabilityDelta : undefined,
    }
    prev = ui.checkpoint()
    return out
  }
  // Arm C: markup only — the element list carries no layout, no stacking, no occlusion.
  const list = [...document.querySelectorAll('button, a[href], input, [role=button]')].map((el) => ({
    name: (el.textContent || '').trim(), role: el.getAttribute('role') || el.localName,
    testid: el.getAttribute('data-testid') || undefined,
    disabled: el.hasAttribute('disabled') || undefined,
    hidden: el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || undefined,
  }))
  const mutations = cArm ? cArm.finish().payload : 'first observation'
  cArm = startArmC(document.body)
  return { interactive: list, mutationsSinceLastObservation: mutations }
}
