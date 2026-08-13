/**
 * Noise suppression (§5). The "agent" preset must work unconfigured: running
 * animations, caret/focus artifacts, scrollbar/sub-pixel deltas, live clocks,
 * skeleton shimmers. The corpus is the judge of every rule here.
 * @module agent/noise
 */

/** @typedef {{
 *   ignore?: string[],
 *   ignoreAnimations?: boolean,
 *   normalizeWhitespace?: boolean,
 *   normalizeDynamicText?: boolean,
 *   geometryTolerance?: number,
 *   textRules?: Array<{selector: string, normalize: 'relative-time'|'clock'|'number'|((t: string) => string)}>,
 * }} NoiseRules */

const AGENT_PRESET = Object.freeze({
  ignore: ['[aria-busy="true"]', '[data-live-clock]', '.loading-shimmer', '.skeleton'],
  ignoreAnimations: true,
  normalizeWhitespace: true,
  normalizeDynamicText: true,
  geometryTolerance: 1,
  textRules: [],
})

/** @param {'agent'|'none'|NoiseRules|undefined} noise @returns {Required<NoiseRules>} */
export function resolveNoise(noise) {
  if (noise === 'none') return { ignore: [], ignoreAnimations: false, normalizeWhitespace: false, normalizeDynamicText: false, geometryTolerance: 0, textRules: [] }
  if (!noise || noise === 'agent') return { ...AGENT_PRESET }
  return {
    ignore: noise.ignore || AGENT_PRESET.ignore,
    ignoreAnimations: noise.ignoreAnimations !== false,
    normalizeWhitespace: noise.normalizeWhitespace !== false,
    normalizeDynamicText: noise.normalizeDynamicText !== false,
    geometryTolerance: noise.geometryTolerance ?? AGENT_PRESET.geometryTolerance,
    textRules: noise.textRules || [],
  }
}

// ── Text normalization ─────────────────────────────────────────────────────────
// Built-in generic pass (always on under the preset): live clocks and relative
// times are the single most common text-noise class; a changed "hace 3 segundos"
// is not a UI change an agent should react to.
const CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi
const REL_TIME_RE = /\b(?:hace\s+)?\d+\s*(?:s|sec|seconds?|segundos?|m|min|minutes?|minutos?|h|hours?|horas?|d|days?|días?|dias?)\s*(?:ago)?\b/gi

const NORMALIZERS = {
  'relative-time': (t) => t.replace(REL_TIME_RE, '⟨t⟩'),
  clock: (t) => t.replace(CLOCK_RE, '⟨clock⟩'),
  number: (t) => t.replace(/\d[\d.,]*/g, '⟨n⟩'),
}

/**
 * Normalize a node's text for signature purposes.
 * @param {string} text
 * @param {Element} el
 * @param {Required<NoiseRules>} rules
 * @returns {string}
 */
export function normalizeText(text, el, rules) {
  let out = rules.normalizeWhitespace ? text.replace(/\s+/g, ' ').trim() : text
  if (rules.normalizeDynamicText) {
    out = out.replace(CLOCK_RE, '⟨clock⟩')
    out = out.replace(REL_TIME_RE, '⟨t⟩')
  }
  for (const rule of rules.textRules) {
    try {
      if (el.matches(rule.selector)) {
        out = typeof rule.normalize === 'function' ? rule.normalize(out) : (NORMALIZERS[rule.normalize] || ((x) => x))(out)
      }
    } catch { }
  }
  return out
}

/** @param {Element} el @param {Required<NoiseRules>} rules @returns {boolean} */
export function isIgnored(el, rules) {
  for (const sel of rules.ignore) {
    try { if (el.matches(sel) || el.closest(sel)) return true } catch { }
  }
  return false
}

/**
 * Collect elements with RUNNING animations/transitions under root, plus the animated
 * property names per element — those properties are excluded from signatures while
 * the animation runs (a shimmer must not read as a style change).
 * @param {Element} root
 * @returns {Map<Element, Set<string>>}
 */
export function collectAnimatedProps(root) {
  const out = new Map()
  try {
    for (const anim of root.getAnimations?.({ subtree: true }) || []) {
      if (anim.playState !== 'running') continue
      const target = anim.effect?.target
      if (!target || target.nodeType !== 1) continue
      let props = out.get(target)
      if (!props) out.set(target, (props = new Set()))
      try {
        for (const frame of anim.effect.getKeyframes?.() || []) {
          for (const key of Object.keys(frame)) {
            if (key === 'offset' || key === 'easing' || key === 'composite' || key === 'computedOffset') continue
            props.add(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))
          }
        }
      } catch { props.add('*') }
      if (!props.size) props.add('*')
    }
  } catch { }
  return out
}
