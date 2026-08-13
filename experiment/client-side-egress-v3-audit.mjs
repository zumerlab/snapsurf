#!/usr/bin/env node
/** Independently re-read and validate retained client-side-egress-v3 bodies. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER = join(ROOT, 'experiment', 'client-side-egress-v3.mjs')
const RESULT = join(ROOT, 'experiment', 'results', 'client-side-egress-v3.json')
const ARCHIVE = join(ROOT, 'experiment', 'results', 'client-side-egress-v3.artifacts.json.gz')
const OUTPUT = join(ROOT, 'experiment', 'results', 'client-side-egress-v3.directional-audit.json')
const CHECK = process.argv.includes('--check')

const [runnerBytes, resultBytes, archiveBytes] = await Promise.all([
  readFile(RUNNER),
  readFile(RESULT),
  readFile(ARCHIVE),
])
const result = JSON.parse(resultBytes)
const archive = JSON.parse(gunzipSync(archiveBytes))
const bodies = new Map()
for (const entry of archive.bodies || []) {
  if (bodies.has(entry.id)) throw new Error(`duplicate archived body ${entry.id}`)
  if (Buffer.byteLength(entry.body, 'utf8') !== entry.byteLength || sha256(entry.body) !== entry.sha256) {
    throw new Error(`archived body integrity failed for ${entry.id}`)
  }
  bodies.set(entry.id, entry)
}
const used = new Set()

const primaryTrials = result.primary.trials.map((trial) => {
  const ariaPre = body(trial.aria.baseline.artifact)
  const ariaPost = body(trial.aria.post.artifact)
  const baseline = JSON.parse(body(trial.receipt.baseline.artifact))
  const receipt = JSON.parse(body(trial.receipt.post.artifact))
  const aria = ariaContract(ariaPre, ariaPost)
  const sdkReceipt = receiptContract(baseline, receipt, result.receiptLimits)
  const oracle = oracleContract(trial.oracle, trial.rowCount)
  const recordedMetricsExact =
    trial.aria.baseline.bytes === Buffer.byteLength(ariaPre, 'utf8') &&
    trial.aria.post.bytes === Buffer.byteLength(ariaPost, 'utf8') &&
    trial.receipt.baseline.bytes === Buffer.byteLength(JSON.stringify(baseline), 'utf8') &&
    trial.receipt.post.bytes === Buffer.byteLength(JSON.stringify(receipt), 'utf8') &&
    trial.aria.cycle.bytes === trial.aria.baseline.bytes + trial.aria.post.bytes &&
    trial.receipt.cycle.bytes === trial.receipt.baseline.bytes + trial.receipt.post.bytes
  return {
    id: trial.id,
    rowCount: trial.rowCount,
    rep: trial.rep,
    aria,
    receipt: sdkReceipt,
    oracle,
    recordedMetricsExact,
  }
})

const uncertaintyTrials = result.uncertaintyBoundary.trials.map((trial) => {
  const baseline = JSON.parse(body(trial.receipt.baseline.artifact))
  const receipt = JSON.parse(body(trial.receipt.post.artifact))
  const baselineValid = baseline.contract === 'snapdom.action-baseline/v1' &&
    baseline.version === 1 && baseline.checkpoint?.version === 2
  const bounded = boundedConsistent(receipt.observed?.unobservable)
  const totalExact = receipt.observed?.unobservable?.total === trial.oracle.totalRegions
  const itemCapExact = receipt.observed?.unobservable?.items?.length ===
    Math.min(trial.oracle.totalRegions, result.receiptLimits.unobservable)
  const truncationExact = receipt.observed?.unobservable?.truncated ===
    Math.max(0, trial.oracle.totalRegions - result.receiptLimits.unobservable)
  const outcomeExact = receipt.postcondition?.outcome === (trial.regionCount === 0 ? 'PASS' : 'UNKNOWN')
  const contractExact = receipt.contract === 'snapdom.action-receipt/v1' && receipt.version === 1 &&
    receipt.taskOutcome === 'NOT_ASSESSED' && receipt.postcondition?.kind === 'changed' &&
    receipt.postcondition?.expected?.changed === false && receipt.observed?.changed === false &&
    JSON.stringify(receipt.limits) === JSON.stringify(result.receiptLimits)
  const recordedMetricsExact =
    trial.receipt.baseline.bytes === Buffer.byteLength(JSON.stringify(baseline), 'utf8') &&
    trial.receipt.post.bytes === Buffer.byteLength(JSON.stringify(receipt), 'utf8') &&
    trial.receipt.cycle.bytes === trial.receipt.baseline.bytes + trial.receipt.post.bytes
  return {
    id: trial.id,
    regionCount: trial.regionCount,
    rep: trial.rep,
    baselineValid,
    contractExact,
    bounded,
    totalExact,
    itemCapExact,
    truncationExact,
    outcomeExact,
    recordedMetricsExact,
  }
})

const integrity = {
  sourceRunnerSha256: sha256(runnerBytes),
  sourceResultSha256: sha256(resultBytes),
  sourceArchiveSha256: sha256(archiveBytes),
  runnerMatchesResult: sha256(runnerBytes) === result.provenance.runnerSha256,
  archiveMatchesResult: sha256(archiveBytes) === result.artifactArchive.sha256 &&
    archiveBytes.byteLength === result.artifactArchive.byteLength,
  archiveBodyCountMatchesResult: bodies.size === result.artifactArchive.bodyCount,
  allArchivedBodiesUsedExactlyByReference: used.size === bodies.size && [...bodies.keys()].every((id) => used.has(id)),
  primaryTrials: primaryTrials.length,
  expectedPrimaryTrials: result.primary.rowScales.length * result.primary.repetitions,
  uncertaintyTrials: uncertaintyTrials.length,
  expectedUncertaintyTrials: result.uncertaintyBoundary.regionScales.length * result.uncertaintyBoundary.repetitions,
  allAriaDirectionalContractsExact: primaryTrials.every((trial) => trial.aria.exactPrePost),
  allReceiptDirectionalContractsExact: primaryTrials.every((trial) => trial.receipt.exactPrePost),
  allPrimitiveOraclesExact: primaryTrials.every((trial) => trial.oracle),
  allPrimaryMetricsExact: primaryTrials.every((trial) => trial.recordedMetricsExact),
  allUncertaintyBaselinesValid: uncertaintyTrials.every((trial) => trial.baselineValid),
  allUncertaintyContractsExact: uncertaintyTrials.every((trial) => trial.contractExact),
  allUncertaintyBoundsExact: uncertaintyTrials.every((trial) =>
    trial.bounded && trial.totalExact && trial.itemCapExact && trial.truncationExact),
  allUncertaintyOutcomesExact: uncertaintyTrials.every((trial) => trial.outcomeExact),
  allUncertaintyMetricsExact: uncertaintyTrials.every((trial) => trial.recordedMetricsExact),
  taskOutcomeAlwaysNotAssessed: primaryTrials.every((trial) => trial.receipt.checks.taskOutcomeNotAssessed) &&
    uncertaintyTrials.every((trial) => trial.contractExact),
}

const checks = {
  runnerMatchesResult: integrity.runnerMatchesResult,
  archiveMatchesResult: integrity.archiveMatchesResult,
  archiveBodyCountMatchesResult: integrity.archiveBodyCountMatchesResult,
  allArchivedBodiesUsedExactlyByReference: integrity.allArchivedBodiesUsedExactlyByReference,
  primaryTrialCount: integrity.primaryTrials === integrity.expectedPrimaryTrials,
  uncertaintyTrialCount: integrity.uncertaintyTrials === integrity.expectedUncertaintyTrials,
  allAriaDirectionalContractsExact: integrity.allAriaDirectionalContractsExact,
  allReceiptDirectionalContractsExact: integrity.allReceiptDirectionalContractsExact,
  allPrimitiveOraclesExact: integrity.allPrimitiveOraclesExact,
  allPrimaryMetricsExact: integrity.allPrimaryMetricsExact,
  allUncertaintyBaselinesValid: integrity.allUncertaintyBaselinesValid,
  allUncertaintyContractsExact: integrity.allUncertaintyContractsExact,
  allUncertaintyBoundsExact: integrity.allUncertaintyBoundsExact,
  allUncertaintyOutcomesExact: integrity.allUncertaintyOutcomesExact,
  allUncertaintyMetricsExact: integrity.allUncertaintyMetricsExact,
  taskOutcomeAlwaysNotAssessed: integrity.taskOutcomeAlwaysNotAssessed,
}
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name)
if (failed.length) throw new Error(`v3 audit failed (${failed.join(', ')}): ${JSON.stringify(integrity)}`)

const output = {
  schema: 1,
  classification: 'read-only independent directional and integrity audit of retained client-side-egress-v3 evidence bodies',
  question: 'Do retained bodies prove the exact authored transition, official nested receipt semantics, explicit caps/truncation, and uncertainty outcomes in the correct direction?',
  primaryTrials,
  uncertaintyTrials,
  integrity,
  caveats: [
    'This audit validates retained synthetic evidence and arithmetic; it does not establish production behavior or commercial value.',
    'ARIA remains a whole-root full-state comparator, not a best directed host verifier.',
  ],
}
const outputBytes = `${JSON.stringify(output, null, 2)}\n`
if (CHECK) {
  const existing = await readFile(OUTPUT, 'utf8')
  if (existing !== outputBytes) throw new Error('v3 directional audit result is stale')
} else {
  await writeFile(OUTPUT, outputBytes, { flag: 'wx', mode: 0o600 })
}
process.stdout.write(`${JSON.stringify({ output: OUTPUT, mode: CHECK ? 'check' : 'write', integrity }, null, 2)}\n`)

function body(reference) {
  if (!reference || typeof reference.id !== 'string') throw new Error('missing result artifact reference')
  const entry = bodies.get(reference.id)
  if (!entry) throw new Error(`missing archived body ${reference.id}`)
  if (entry.byteLength !== reference.byteLength || entry.sha256 !== reference.sha256 || entry.mediaType !== reference.mediaType) {
    throw new Error(`result/archive reference mismatch for ${reference.id}`)
  }
  if (used.has(reference.id)) throw new Error(`archived body referenced more than once: ${reference.id}`)
  used.add(reference.id)
  return entry.body
}

function ariaContract(pre, post) {
  const checks = {
    preBanner: /^- banner "Cart 0 \| Ready":$/m.test(pre),
    preCart: /^ {2}- button "Cart 0"$/m.test(pre),
    preStatus: /^ {2}- status: Ready$/m.test(pre),
    postBanner: /^- banner "Cart 1 \| Added Item 0":$/m.test(post),
    postCart: /^ {2}- button "Cart 1"$/m.test(post),
    postStatus: /^ {2}- status: Added Item 0$/m.test(post),
    preHasNoPostState: !/^ {2}- button "Cart 1"$|^ {2}- status: Added Item 0$/m.test(pre),
    postHasNoPreState: !/^ {2}- button "Cart 0"$|^ {2}- status: Ready$/m.test(post),
  }
  return { checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function receiptContract(baseline, receipt, limits) {
  const before = compactCheckpointNodes(baseline.checkpoint)
  const changes = receipt.observed?.changes?.items || []
  const transition = (role, beforeName, name) => changes.some((change) => {
    if (change.role !== role || change.name !== name) return false
    if (change.kind === 'possible-replacement') {
      return change.match === 'ambiguous' && change.beforeName === beforeName
    }
    return change.kind === 'content' && before.get(change.id)?.role === role &&
      before.get(change.id)?.name === beforeName
  })
  const checks = {
    baselineContract: baseline.contract === 'snapdom.action-baseline/v1' && baseline.version === 1 && baseline.checkpoint?.version === 2,
    receiptContract: receipt.contract === 'snapdom.action-receipt/v1' && receipt.version === 1,
    taskOutcomeNotAssessed: receipt.taskOutcome === 'NOT_ASSESSED',
    nestedChangedPostcondition: receipt.postcondition?.kind === 'changed' &&
      receipt.postcondition?.expected?.changed === true && receipt.postcondition?.outcome === 'PASS',
    observedChanged: receipt.observed?.changed === true,
    bannerDirection: transition('banner', 'Cart 0 | Ready', 'Cart 1 | Added Item 0'),
    badgeDirection: transition('generic', '0', '1'),
    statusDirection: transition('status', 'Ready', 'Added Item 0'),
    limitsExact: JSON.stringify(receipt.limits) === JSON.stringify(limits),
    changesBounded: boundedConsistent(receipt.observed?.changes),
    becameCoveredBounded: boundedConsistent(receipt.observed?.actionabilityDelta?.becameCovered),
    becameVisibleBounded: boundedConsistent(receipt.observed?.actionabilityDelta?.becameVisible),
    unobservableBounded: boundedConsistent(receipt.observed?.unobservable),
  }
  return { checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function compactCheckpointNodes(checkpoint) {
  const roles = checkpoint?.tables?.[1] || []
  const nodes = new Map()
  for (const row of checkpoint?.nodes || []) {
    const id = row[0]
    const role = row[3] < 0 ? 'generic' : roles[row[3]]
    const bits = row[8]
    let index = 9
    for (const bit of [1 << 0, 1 << 1, 1 << 2, 1 << 3, 1 << 4, 1 << 5, 1 << 6]) {
      if (bits & bit) index++
    }
    nodes.set(id, { role, name: bits & (1 << 7) ? row[index] : '' })
  }
  return nodes
}

function boundedConsistent(section) {
  return section && Array.isArray(section.items) && Number.isInteger(section.total) &&
    Number.isInteger(section.truncated) && section.total >= section.items.length &&
    section.truncated === section.total - section.items.length
}

function oracleContract(oracle, expectedRows) {
  const pre = oracle.pre || {}
  const post = oracle.post || {}
  return pre.badge === '0' && pre.status === 'Ready' && pre.bannerLabel === 'Cart 0 | Ready' &&
    pre.rows === expectedRows && pre.actionables === expectedRows + 1 &&
    post.badge === '1' && post.status === 'Added Item 0' && post.bannerLabel === 'Cart 1 | Added Item 0' &&
    post.rows === expectedRows && post.actionables === expectedRows + 1 && oracle.contractPass === true
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
