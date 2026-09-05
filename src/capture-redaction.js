/** Opt-in clone redaction shared with the semantic reader for one capture. */
import { redactInputs } from '../vendor/snapdom/plugins/redact-inputs.js'
import { getPrivacyPolicy } from '../vendor/snapdom/plugins/privacy-policy.js'

// Source imports and generated sensor bundles must reject conflicting owners alike.
const OWNER = Symbol.for('snapdom-agent.capture-redactor.v1')
const policyIds = new Map()
const SELECTION_KEYS = ['types', 'autocomplete', 'selector', 'all', 'blocks', 'attributes']

export function createCaptureRedactor(options) {
  if (options === undefined) return null
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('captureRedaction must be a redactInputs options object')
  }
  const redactor = redactInputs(options)
  // Opaque realm-local identity, not a digest someone could use to guess selectors
  // containing private data. Masks change pixels, not which semantic values are omitted.
  const selection = JSON.stringify(SELECTION_KEYS.map(key => [key, options[key] ?? null]))
  if (!policyIds.has(selection)) {
    if (policyIds.size >= 64) policyIds.delete(policyIds.keys().next().value)
    policyIds.set(selection, [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join(''))
  }
  Object.defineProperty(redactor, 'capturePolicyId', { value: policyIds.get(selection) })
  return redactor
}

export function beginCaptureRedaction(redactor, ctx) {
  if (!redactor) return
  if (ctx[OWNER] && ctx[OWNER] !== redactor) {
    throw new Error('Only one captureRedaction configuration may be attached to a capture')
  }
  ctx[OWNER] = redactor
  redactor.beforeSnap(ctx)
}

export function assertCaptureReader(redactor, ctx) {
  if (ctx[OWNER] && ctx[OWNER] !== redactor) {
    throw new Error('captureRedaction cannot be combined with an unconfigured semantic reader; use separate captures')
  }
}

export function assertCaptureBaseline(previous, redactor) {
  if (!previous) return
  if ((previous.captureRedactionPolicy ?? null) !== (redactor?.capturePolicyId ?? null)) {
    throw new Error('captureRedaction policy changed or belongs to another realm; omit previous to establish a new baseline')
  }
}

export const capturePrivacyPolicy = getPrivacyPolicy
export const attribute = (el, name, policy) => policy ? policy.attribute(el, name) : el.getAttribute(name)
