
import { inspect } from '/Users/martin/GitHub/zumerlab/snapdom/packages/agent/src/index.js'
import { startArmC, armB } from '/Users/martin/GitHub/zumerlab/snapdom/packages/agent/experiment/arms.mjs'
let cp = null, cArm = null
window.__agentPrepare = async () => {
  const ui = await inspect(document.body)
  cp = ui.checkpoint()
  cArm = startArmC(document.body)
}
window.__agentCollect = async () => {
  const B = await armB(inspect, document.body, cp)
  const C = cArm.finish()
  // §9 honesty signal: does the arm tell the caller that a region's semantics are
  // unavailable (canvas/blocked iframe) and must be rasterized to be understood?
  const flagsCanvas = B.ui.agentMap.map.some((e) => e.semanticsAvailable === false) ||
    B.ui.context.includes('no semantics')
  return { B: { payload: B.payload, bytes: B.bytes, flagsCanvas }, C }
}
