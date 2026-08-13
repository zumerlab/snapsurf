import { observe } from '../../../src/plugin.js'

export const SENSOR_REPORT_CONTRACT = 'snapdom.sensor/v1'
export const SENSOR_PLUGIN_NAME = 'snapdom-sensor'

const REPORT_SLOT = Symbol('snapdom.sensor.report')
const DEFAULT_LIMITS = Object.freeze({
  changes: 24,
  actionability: 12,
  blindSpots: 12,
  stringLength: 200,
})

const SNAPSHOT_NODE_FIELDS = [
  'id', 'parentId', 'tag', 'role', 'ordinal', 'subtreeHash', 'textHash',
  'rawTextHash', 'stateHash', 'styleHash', 'geometryHash', 'spHash',
  'ancestorFp', 'textFp', 'nameFp', 'testid', 'name', 'text', 'interactive',
  'visible', 'covered', 'geometryAnimating', 'semanticsAvailable', 'sourceType',
  'rasterAvailable',
]

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertOnlyKeys(value, allowed, label) {
  assertObject(value, label)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length) throw new TypeError(`${label} does not support ${unexpected.join(', ')}`)
}

function normalizePrivacy(privacy) {
  if (privacy === undefined || privacy === null) return undefined
  if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy) ||
      Object.keys(privacy).some((key) => key !== 'redact') || !Array.isArray(privacy.redact)) {
    throw new TypeError('privacy must be { redact: string[] }')
  }
  const redact = privacy.redact.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError('privacy.redact entries must be non-empty strings')
    }
    return value
  })
  if (!redact.length) throw new TypeError('privacy.redact must contain at least one rule')
  return { redact }
}

