import { buildUi, observe } from '../src/plugin.js'

export const RECEIPT_CONTRACT = 'snapdom.action-receipt/v1'
export const BASELINE_CONTRACT = 'snapdom.action-baseline/v1'

const DEFAULT_LIMITS = Object.freeze({
  changes: 24,
  actionability: 12,
  unobservable: 12,
})

// Privacy rules must not travel inside the portable baseline. Keep them in the realm
// that captured it and put only an opaque random handle on the JSON-safe object. A
// baseline crossing a reload/realm boundary therefore fails closed instead of exposing
// a dictionary-testable rule digest or silently comparing under a different policy.
const PRIVACY_POLICIES = new Map()
const MAX_PRIVACY_POLICIES = 256

function rememberPrivacy(privacy) {
  if (!privacy) return null
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const policyId = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  PRIVACY_POLICIES.set(policyId, privacy)
  while (PRIVACY_POLICIES.size > MAX_PRIVACY_POLICIES) {
    PRIVACY_POLICIES.delete(PRIVACY_POLICIES.keys().next().value)
  }
  return policyId
}

function positiveInt(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`receipt limit must be an integer between 0 and ${maximum}`)
  }
  return value
}

function normalizeLimits(limits = {}) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('limits must be an object')
  }
  if (Object.keys(limits).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) {
    throw new TypeError('limits supports only changes, actionability, and unobservable')
  }
  return {
    changes: positiveInt(limits.changes, DEFAULT_LIMITS.changes, 500),
    actionability: positiveInt(limits.actionability, DEFAULT_LIMITS.actionability, 200),
    unobservable: positiveInt(limits.unobservable, DEFAULT_LIMITS.unobservable, 500),
  }
}

function normalizePrivacy(privacy) {
  if (privacy === undefined || privacy === null) return undefined
  if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy) ||
      Object.keys(privacy).some((key) => key !== 'redact') || !Array.isArray(privacy.redact)) {
    throw new TypeError('privacy must be { redact: string[] }')
  }
  const redact = privacy.redact.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('privacy.redact entries must be non-empty strings')
    return value
  })
  if (!redact.length) throw new TypeError('privacy.redact must contain at least one rule')
  return { redact }
}

function normalizeExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).some((key) => key !== 'changed') ||
      typeof expected.changed !== 'boolean') {
    throw new TypeError('expected must be exactly { changed: boolean }')
  }
  return { changed: expected.changed }
}

