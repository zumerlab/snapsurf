#!/usr/bin/env node
/** Score the frozen, identity-redacted multisite diagnostic review. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const reviewDir = resolve(args.dir)
const keyPath = resolve(args.key)
const resultPath = resolve(args.result)
const outputPath = resolve(args.output)
const reportPath = outputPath.replace(/\.json$/i, '.md')
if (reportPath === outputPath) throw new Error('--output must end in .json')

const manifest = await readJson(join(reviewDir, 'assignment-manifest.json'))
const gate = await readJson(join(reviewDir, 'decision-gate.json'))
const keyFile = await readJson(keyPath)
const pilot = await readJson(resultPath)
const truth = new Map(keyFile.key.map((entry) => [entry.packetId, entry]))
const problems = []
const reviews = []
const assignments = []

if (manifest.reviewId !== gate.reviewId) problems.push('review/decision gate id mismatch')
if (manifest.reviewsPerPacket !== 2 || manifest.reviewerCount !== 4) problems.push('unexpected review design')
if (new Set(keyFile.key.map((entry) => entry.packetId)).size !== keyFile.key.length) problems.push('duplicate review key packet id')

for (const summary of manifest.assignments) {
  const assignment = await readJson(summary.file)
  const responsePath = join(reviewDir, `reviewer-${Number(summary.reviewerId.slice(1))}-responses.json`)
  const response = await readJson(responsePath)
  const core = { ...assignment }
  delete core.assignmentSha256
  const assignmentSha256 = sha256(JSON.stringify(core))
  if (assignmentSha256 !== assignment.assignmentSha256 || assignmentSha256 !== summary.assignmentSha256) {
    problems.push(`assignment hash mismatch ${summary.reviewerId}`)
  }
  if (response.reviewerId !== summary.reviewerId) problems.push(`response reviewer mismatch ${summary.reviewerId}`)
  if (response.assignmentSha256 !== assignment.assignmentSha256) problems.push(`response assignment hash mismatch ${summary.reviewerId}`)
  const packetIds = new Set(assignment.packets.map((entry) => entry.packetId))
  const responseIds = new Set(response.responses?.map((entry) => entry.packetId) || [])
  if (packetIds.size !== assignment.packets.length || responseIds.size !== response.responses?.length) {
    problems.push(`duplicate assignment/response id ${summary.reviewerId}`)
  }
  if (packetIds.size !== responseIds.size || [...packetIds].some((id) => !responseIds.has(id))) {
    problems.push(`response packet set mismatch ${summary.reviewerId}`)
  }
  const packetById = new Map(assignment.packets.map((entry) => [entry.packetId, entry]))
  for (const item of response.responses || []) {
    validateResponse(item, summary.reviewerId, problems)
    const key = truth.get(item.packetId)
    if (!key) problems.push(`missing truth key ${item.packetId}`)
    reviews.push({ ...item, reviewerId: summary.reviewerId, packet: packetById.get(item.packetId), key })
  }
  assignments.push({ summary, assignment, response, responsePath })
}

for (const packetId of truth.keys()) {
  const rows = reviews.filter((entry) => entry.packetId === packetId)
  if (rows.length !== 2) problems.push(`packet ${packetId} has ${rows.length} reviews`)
}

for (const assignment of assignments) {
  const pairs = new Map()
  for (const packet of assignment.assignment.packets) {
    const key = truth.get(packet.packetId)
    if (!key) continue
    pairs.set(key.pairId, (pairs.get(key.pairId) || 0) + 1)
  }
  if ([...pairs.values()].some((count) => count > 1)) problems.push(`paired exposure ${assignment.summary.reviewerId}`)
}

const scored = reviews.map(scoreReview)
const arms = ['playwright-authored', 'snapdom-authored'].map((arm) => scoreArm(arm, scored))
const agreement = scoreAgreement(scored)
const snap = arms.find((entry) => entry.arm === 'snapdom-authored')
const playwright = arms.find((entry) => entry.arm === 'playwright-authored')
const primaryDifference = round(snap.fault.meanEvidenceSpecificity - playwright.fault.meanEvidenceSpecificity)
const diagnosisDifference = round(snap.diagnosisAccuracy - playwright.diagnosisAccuracy)
const exactSetDifference = round(snap.fault.exactViolationSetRate - playwright.fault.exactViolationSetRate)
const snapFalseGreens = pilot.aggregates.find((entry) => entry.arm === 'snapdom-authored')?.falseGreens
const complete = problems.length === 0 && scored.length === manifest.packetCount * manifest.reviewsPerPacket
const guardrails = {
  reviewComplete: complete,
  diagnosisAccuracy: diagnosisDifference >= gate.guardrails.diagnosisAccuracyDifferenceMinimum,
  exactViolatedConjunctSet: exactSetDifference >= gate.guardrails.exactViolatedConjunctSetDifferenceMinimum,
  falseGreen: snapFalseGreens <= gate.guardrails.falseGreenMaximum,
  pairedExposure: !problems.some((entry) => entry.startsWith('paired exposure')),
}
const allGuardrails = Object.values(guardrails).every(Boolean)
const decision = snapFalseGreens > 0
  ? 'REPAIR_SAFETY'
  : (primaryDifference >= gate.primaryEstimand.materialSnapdomGain && allGuardrails
      ? 'DIFFERENTIATED_VERIFIER_CANDIDATE'
      : 'HELPER_ONLY')

const output = {
  schemaVersion: 1,
  classification: 'directional diagnostic review; not confirmatory evidence',
  reviewId: manifest.reviewId,
  sources: {
    manifest: source(join(reviewDir, 'assignment-manifest.json'), manifest),
    decisionGate: source(join(reviewDir, 'decision-gate.json'), gate),
    key: source(keyPath, keyFile),
    pilot: source(resultPath, pilot),
    assignments: assignments.map(({ summary, assignment, response, responsePath }) => ({
      reviewerId: summary.reviewerId,
      assignment: source(summary.file, assignment),
      response: source(responsePath, response),
    })),
  },
  integrity: { valid: problems.length === 0, problems, reviews: scored.length, packets: truth.size },
  arms,
  agreement,
  comparison: {
    primaryMetric: 'mean evidenceSpecificity on oracle-FAIL reviews (0-3)',
    snapdomMinusPlaywright: primaryDifference,
    materialThreshold: gate.primaryEstimand.materialSnapdomGain,
    diagnosisAccuracyDifference: diagnosisDifference,
    exactViolationSetDifference: exactSetDifference,
    guardrails,
  },
  decision,
  interpretation: decision === 'HELPER_ONLY'
    ? 'The controlled pilot found no detection gain and the frozen diagnostic material-gain gate was not met; keep SnapDOM as an optional Playwright helper.'
    : 'The frozen diagnostic gate was met locally; independent holdout cases are required before any general value claim.',
  caveats: gate.knownLimits,
  packetScores: scored,
}

if (problems.length) throw new Error(`review integrity failed: ${problems.join('; ')}`)
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(reportPath, markdown(output), { mode: 0o600, flag: 'wx' })
process.stdout.write(`${JSON.stringify({ output: outputPath, report: reportPath, arms, agreement, comparison: output.comparison, decision }, null, 2)}\n`)

function scoreReview(review) {
  const expectedTruth = review.key.expectedTruth
  const expected = new Set(review.key.violatedConjuncts || [])
  const reported = new Set(review.violatedConjuncts || [])
  const intersection = [...reported].filter((id) => expected.has(id)).length
  const expectedMode = expectedFailureMode(review.key.caseId, expectedTruth)
  return {
    packetId: review.packetId,
    reviewerId: review.reviewerId,
    arm: review.key.arm,
    caseId: review.key.caseId,
    siteId: review.key.siteId,
    expectedTruth,
    diagnosis: review.diagnosis,
    diagnosisCorrect: review.diagnosis === expectedTruth,
    violatedConjuncts: [...reported],
    expectedViolatedConjuncts: [...expected],
    violationRecall: expected.size ? round(intersection / expected.size) : null,
    violationPrecision: reported.size ? round(intersection / reported.size) : (expected.size ? 0 : 1),
    exactViolationSet: setEqual(expected, reported),
    failureMode: review.failureMode,
    expectedFailureMode: expectedMode,
    failureModeCorrect: expectedTruth === 'FAIL' ? review.failureMode === expectedMode : review.failureMode === 'satisfied',
    targetIdentified: review.targetIdentified,
    wrongTargetIdentified: review.wrongTargetIdentified,
    coverageDiagnosed: review.coverageDiagnosed,
    uncertaintyDiagnosed: review.uncertaintyDiagnosed,
    evidenceSpecificity: review.evidenceSpecificity,
    confidence: review.confidence,
    armGuess: review.armGuess,
    rationale: review.rationale,
  }
}

function scoreArm(arm, rows) {
  const all = rows.filter((entry) => entry.arm === arm)
  const fault = all.filter((entry) => entry.expectedTruth === 'FAIL')
  const wrongTarget = fault.filter((entry) => entry.expectedFailureMode === 'wrong-target')
  const coverage = fault.filter((entry) => entry.expectedFailureMode === 'occluded')
  const uncertainty = fault.filter((entry) => entry.caseId === 'S1')
  return {
    arm,
    reviews: all.length,
    packets: new Set(all.map((entry) => entry.packetId)).size,
    diagnosisAccuracy: rate(all, (entry) => entry.diagnosisCorrect),
    fault: {
      reviews: fault.length,
      packets: new Set(fault.map((entry) => entry.packetId)).size,
      meanEvidenceSpecificity: mean(fault.map((entry) => entry.evidenceSpecificity)),
      medianEvidenceSpecificity: median(fault.map((entry) => entry.evidenceSpecificity)),
      exactViolationSetRate: rate(fault, (entry) => entry.exactViolationSet),
      meanViolationRecall: mean(fault.map((entry) => entry.violationRecall)),
      meanViolationPrecision: mean(fault.map((entry) => entry.violationPrecision)),
      failureModeAccuracy: rate(fault, (entry) => entry.failureModeCorrect),
      targetIdentifiedRate: rate(fault, (entry) => entry.targetIdentified),
      wrongTargetIdentifiedRate: rate(wrongTarget, (entry) => entry.wrongTargetIdentified),
      coverageDiagnosedRate: rate(coverage, (entry) => entry.coverageDiagnosed),
      uncertaintyDiagnosedRate: rate(uncertainty, (entry) => entry.uncertaintyDiagnosed),
      meanConfidence: mean(fault.map((entry) => entry.confidence)),
    },
    armGuessNonUnknownRate: rate(all, (entry) => entry.armGuess !== 'unknown'),
  }
}

function scoreAgreement(rows) {
  const byPacket = new Map()
  for (const row of rows) {
    if (!byPacket.has(row.packetId)) byPacket.set(row.packetId, [])
    byPacket.get(row.packetId).push(row)
  }
  const pairs = [...byPacket.values()]
  return {
    packets: pairs.length,
    diagnosisAgreement: rate(pairs, ([a, b]) => a.diagnosis === b.diagnosis),
    violatedConjunctSetAgreement: rate(pairs, ([a, b]) => setEqual(new Set(a.violatedConjuncts), new Set(b.violatedConjuncts))),
    failureModeAgreement: rate(pairs, ([a, b]) => a.failureMode === b.failureMode),
    exactSpecificityAgreement: rate(pairs, ([a, b]) => a.evidenceSpecificity === b.evidenceSpecificity),
    meanSpecificityAbsoluteDifference: mean(pairs.map(([a, b]) => Math.abs(a.evidenceSpecificity - b.evidenceSpecificity))),
    armGuessNonUnknownRate: rate(rows, (entry) => entry.armGuess !== 'unknown'),
  }
}

function expectedFailureMode(caseId, truth) {
  if (truth === 'PASS') return 'satisfied'
  if (['T2', 'T4', 'S2', 'S3'].includes(caseId)) return 'wrong-target'
  if (['T1', 'S1', 'I3'].includes(caseId)) return 'missing-effect'
  if (['T3', 'I1', 'I2'].includes(caseId)) return 'partial-effect'
  if (['B1', 'B2'].includes(caseId)) return 'occluded'
  return 'other'
}

function validateResponse(item, reviewerId, problems) {
  const allowedDiagnosis = ['PASS', 'FAIL', 'UNKNOWN']
  const allowedModes = ['satisfied', 'wrong-target', 'missing-effect', 'partial-effect', 'unintended-side-effect', 'occluded', 'uncertainty', 'insufficient-evidence', 'other']
  if (!item || typeof item !== 'object' || !item.packetId) problems.push(`invalid response ${reviewerId}`)
  if (!allowedDiagnosis.includes(item.diagnosis)) problems.push(`invalid diagnosis ${reviewerId}/${item.packetId}`)
  if (!Array.isArray(item.violatedConjuncts) || new Set(item.violatedConjuncts).size !== item.violatedConjuncts.length) problems.push(`invalid conjuncts ${reviewerId}/${item.packetId}`)
  if (!allowedModes.includes(item.failureMode)) problems.push(`invalid failure mode ${reviewerId}/${item.packetId}`)
  for (const field of ['targetIdentified', 'wrongTargetIdentified', 'coverageDiagnosed', 'uncertaintyDiagnosed']) {
    if (typeof item[field] !== 'boolean') problems.push(`invalid ${field} ${reviewerId}/${item.packetId}`)
  }
  if (!Number.isInteger(item.evidenceSpecificity) || item.evidenceSpecificity < 0 || item.evidenceSpecificity > 3) problems.push(`invalid specificity ${reviewerId}/${item.packetId}`)
  if (!Number.isInteger(item.confidence) || item.confidence < 1 || item.confidence > 5) problems.push(`invalid confidence ${reviewerId}/${item.packetId}`)
  if (!['A', 'B', 'unknown'].includes(item.armGuess)) problems.push(`invalid arm guess ${reviewerId}/${item.packetId}`)
  if (typeof item.rationale !== 'string' || !item.rationale.trim()) problems.push(`invalid rationale ${reviewerId}/${item.packetId}`)
}

function markdown(result) {
  const lines = [
    '# Multisite diagnostic review', '',
    `Decision: **${result.decision}**  `,
    `Integrity: ${result.integrity.valid ? 'VALID' : 'INVALID'}; ${result.integrity.reviews} reviews across ${result.integrity.packets} packets.`, '',
    '| Arm | Diagnosis accuracy | Fault specificity (0-3) | Exact violation set | Mode accuracy |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const arm of result.arms) {
    lines.push(`| ${arm.arm} | ${arm.diagnosisAccuracy} | ${arm.fault.meanEvidenceSpecificity} | ${arm.fault.exactViolationSetRate} | ${arm.fault.failureModeAccuracy} |`)
  }
  lines.push('', `SnapDOM minus Playwright specificity: ${result.comparison.snapdomMinusPlaywright}; frozen material threshold: ${result.comparison.materialThreshold}.`, '',
    `Agreement — verdict: ${result.agreement.diagnosisAgreement}; violated set: ${result.agreement.violatedConjunctSetAgreement}; failure mode: ${result.agreement.failureModeAgreement}.`, '',
    result.interpretation, '',
    'This is a tuned, self-authored directional review. It is not holdout or confirmatory evidence. Packet structure may reveal the arm; arm guesses were recorded.', '')
  return lines.join('\n')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('usage: --dir <review-dir> --key <key.json> --result <pilot.json> --output <score.json>')
    out[argv[i].slice(2)] = argv[i + 1]
  }
  for (const key of ['dir', 'key', 'result', 'output']) if (!out[key]) throw new Error(`missing --${key}`)
  return out
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function source(path, value) {
  const wire = JSON.stringify(value)
  return { path, bytes: Buffer.byteLength(wire), sha256: sha256(wire) }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function setEqual(a, b) {
  return a.size === b.size && [...a].every((entry) => b.has(entry))
}

function mean(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2)
}

function rate(values, predicate) {
  return values.length ? round(values.filter(predicate).length / values.length) : null
}

function round(value) {
  return Math.round(value * 10_000) / 10_000
}
