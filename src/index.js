/**
 * snapDOM Agent (working name) — post-layout change oracle for in-page AI agents.
 * PRIVATE, PROPRIETARY, NEVER PUBLISHED. See package.json / LICENSE.
 *
 * This package is a **private plugin layer on top of snapdom**, not a parallel library:
 * every capability arrives through the plugin system v2, and the semantic visitor is a
 * lifecycle hook on snapdom's own capture walk (`src/plugin.js`).
 *
 * Two equivalent front doors, one implementation:
 *
 *   // 1 — the plugin, for callers who already capture
 *   const result = await snapdom(el, { plugins: [agentOracle({ previous })] })
 *   await result.toChanges(); await result.toAgentMap(); await result.toPng()
 *
 *   // 2 — the ergonomic wrapper, which runs exactly that
 *   const ui = await agent.inspect(el, { previous })
 *   ui.changes · ui.agentMap · ui.context · ui.checkpoint() · ui.rasterize()
 *
 * Core is untouched and never depends on this package.
 * @module agent
 */
import { snapdom } from '../vendor/snapdom/dist/snapdom.mjs'
import { agentOracle, probeCapabilities, getLastSnapshot } from './plugin.js'
import { MATCH_ELEMENTS } from './query.js'

export { agentOracle }

/**
 * Inspect a live subtree: identity, signatures, occlusion, context, Set-of-Mark, and
 * (with `previous`) what changed.
 *
 * Runs one snapdom capture with the oracle plugin attached, so the semantic snapshot
 * and the rendered pixels describe the same instant by construction (§8) — there is no
 * second walk to drift against. `capture` forwards options to snapdom itself.
 *
 * @param {Element} root
 * @param {{previous?: object, noise?: 'agent'|'none'|object, excludeText?: boolean,
 *          privacy?: { redact?: string[] }, capture?: object}} [options]
 */
export async function inspect(root, options = {}) {
  if (!root || root.nodeType !== 1) throw new Error('[agent.inspect] element required')
  const plugin = agentOracle(options)
  const capture = options.capture || {}
  const callerPlugins = Array.isArray(capture.plugins)
    ? capture.plugins
    : (capture.plugins ? [capture.plugins] : [])
  // `capture` is the caller's snapdom configuration, so composing the oracle must not
  // silently discard plugins they already installed (exporters, instrumentation, etc.).
  const result = await snapdom(root, { ...capture, plugins: [...callerPlugins, plugin] })
  const ui = plugin.ui
  ui.capabilities = await probeCapabilities()
  /**
   * The render output of the very same capture (§8: one walk, two outputs). With no
   * argument the image is already paid for and shares this instant; with a target it is
   * a fresh capture of that region — the §9 answer for a `semanticsAvailable: false`
   * node, where the honest move is to rasterize the region rather than the page.
   * @param {{id: string}} [target] - a query match
   */
  ui.rasterize = async (target) => {
    if (!target) return result
    const el = resolve(target)
    if (!el) throw new Error('[agent.rasterize] target no longer in the DOM')
    return snapdom(el, options.capture || {})
  }
  return ui
}

/**
 * Resolve a snapshot match (or node id) to the live element — or null if it left
 * the DOM. Action execution is out of scope; this is the whole bridge.
 * @param {{id: string}|string} match
 * @returns {Element|null}
 */
export function resolve(match) {
  const id = typeof match === 'string' ? match : match && match.id
  if (!id) return null
  // A match carries its own elements table (immune to later inspections); bare ids
  // fall back to the most recent walk.
  const last = getLastSnapshot()
  const table = (match && match[MATCH_ELEMENTS]) || (last && last.elements)
  const el = table && table.get(id)
  return el && el.isConnected ? el : null
}

export const agent = { inspect, resolve, agentOracle }
export default agent