function jsonSafe(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function projectRef(ref) {
  if (!ref || typeof ref !== 'object') return null
  const out = {}
  for (const key of [
    'id', 'kind', 'match', 'role', 'name', 'beforeName', 'beforeId', 'afterId',
    'sourceType', 'scope', 'detection', 'uncertainty', 'semanticsAvailable',
    'rasterAvailable',
  ]) {
    if (ref[key] !== undefined) out[key] = ref[key]
  }
  for (const key of ['bbox', 'before', 'after', 'coveredBy']) {
    if (ref[key] !== undefined) out[key] = jsonSafe(ref[key])
  }
  return out
}

function bounded(items, limit, project = projectRef) {
  const list = Array.isArray(items) ? items : []
  return {
    items: list.slice(0, limit).map(project).filter(Boolean),
    total: list.length,
    truncated: Math.max(0, list.length - limit),
  }
}

function publicPrivacy(privacy, applied) {
  const rulesActive = privacy?.redact?.length || 0
  return rulesActive ? { rulesActive, applied: applied === true } : { rulesActive: 0, applied: false }
}

function validateRoot(root) {
  if (!(root instanceof globalThis.Element) || !root.isConnected) {
    throw new TypeError('root must be a connected Element')
  }
}

function validateBaseline(baseline) {
  if (!baseline || baseline.contract !== BASELINE_CONTRACT || baseline.version !== 1 ||
      !baseline.checkpoint || baseline.checkpoint.version !== 2) {
    throw new TypeError(`baseline must be a ${BASELINE_CONTRACT} object`)
  }
}

function baselinePrivacy(baseline, suppliedPrivacy) {
  const rulesActive = baseline.privacy?.rulesActive || 0
  if (!rulesActive) {
    if (suppliedPrivacy !== undefined && suppliedPrivacy !== null) {
      throw new TypeError('receipt privacy must match the baseline privacy policy')
    }
    return undefined
  }
  const stored = baseline.privacy?.policyId && PRIVACY_POLICIES.get(baseline.privacy.policyId)
  if (!stored) throw new TypeError('baseline privacy policy is unavailable in this realm; capture a new baseline')
  if (suppliedPrivacy !== undefined) {
    const supplied = normalizePrivacy(suppliedPrivacy)
    if (JSON.stringify(supplied.redact) !== JSON.stringify(stored.redact)) {
      throw new TypeError('receipt privacy must match the baseline privacy policy')
    }
  }
  return stored
}

/**
 * Capture a portable, privacy-safe baseline for a later action receipt.
 * The returned object is JSON-safe by construction.
 */
export function createBaseline(root, options = {}) {
  validateRoot(root)
  const privacy = normalizePrivacy(options.privacy)
  const ui = buildUi(observe(root, { privacy }), { privacy })
  const baseline = {
    contract: BASELINE_CONTRACT,
    version: 1,
    checkpoint: ui.checkpoint(),
    privacy: {
      ...publicPrivacy(privacy, privacy ? ui.privacy?.rulesActive > 0 : false),
      ...(privacy ? { policyId: rememberPrivacy(privacy) } : {}),
    },
  }
  return jsonSafe(baseline)
}

/**
 * Produce a bounded, JSON-safe semantic action receipt.
 *
 * v1 intentionally supports only the universal `changed` postcondition. It does not
 * copy the companion assertion grammar. Its PASS/FAIL/UNKNOWN outcome is nested under
 * `postcondition`; `taskOutcome` is always NOT_ASSESSED so a generic DOM change cannot
 * be mistaken for successful user intent. When a negative conclusion is obscured by a
 * torn walk or an unreadable region, the postcondition outcome is UNKNOWN, never PASS.
 */
export function createReceipt(root, options = {}) {
  validateRoot(root)
  validateBaseline(options.baseline)
  const expected = normalizeExpected(options.expected)
  const privacy = baselinePrivacy(options.baseline, options.privacy)
  const limits = normalizeLimits(options.limits)
  const observation = observe(root, {
    previous: options.baseline.checkpoint,
    privacy,
  })
  const ui = buildUi(observation, { privacy })
  const torn = Number.isFinite(observation.torn) ? observation.torn : 0
  const changes = bounded(ui.changes, limits.changes)
  const becameCovered = bounded(ui.actionabilityDelta?.becameCovered, limits.actionability)
  const becameVisible = bounded(ui.actionabilityDelta?.becameVisible, limits.actionability)
  const unobservable = bounded(ui.unobservable, limits.unobservable)
  const observationUncertain = torn > 0 || unobservable.total > 0
  let outcome
  let reason
  if (torn > 0 || (ui.changed === false && observationUncertain)) {
    outcome = 'UNKNOWN'
    reason = torn > 0 ? 'capture torn during observation' : 'negative conclusion intersects an unobservable region'
  } else if (ui.changed === expected.changed) {
    outcome = 'PASS'
    reason = `changed is ${ui.changed}`
  } else {
    outcome = 'FAIL'
    reason = `expected changed ${expected.changed}, observed ${ui.changed}`
  }
  const receipt = {
    contract: RECEIPT_CONTRACT,
    version: 1,
    taskOutcome: 'NOT_ASSESSED',
    postcondition: {
      kind: 'changed',
      expected,
      outcome,
      reason,
    },
    observed: {
      changed: ui.changed === true,
      torn,
      changes,
      actionabilityDelta: { becameCovered, becameVisible },
      unobservable,
    },
    privacy: publicPrivacy(privacy, privacy ? ui.privacy?.rulesActive > 0 : false),
    limits,
  }
  return jsonSafe(receipt)
}
