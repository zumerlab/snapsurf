import { inspect } from '../../src/index.js'

/**
 * Draw NEW pixels on the canvas — no DOM attribute, style or text is touched.
 * Pixel state is invisible to DOM signatures, so the diff must be empty; the
 * real assertion is honesty: the canvas must be flagged semantics-unavailable
 * in both the context outline and the agentMap. The runner's JSON vocabulary
 * cannot see ui.context/ui.agentMap, so that part is asserted right here.
 */
export default async function mutate(root, { frame }) {
  const canvas = root.querySelector('#chart')
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#1976d2'
  ctx.fillRect(10, 10, 120, 60)
  await frame()
  ctx.fillStyle = '#e53935'
  ctx.fillRect(150, 40, 180, 90)
  await frame()

  // Honesty check (outside the runner's JSON vocabulary):
  const ui = await inspect(root)
  if (!ui.context.includes('canvas: no semantics')) {
    throw new Error('honesty: ui.context does not flag the canvas as semantics-unavailable')
  }
  const entry = (ui.agentMap.map || []).find((m) => m.sourceType === 'canvas')
  if (!entry || entry.semanticsAvailable !== false) {
    throw new Error('honesty: ui.agentMap has no canvas entry with semanticsAvailable:false')
  }
}