function boundedInt(value, fallback, maximum, label) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 0 and ${maximum}`)
  }
  return value
}

function normalizeLimits(limits = {}) {
  assertOnlyKeys(limits, ['changes', 'actionability', 'blindSpots', 'stringLength'], 'limits')
  return Object.freeze({
    changes: boundedInt(limits.changes, DEFAULT_LIMITS.changes, 500, 'limits.changes'),
    actionability: boundedInt(limits.actionability, DEFAULT_LIMITS.actionability, 200, 'limits.actionability'),
    blindSpots: boundedInt(limits.blindSpots, DEFAULT_LIMITS.blindSpots, 500, 'limits.blindSpots'),
    stringLength: boundedInt(limits.stringLength, DEFAULT_LIMITS.stringLength, 2_000, 'limits.stringLength'),
  })
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item)
  return out
}

function isElement(value) {
  return !!(value?.nodeType === 1 &&
    typeof value.getBoundingClientRect === 'function' &&
    value.ownerDocument?.defaultView)
}

function describeRootShape(root) {
  const shape = { tag: typeof root.tagName === 'string' ? root.tagName.toLowerCase() : '' }
  const testid = typeof root.getAttribute === 'function' ? root.getAttribute('data-testid') : null
  if (testid) shape.testid = testid
  return shape
}

/**
 * A baseline keyed to a live Element cannot survive that element's removal. This scan
 * makes the loss loud: a NEW root observed while a previously tracked root is gone
 * (disconnected or collected) is reported as HISTORY_NOT_CARRIED instead of an
 * indistinguishable first capture.
 */
function evaluateContinuity(root, tracked) {
  const shape = describeRootShape(root)
  const kept = []
  let disconnected = 0
  let possibleRemount = false
  let alreadyTracked = false
  for (const entry of tracked) {
    const prior = entry.ref.deref()
    if (prior === root) {
      alreadyTracked = true
      kept.push(entry)
      continue
    }
    const gone = !prior || !prior.isConnected
    if (prior) kept.push(entry)
    if (!gone) continue
    disconnected += 1
    if (entry.shape.tag === shape.tag && entry.shape.testid === shape.testid) {
      possibleRemount = true
    }
  }
  let continuity
  if (alreadyTracked || (!disconnected && !kept.length)) {
    continuity = { status: 'ESTABLISHED' }
  } else if (disconnected > 0) {
    continuity = { status: 'HISTORY_NOT_CARRIED', disconnectedPriorRoots: disconnected }
    if (possibleRemount) continuity.possibleRemount = true
  } else {
    continuity = { status: 'ESTABLISHED' }
  }
  return { shape, kept, continuity }
}

function detachSnapshot(snapshot) {
  const nodes = new Map()
  for (const [id, node] of snapshot.nodes) {
    const copy = {}
    for (const key of SNAPSHOT_NODE_FIELDS) {
      if (node[key] !== undefined) copy[key] = node[key]
    }
    copy.childIds = [...(node.childIds || [])]
    if (node.rel) copy.rel = [...node.rel]
    if (node.bbox) copy.bbox = [...node.bbox]
    if (node.state) copy.state = cloneValue(node.state)
    if (node.coveredBy) copy.coveredBy = cloneValue(node.coveredBy)
    if (node.valueChangeUncertainty) {
      copy.valueChangeUncertainty = cloneValue(node.valueChangeUncertainty)
    }
    nodes.set(id, copy)
  }
  return {
    rootId: snapshot.rootId,
    rootHash: snapshot.rootHash,
    nodes,
  }
}

function addString(out, key, value, limit) {
  if (typeof value !== 'string' || !value) return
  if (value.length <= limit) {
    out[key] = value
    return
  }
  out[key] = value.slice(0, limit)
  out[`${key}Truncated`] = value.length - limit
}

function projectCoveredBy(value, limit) {
  if (!value || typeof value !== 'object') return undefined
  const out = { externalToScope: !value.id }
  for (const key of ['id', 'role']) if (value[key] !== undefined) out[key] = value[key]
  if (value.id) {
    addString(out, 'name', value.name, limit)
    addString(out, 'label', value.label, limit)
  }
  return out
}

function projectNode(snapshot, id, limit) {
  if (!id) return undefined
  const node = snapshot?.nodes.get(id)
  if (!node) return undefined
  const out = { id: node.id, role: node.role }
  addString(out, 'name', node.name, limit)
  addString(out, 'text', node.text, limit)
  addString(out, 'testid', node.testid, limit)
  if (node.state) out.state = cloneValue(node.state)
  if (node.bbox) out.bbox = [...node.bbox]
  out.visible = node.visible !== false
  out.covered = !!node.covered
  if (node.coveredBy) out.coveredBy = projectCoveredBy(node.coveredBy, limit)
  return out
}

function projectChange(change, before, after, limit) {
  const out = {}
  for (const key of ['id', 'kind', 'match', 'beforeId', 'afterId', 'role']) {
    if (change[key] !== undefined) out[key] = change[key]
  }
  if (Array.isArray(change.matchedBy)) out.matchedBy = [...change.matchedBy]
  addString(out, 'name', change.name, limit)
  addString(out, 'beforeName', change.beforeName, limit)
  const beforeId = change.beforeId || (change.kind === 'added' ? null : change.id)
  const afterId = change.afterId || (change.kind === 'removed' ? null : change.id)
  const beforeNode = projectNode(before, beforeId, limit)
  const afterNode = projectNode(after, afterId, limit) ||
    (change.match === 'ambiguous' ? projectNode(after, change.beforeId, limit) : undefined)
  if (beforeNode) out.beforeNode = beforeNode
  if (afterNode) out.afterNode = afterNode
  return out
}

function projectActionability(ref, after, limit) {
  if (!ref || typeof ref !== 'object') return null
  const out = projectNode(after, ref.id, limit) || { id: ref.id, role: ref.role }
  for (const key of ['match', 'beforeId', 'afterId']) {
    if (ref[key] !== undefined) out[key] = ref[key]
  }
  addString(out, 'name', ref.name, limit)
  if (ref.coveredBy) out.coveredBy = projectCoveredBy(ref.coveredBy, limit)
  return out
}

function projectBlindSpot(node, limit) {
  const out = { id: node.id }
  for (const key of [
    'role', 'sourceType', 'scope', 'detection', 'uncertainty',
    'semanticsAvailable',
  ]) {
    const value = node.valueChangeUncertainty?.[key] ?? node[key]
    if (value !== undefined) out[key] = value
  }
  if (node.bbox) out.bbox = [...node.bbox]
  addString(out, 'name', node.name, limit)
  out.rasterFallback = node.rasterAvailable
    ? 'AVAILABLE_FROM_SNAPDOM_CAPTURE'
    : 'UNAVAILABLE_OR_UNKNOWN'
  return out
}

function collectBlindSpots(snapshot) {
  const list = []
  for (const node of snapshot.nodes.values()) {
    if (node.semanticsAvailable === false) list.push(node)
    if (node.valueChangeUncertainty) list.push(node)
  }
  return list
}

function bounded(items, limit, project) {
  const list = Array.isArray(items) ? items : []
  return {
    items: list.slice(0, limit).map(project).filter(Boolean),
    total: list.length,
    truncated: Math.max(0, list.length - limit),
  }
}

function emptyBounded() {
  return { items: [], total: 0, truncated: 0 }
}

function baseReport({ status, after, limits, privacy, continuity, drift }) {
  const blindSpots = bounded(
    collectBlindSpots(after),
    limits.blindSpots,
    (node) => projectBlindSpot(node, limits.stringLength),
  )
  blindSpots.exhaustive = false
  const uncertaintyReasons = blindSpots.total ? ['known-semantic-blind-spots'] : []
  if (continuity?.status === 'HISTORY_NOT_CARRIED') {
    uncertaintyReasons.push('baseline-history-not-carried')
  }
  if (drift?.unwatched) {
    uncertaintyReasons.push('capture-drift-unwatched')
  } else if (drift?.mutations > 0) {
    uncertaintyReasons.push('mutated-during-capture-prep')
  }
  if (drift?.shadowIncomplete) {
    uncertaintyReasons.push('shadow-drift-partially-unwatched')
  }
  return {
    contract: SENSOR_REPORT_CONTRACT,
    version: 1,
    taskAssessment: { status: 'NOT_ASSESSED' },
    causality: { relation: 'CAPTURE_SEQUENCE', status: 'NOT_ESTABLISHED' },
    observation: {
      status,
      semanticDelta: emptyBounded(),
      renderedActionabilityDelta: {
        model: 'VISIBILITY_AND_CENTER_HIT_TEST',
        lost: emptyBounded(),
        gained: emptyBounded(),
      },
    },
    coverage: {
      source: 'SNAPDOM_AFTER_CLONE_FRAME',
      scope: 'SNAPDOM_CAPTURE_ROOT',
      engineFrame: {
        clonePrepared: true,
        nodeMapApplied: true,
        styleCacheApplied: true,
        driftWatch: drift?.unwatched ? 'UNWATCHED' : 'NET_OF_ENGINE_PREP',
        ...(drift?.mutations > 0 ? { mutationsDuringPrep: drift.mutations } : {}),
      },
      knownSemanticBlindSpots: blindSpots,
    },
    uncertainty: {
      reasons: uncertaintyReasons,
    },
    privacy: {
      rulesActive: privacy?.redact?.length || 0,
      literalRedaction: privacy ? 'APPLIED_TO_SENSOR_REPORT' : 'OFF',
      snapdomSvg: 'OUTSIDE_SENSOR_REPORT',
      hostEgress: 'OUTSIDE_SENSOR_CONTROL',
    },
    localState: {
      priorState: 'OPAQUE_IN_MEMORY',
      checkpointEncoding: 'NOT_USED',
      nodesAfter: after.nodes.size,
      rootContinuity: continuity ? cloneValue(continuity) : { status: 'CONTINUOUS' },
    },
    visual: {
      svg: 'CAPTURED_BY_SNAPDOM',
      raster: 'AVAILABLE_ON_DEMAND_FROM_SNAPDOM_RESULT',
    },
    limits: { ...limits },
  }
}

function buildReport({ previous, observation, limits, privacy, continuity, drift }) {
  const after = detachSnapshot(observation.snapshot)
  if (!previous) {
    return {
      report: baseReport({ status: 'BASELINE_ESTABLISHED', after, limits, privacy, continuity, drift }),
      snapshot: after,
    }
  }

  const diff = observation.diff || { changes: [], actionabilityDelta: {} }
  const report = baseReport({ status: 'NO_SUPPORTED_DELTA_DETECTED', after, limits, privacy, continuity, drift })
  // The bounded invariant (items + truncated = total) holds over the SIGNAL list;
  // folded wrapper changes are counted separately and explicitly, never silently.
  const allChanges = Array.isArray(diff.changes) ? diff.changes : []
  const signalChanges = allChanges.filter((change) => !change.folded)
  const changes = bounded(
    signalChanges,
    limits.changes,
    (change) => projectChange(change, previous, after, limits.stringLength),
  )
  if (diff.foldedWrappers) changes.foldedWrappers = diff.foldedWrappers
  if (diff.geometryOnly) changes.geometryOnly = true
  const lost = bounded(
    diff.actionabilityDelta?.becameCovered,
    limits.actionability,
    (ref) => projectActionability(ref, after, limits.stringLength),
  )
  const gained = bounded(
    diff.actionabilityDelta?.becameVisible,
    limits.actionability,
    (ref) => projectActionability(ref, after, limits.stringLength),
  )
  const deltaDetected = allChanges.length > 0 || lost.total > 0 || gained.total > 0
  const blind = report.coverage.knownSemanticBlindSpots.total > 0

  report.observation.status = deltaDetected
    ? 'DELTA_DETECTED'
    : (blind ? 'INDETERMINATE' : 'NO_SUPPORTED_DELTA_DETECTED')
  report.observation.semanticDelta = changes
  report.observation.renderedActionabilityDelta.lost = lost
  report.observation.renderedActionabilityDelta.gained = gained
  report.localState.nodesBefore = previous.nodes.size

  return { report, snapshot: after }
}

function validateFrame(ctx) {
  if (!isElement(ctx?.element) || !ctx.element.isConnected) {
    throw new TypeError('[snapdom-sensor] afterClone requires a connected capture root')
  }
  if (!isElement(ctx.clone) ||
      !(ctx.nodeMap instanceof Map) ||
      typeof ctx.styleCache?.get !== 'function' ||
      !ctx.options || typeof ctx.options !== 'object') {
    const error = new Error('[snapdom-sensor] unsupported SnapDOM afterClone frame')
    error.code = 'SNAPDOM_SENSOR_UNSUPPORTED_FRAME'
    throw error
  }
}

function validateExportOptions(options) {
  if (options === undefined || options === null) return
  for (const key of ['expected', 'outcome', 'postcondition', 'assert']) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(`toSensor does not accept ${key}; it describes effects, not task success`)
    }
  }
}

/**
 * Stateful SnapDOM plugin. Reuse one instance across sequential captures of the same
 * scoped root. SnapDOM performs its normal capture; this plugin adds a bounded semantic
 * report without accepting an expected outcome or deciding whether a task succeeded.
 */
export function sensor(options = {}) {
  assertOnlyKeys(options, ['privacy', 'noise', 'limits'], 'sensor options')
  let privacy = normalizePrivacy(options.privacy)
  let noise = options.noise
  const limits = normalizeLimits(options.limits)
  let baselines = new WeakMap()
  let trackedRoots = []
  let driftWatch = null
  let disposed = false

  const dropDriftWatch = () => {
    if (driftWatch) {
      driftWatch.observer.disconnect()
      driftWatch = null
    }
  }

  const snapdomInternalNode = (node) => !!(node && node.nodeType === 1 && (
    (typeof node.id === 'string' && node.id.startsWith('snapdom-')) ||
    (typeof node.hasAttribute === 'function' && node.hasAttribute('data-snapdom-internal'))))

  const armDriftWatch = (element) => {
    dropDriftWatch()
    if (!isElement(element) || typeof MutationObserver !== 'function') return
    const watch = { element, records: [], shadowIncomplete: false }
    watch.observer = new MutationObserver((records) => { watch.records.push(...records) })
    const options = {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeOldValue: true, characterDataOldValue: true,
    }
    watch.observer.observe(element, options)
    // The walk reads the composed tree, so open shadow roots inside the scope are part
    // of the observed surface — but MutationObserver does not cross shadow boundaries.
    // Watch them explicitly (bounded); past the bound the gap is declared, not silent.
    let budget = 100
    const visitShadow = (shadowRoot) => {
      if (watch.shadowIncomplete) return
      if (budget-- <= 0) { watch.shadowIncomplete = true; return }
      watch.observer.observe(shadowRoot, options)
      for (const el of shadowRoot.querySelectorAll('*')) {
        if (el.shadowRoot) visitShadow(el.shadowRoot)
        if (watch.shadowIncomplete) return
      }
    }
    try {
      if (element.shadowRoot) visitShadow(element.shadowRoot)
      for (const el of element.querySelectorAll('*')) {
        if (el.shadowRoot) visitShadow(el.shadowRoot)
        if (watch.shadowIncomplete) break
      }
    } catch { watch.shadowIncomplete = true }
    driftWatch = watch
  }

  /**
   * NET drift only: SnapDOM's own prep (line-clamp measurement, sandbox probes) mutates
   * and restores before afterClone runs, so anything that nets to zero by then is the
   * engine, not the page. Returns {unwatched:true} when this capture had no usable
   * watch — declared as uncertainty, never a silent zero.
   */
  const consumeDriftWatch = (element) => {
    if (!driftWatch) return { unwatched: true }
    const watch = driftWatch
    const records = [...watch.records, ...watch.observer.takeRecords()]
    dropDriftWatch()
    if (watch.element !== element) return { unwatched: true }
    let net = 0
    const childListByTarget = new Map()
    for (const record of records) {
      if (record.type === 'attributes') {
        if (/^data-snapdom/.test(record.attributeName || '')) continue
        if (snapdomInternalNode(record.target)) continue
        const current = typeof record.target.getAttribute === 'function'
          ? record.target.getAttribute(record.attributeName) : null
        if (current !== record.oldValue) net++
        continue
      }
      if (record.type === 'characterData') {
        const current = 'data' in record.target ? record.target.data : null
        if (current !== record.oldValue) net++
        continue
      }
      const touched = [...record.addedNodes, ...record.removedNodes]
      if (touched.length && touched.every(snapdomInternalNode)) continue
      if (!childListByTarget.has(record.target)) {
        childListByTarget.set(record.target, {
          removedText: [...record.removedNodes].map((n) => n.textContent || '').join(''),
          sawRemoval: record.removedNodes.length > 0,
        })
      }
    }
    for (const [target, first] of childListByTarget) {
      let finalText = null
      try { finalText = target.textContent || '' } catch { /* detached exotic node */ }
      // mutate-then-restore (engine prep) nets to zero: the earliest removal's text is
      // back in place by afterClone. Anything else is real drift.
      if (first.sawRemoval && finalText !== null && finalText === first.removedText) continue
      net++
    }
    return { mutations: net, shadowIncomplete: watch.shadowIncomplete }
  }

  const plugin = {
    name: SENSOR_PLUGIN_NAME,

    beforeSnap(ctx) {
      if (ctx?.options?.burst === true) {
        throw new TypeError('[snapdom-sensor] burst:true is incompatible with fresh sensor frames')
      }
      // The clone is prepared asynchronously: the live DOM can mutate between here and
      // afterClone, making the walk read post-mutation state while the SVG shows
      // pre-mutation pixels. Watch the scope so that drift is DECLARED, never silent.
      // (Records accumulate in the observer callback: awaited hooks create microtask
      // checkpoints that deliver the queue before afterClone can takeRecords().)
      armDriftWatch(ctx?.element)
    },

    afterClone(ctx) {
      if (disposed) { dropDriftWatch(); throw new Error('[snapdom-sensor] plugin is disposed') }
      // Consume the watch FIRST: every exit from this hook (validation throw, shared
      // report slot) must leave no armed observer behind.
      const drift = consumeDriftWatch(ctx?.element)
      validateFrame(ctx)
      if (ctx.options[REPORT_SLOT]) return

      const current = baselines.get(ctx.element)
      const generation = current?.generation || 0
      let continuity = { status: 'CONTINUOUS' }
      let rootShape = null
      if (!current) {
        const scan = evaluateContinuity(ctx.element, trackedRoots)
        trackedRoots = scan.kept
        continuity = scan.continuity
        rootShape = scan.shape
      }
      const observation = observe(ctx.element, {
        previous: current?.snapshot,
        privacy,
        noise,
        strictScope: true,
        engineFrame: {
          clone: ctx.clone,
          nodeMap: ctx.nodeMap,
          styleCache: ctx.styleCache,
        },
      })
      const built = buildReport({
        previous: current?.snapshot,
        observation,
        limits,
        privacy,
        continuity,
        drift,
      })
      const pending = {
        root: ctx.element,
        rootShape,
        expectedGeneration: generation,
        nextGeneration: generation + 1,
        snapshot: built.snapshot,
        report: built.report,
        committed: false,
      }
      Object.defineProperty(ctx.options, REPORT_SLOT, {
        value: pending,
        enumerable: true,
        configurable: true,
      })
    },

    defineExports(ctx) {
      const pending = ctx?.[REPORT_SLOT]
      if (!pending) {
        throw new Error('[snapdom-sensor] capture completed without a sensor frame')
      }
      if (!pending.committed) {
        const currentGeneration = baselines.get(pending.root)?.generation || 0
        if (currentGeneration !== pending.expectedGeneration) {
          const error = new Error('[snapdom-sensor] concurrent captures reused one plugin for the same root')
          error.code = 'SNAPDOM_SENSOR_CONCURRENT_CAPTURE'
          throw error
        }
        baselines.set(pending.root, {
          generation: pending.nextGeneration,
          snapshot: pending.snapshot,
        })
        if (pending.rootShape &&
            !trackedRoots.some((entry) => entry.ref.deref() === pending.root)) {
          trackedRoots.push({ ref: new WeakRef(pending.root), shape: pending.rootShape })
        }
        pending.committed = true
      }
      const capturedReport = cloneValue(pending.report)
      return {
        sensor: async (_exportContext, exportOptions) => {
          if (disposed) throw new Error('[snapdom-sensor] plugin is disposed')
          validateExportOptions(exportOptions)
          return cloneValue(capturedReport)
        },
      }
    },

    reset(root) {
      if (disposed) throw new Error('[snapdom-sensor] plugin is disposed')
      if (root === undefined) {
        baselines = new WeakMap()
        trackedRoots = []
        return
      }
      if (!isElement(root)) {
        throw new TypeError('reset root must be an Element')
      }
      baselines.delete(root)
      trackedRoots = trackedRoots.filter((entry) => entry.ref.deref() !== root)
    },

    dispose() {
      if (disposed) return
      disposed = true
      dropDriftWatch()
      baselines = new WeakMap()
      trackedRoots = []
      privacy = null
      noise = null
    },
  }

  return Object.freeze(plugin)
}
