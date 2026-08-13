#!/usr/bin/env node
/**
 * Controlled multisite authored-verifier pilot.
 *
 * This runner compares Playwright assertions with SnapDOM's typed semantic diff on the
 * same frozen action intent in fresh cloned contexts. It uses four versioned site-family
 * replicas, opaque truth variants, a committed schedule, and a server-side state model.
 * It is a pilot for false-green direction and diagnostic packets, not a superiority test.
 *
 * Usage:
 *   node experiment/multisite-pilot.mjs --dry
 *   MULTISITE_REPETITIONS=1 MULTISITE_OUTPUT=work/multisite-smoke.json \
 *     node experiment/multisite-pilot.mjs --run
 *   npm run experiment:multisite:pilot   # frozen default: 10 repetitions
 */
import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { chromium } from 'playwright'
import {
  CASES, VARIANTS, expectedState, initialState, oracleChecks, oracleVerdict,
  performPlaywrightAction, readPrimitiveState,
} from './multisite/cases.mjs'
import { createFixtureServer } from './multisite/fixture-server.mjs'
import {
  DEFAULT_SEED, buildProtocol, canonicalJson, preregistration, sha256, validateProtocol,
} from './multisite/protocol.mjs'
import {
  establishSnapdomBaseline, verifyWithPlaywright, verifyWithSnapdom,
} from './multisite/verifiers.mjs'
import { buildSdk } from '../tools/sdk-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = new Set(process.argv.slice(2))
const modes = ['--dry', '--run'].filter((mode) => args.has(mode))
if (args.size !== 1 || modes.length !== 1) throw new Error('choose exactly one mode: --dry or --run')

const repetitions = Number(process.env.MULTISITE_REPETITIONS || 10)
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error('MULTISITE_REPETITIONS must be an integer from 1 to 10')
}
const seed = process.env.MULTISITE_SEED || DEFAULT_SEED
const runId = randomBytes(12).toString('hex')
const truthSalt = randomBytes(32).toString('hex')
const protocol = buildProtocol({ repetitions, seed, truthSalt })
const protocolValidation = validateProtocol(protocol)
if (!protocolValidation.pass) throw new Error(`protocol invalid: ${protocolValidation.problems.join('; ')}`)

const implementationFiles = [
  'experiment/multisite-pilot.mjs',
  'experiment/multisite/cases.mjs',
  'experiment/multisite/fixture-server.mjs',
  'experiment/multisite/protocol.mjs',
  'experiment/multisite/verifiers.mjs',
  'src/checkpoint.js',
  'src/diff.js',
  'src/aria.js',
  'src/hash.js',
  'src/index.js',
  'src/match.js',
  'src/noise.js',
  'src/plugin.js',
  'src/query.js',
  'src/snapshot.js',
  'tools/sdk-bundle.mjs',
  'vendor/snapdom/LICENSE',
  'vendor/snapdom/README.md',
  'vendor/snapdom/dist/snapdom.mjs',
  'vendor/snapdom/plugins/gif-export.js',
  'vendor/snapdom/plugins/video-export.js',
  'package.json',
  'package-lock.json',
]
const sdk = await buildSdk(ROOT)
const implementation = {
  files: implementationFiles,
  sha256: await hashFiles(implementationFiles),
  builtSdkSha256: sha256(sdk),
  builtSdkBytes: Buffer.byteLength(sdk),
  playwright: JSON.parse(await readFile(join(ROOT, 'node_modules/playwright/package.json'), 'utf8')).version,
  esbuild: JSON.parse(await readFile(join(ROOT, 'node_modules/esbuild/package.json'), 'utf8')).version,
  snapdomAgent: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
  arms: {
    playwright: 'native Playwright locator assertions; non-mutating elementFromPoint actionability probes where required',
    snapdom: 'SnapDOM typed before/after diff plus privacy-safe semantic snapshot queries',
  },
}
const prereg = preregistration(protocol, implementation)

if (args.has('--dry')) {
  process.stdout.write(`${JSON.stringify({
    mode: 'dry', preregistration: prereg,
    sealedSummary: {
      commitment: protocol.commitment,
      pairs: protocol.sealed.pairs.length,
      armTrials: protocol.sealed.pairs.length * 2,
      cases: CASES.length,
      siteFamilies: [...new Set(CASES.map((entry) => entry.siteId))],
    },
    note: 'dry mode uses an ephemeral truth salt; each run freezes a new salt and runId before browser startup',
    browserWillBe: 'Playwright chromium.launch headless with fresh non-persistent BrowserContext per arm trial',
    personalChromeAccess: false,
  }, null, 2)}\n`)
  process.exit(0)
}

const output = process.env.MULTISITE_OUTPUT || 'experiment/results/multisite-pilot.json'
const outputPath = isAbsolute(output) ? output : resolve(ROOT, output)
const preregPath = outputPath.replace(/\.json$/i, '.preregistration.json')
const reviewPacketsPath = outputPath.replace(/\.json$/i, '.review-packets.json')
const reviewKeyPath = outputPath.replace(/\.json$/i, '.review-key.json')
const reportPath = outputPath.replace(/\.json$/i, '.md')
for (const path of [outputPath, preregPath, reviewPacketsPath, reviewKeyPath, reportPath]) {
  if (await pathExists(path)) throw new Error(`refusing to overwrite existing pilot artifact: ${path}`)
}
await mkdir(dirname(outputPath), { recursive: true })
// This write is deliberately before browser startup. An aborted run must leave evidence
// of the protocol that was frozen, not silently regenerate a favorable schedule later.
await writeFile(preregPath, `${JSON.stringify(prereg, null, 2)}\n`, { mode: 0o600, flag: 'wx' })

const calibrationPairs = CASES.flatMap((testCase) => VARIANTS.map((variant) => ({
  pairId: `calibration-${testCase.id}-${variant}`,
  caseId: testCase.id,
  siteId: testCase.siteId,
  variant,
  expectedTruth: variant === 'intended' ? 'PASS' : 'FAIL',
  runIds: { calibration: sha256(`${protocol.commitment}\0calibration\0${testCase.id}\0${variant}`).slice(0, 24) },
})))
const fixture = createFixtureServer([...protocol.sealed.pairs, ...calibrationPairs])
let fixturePort = null
let fixtureClosed = false
let fixturePortClosed = false
let browser = null
let browserVersion = null
let browserClosed = false
let primaryError = null
const blockedRequests = []
const calibration = []
const trials = []
const started = new Date().toISOString()

try {
  fixturePort = await fixture.listen()
  const baseUrl = `http://127.0.0.1:${fixturePort}`
  browser = await chromium.launch({ headless: true })
  browserVersion = browser.version()

  // Neutral calibration runs happen before arm trials. They prove that the versioned
  // fixture rendered state agrees with the sealed server-side application model.
  for (const pair of calibrationPairs) {
    const runId = pair.runIds.calibration
    const observed = await withFreshPage({ browser, baseUrl, runId, blockedRequests }, async (page) => {
      const before = await readPrimitiveState(page, pair.caseId)
      requireSame(before, initialState(pair.caseId), `calibration prestate ${pair.caseId}/${pair.variant}`)
      await performPlaywrightAction(page, pair.caseId)
      const after = await readPrimitiveState(page, pair.caseId)
      const screenshot = await page.screenshot({ type: 'png' })
      return { before, after, screenshotSha256: createHash('sha256').update(screenshot).digest('hex') }
    })
    const expected = expectedState(pair.caseId, pair.variant)
    requireSame(fixture.run(runId).state, expected, `calibration server state ${pair.caseId}/${pair.variant}`)
    requireSame(observed.after, expected, `calibration poststate ${pair.caseId}/${pair.variant}`)
    const checks = oracleChecks(pair.caseId, observed.after)
    const verdict = oracleVerdict(pair.caseId, observed.after)
    if (verdict !== pair.expectedTruth) throw new Error(`oracle calibration disagreement ${pair.caseId}/${pair.variant}`)
    if (fixture.run(runId).actionCount !== 1) throw new Error(`calibration action count mismatch ${pair.caseId}/${pair.variant}`)
    calibration.push({ caseId: pair.caseId, opaqueVariantId: sha256(`${seed}\0${pair.caseId}\0${pair.variant}\0variant`).slice(0, 24), verdict, checks, ...observed })
  }

  for (const pair of protocol.sealed.pairs) {
    const testCase = CASES.find((entry) => entry.id === pair.caseId)
    if (!testCase) throw new Error(`scheduled unknown case ${pair.caseId}`)
    for (const arm of pair.order) {
      const runId = pair.runIds[arm]
      const trialStarted = performance.now()
      let trial
      try {
        trial = await withFreshPage({
          browser, baseUrl, runId, blockedRequests,
          initScript: arm === 'snapdom-authored' ? sdk : null,
        }, async (page) => {
          const before = await readPrimitiveState(page, pair.caseId)
          requireSame(before, initialState(pair.caseId), `trial prestate ${pair.pairId}/${arm}`)
          if (arm === 'snapdom-authored') await establishSnapdomBaseline(page)

          const actionStarted = performance.now()
          await performPlaywrightAction(page, pair.caseId)
          const actionMs = rounded(performance.now() - actionStarted)

          let verification
          const verificationStarted = performance.now()
          try {
            verification = arm === 'playwright-authored'
              ? await verifyWithPlaywright(page, pair.caseId)
              : await verifyWithSnapdom(page, pair.caseId)
          } catch (error) {
            const errorEvidence = { error: serializeError(error) }
            verification = {
              verdict: 'OP_ERROR', route: arm, checks: [],
              evidenceBytes: Buffer.byteLength(JSON.stringify(errorEvidence)),
              elapsedMs: rounded(performance.now() - verificationStarted),
              evidence: errorEvidence,
            }
          }

          // Oracle inspection is after the verifier, so a supposedly non-mutating check
          // cannot silently alter the state and still receive credit.
          const after = await readPrimitiveState(page, pair.caseId)
          const expected = expectedState(pair.caseId, pair.variant)
          requireSame(fixture.run(runId).state, expected, `sealed server state ${pair.pairId}/${arm}`)
          requireSame(after, expected, `sealed oracle poststate ${pair.pairId}/${arm}`)
          const screenshot = await page.screenshot({ type: 'png' })
          return {
            before, after, actionMs, verification,
            screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
          }
        })
  } catch (error) {
    const evidence = { error: serializeError(error) }
    trial = {
      before: null, after: null, actionMs: 0,
      verification: {
        verdict: 'OP_ERROR', route: arm, checks: [], evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)),
        elapsedMs: rounded(performance.now() - trialStarted), evidence,
      },
      screenshotSha256: null,
    }
      }

      const run = fixture.run(runId)
      const serverVerdict = run.actionCount === 1 && run.state ? oracleVerdict(pair.caseId, run.state) : 'UNKNOWN'
      const domVerdict = trial.after ? oracleVerdict(pair.caseId, trial.after) : 'UNKNOWN'
      const oracle = serverVerdict === domVerdict ? serverVerdict : 'UNKNOWN'
      const verdict = trial.verification.verdict
      const correctness = classify(verdict, oracle)
      trials.push({
        pairId: pair.pairId,
        caseId: pair.caseId,
        siteId: pair.siteId,
        opaqueVariantId: pair.opaqueVariantId,
        repetition: pair.repetition,
        arm,
        order: pair.order,
        runId,
        expectedTruth: pair.expectedTruth,
        oracle,
        oracleChannels: { serverApplicationState: serverVerdict, primitiveDom: domVerdict },
        oracleChecks: trial.after ? oracleChecks(pair.caseId, trial.after) : null,
        verdict,
        ...correctness,
        route: trial.verification.route,
        timingMs: {
          action: trial.actionMs,
          verification: trial.verification.elapsedMs,
          fullTrial: rounded(performance.now() - trialStarted),
        },
        evidenceBytes: trial.verification.evidenceBytes,
        checks: trial.verification.checks,
        evidence: trial.verification.evidence,
        before: trial.before,
        after: trial.after,
        screenshotSha256: trial.screenshotSha256,
        actionCount: run.actionCount,
      })
    }
  }
} catch (error) {
  primaryError = error
} finally {
  if (browser) {
    browserClosed = await browser.close().then(() => true, () => false)
  }
  if (fixturePort !== null) {
    fixtureClosed = await fixture.close().then(() => true, () => false)
    fixturePortClosed = await isPortClosed(fixturePort)
  }
}

if (primaryError) throw primaryError
const integrityProblems = []
if (!browserClosed) integrityProblems.push('browser did not close')
if (!fixtureClosed || !fixturePortClosed) integrityProblems.push('fixture did not close')
if (blockedRequests.length) integrityProblems.push(`${blockedRequests.length} non-loopback request(s) attempted`)
if (await hashFiles(implementationFiles) !== implementation.sha256) integrityProblems.push('implementation files changed during run')
if (sha256(await buildSdk(ROOT)) !== implementation.builtSdkSha256) integrityProblems.push('built SDK changed during run')
if (trials.length !== protocol.sealed.pairs.length * 2) integrityProblems.push(`trial count ${trials.length} != ${protocol.sealed.pairs.length * 2}`)
const scheduledTrials = protocol.sealed.pairs.flatMap((pair) => pair.order.map((arm) => ({
  key: `${pair.pairId}\0${arm}`,
  pairId: pair.pairId,
  arm,
  runId: pair.runIds[arm],
  caseId: pair.caseId,
  siteId: pair.siteId,
  repetition: pair.repetition,
  opaqueVariantId: pair.opaqueVariantId,
  expectedTruth: pair.expectedTruth,
  order: pair.order,
})))
const scheduledByKey = new Map(scheduledTrials.map((entry) => [entry.key, entry]))
const seenTrialKeys = new Set()
for (const trial of trials) {
  const key = `${trial.pairId}\0${trial.arm}`
  const scheduled = scheduledByKey.get(key)
  if (!scheduled) integrityProblems.push(`unscheduled trial ${trial.pairId}/${trial.arm}`)
  if (seenTrialKeys.has(key)) integrityProblems.push(`duplicate trial ${trial.pairId}/${trial.arm}`)
  seenTrialKeys.add(key)
  const metadataMismatch = scheduled && (
    ['runId', 'caseId', 'siteId', 'repetition', 'opaqueVariantId', 'expectedTruth']
      .some((field) => trial[field] !== scheduled[field]) ||
    canonicalJson(trial.order) !== canonicalJson(scheduled.order)
  )
  if (metadataMismatch) integrityProblems.push(`trial metadata mismatch ${trial.pairId}/${trial.arm}`)
  if (trial.actionCount !== 1) integrityProblems.push(`action count ${trial.pairId}/${trial.arm}=${trial.actionCount}`)
  if (trial.oracle === 'UNKNOWN') integrityProblems.push(`oracle unknown ${trial.pairId}/${trial.arm}`)
  if (trial.oracle !== trial.expectedTruth) integrityProblems.push(`oracle/commitment mismatch ${trial.pairId}/${trial.arm}`)
  if (trial.oracleChannels?.serverApplicationState !== trial.oracleChannels?.primitiveDom) integrityProblems.push(`oracle channel disagreement ${trial.pairId}/${trial.arm}`)
  if (!['PASS', 'FAIL', 'UNKNOWN', 'OP_ERROR'].includes(trial.verdict)) integrityProblems.push(`invalid verdict ${trial.pairId}/${trial.arm}`)
  const declaredConjuncts = CASES.find((entry) => entry.id === trial.caseId)?.conjuncts || []
  if (trial.verdict !== 'OP_ERROR' && canonicalJson(trial.checks.map(({ id, statement }) => ({ id, statement }))) !== canonicalJson(declaredConjuncts)) {
    integrityProblems.push(`conjunct parity mismatch ${trial.pairId}/${trial.arm}`)
  }
  const recomputed = classify(trial.verdict, trial.oracle)
  if (['correct', 'falseGreen', 'falseNegative', 'unknown', 'opError'].some((field) => recomputed[field] !== trial[field])) {
    integrityProblems.push(`classification mismatch ${trial.pairId}/${trial.arm}`)
  }
  if (Object.values(trial.timingMs).some((value) => !Number.isFinite(value) || value < 0)) integrityProblems.push(`invalid timing ${trial.pairId}/${trial.arm}`)
  if (!Number.isFinite(trial.evidenceBytes) || trial.evidenceBytes < 0) integrityProblems.push(`invalid evidence bytes ${trial.pairId}/${trial.arm}`)
  if (Buffer.byteLength(JSON.stringify(trial.evidence)) !== trial.evidenceBytes) {
    integrityProblems.push(`evidence byte mismatch ${trial.pairId}/${trial.arm}`)
  }
}
if (seenTrialKeys.size !== scheduledByKey.size) integrityProblems.push('scheduled trial bijection incomplete')

const aggregates = aggregate(trials)
const paired = pairedSummary(trials)
const diagnostic = diagnosticSummary(trials, protocol.sealed.pairs)
const decision = pilotDecision(trials, diagnostic, integrityProblems)
const packets = buildReviewPackets(trials, protocol.sealed.pairs, 2)
const result = {
  schemaVersion: 1,
  mode: 'controlled-pilot',
  runId,
  classification: 'directional pilot; not confirmatory evidence',
  started,
  finished: new Date().toISOString(),
  preregistration: {
    path: preregPath,
    sha256: hashFileContent(await readFile(preregPath)),
    sealedTruthCommitmentSha256: protocol.commitment,
    publicProtocolSha256: protocol.publicHash,
  },
  pinned: {
    node: process.version,
    playwright: implementation.playwright,
    snapdomAgent: implementation.snapdomAgent,
    implementationSha256: implementation.sha256,
    chromium: browserVersion,
  },
  isolation: {
    fixture: `127.0.0.1:${fixturePort}; versioned local replicas only`,
    browser: 'chromium.launch({headless:true}); fresh non-persistent BrowserContext per arm trial',
    personalChromeAccess: false,
    persistentProfile: false,
    cdpOrExtension: false,
    forbiddenPort8377Used: fixturePort === 8377,
    blockedExternalRequests: blockedRequests,
  },
  integrity: { valid: integrityProblems.length === 0, problems: integrityProblems, fixtureClosed, fixturePortClosed, browserClosed },
  calibration,
  protocol: protocol.publicProtocol,
  sealedTruth: protocol.sealed,
  aggregates,
  paired,
  diagnostic,
  decision,
  trials,
  review: {
    packetsPath: reviewPacketsPath,
    keyPath: reviewKeyPath,
    selectedPackets: packets.publicPackets.length,
    status: 'AWAITING_IDENTITY_REDACTED_REVIEW',
  },
  caveats: protocol.publicProtocol.caveats,
}

if (integrityProblems.length) throw new Error(`integrity gate failed; refusing to publish: ${integrityProblems.join('; ')}`)
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(reviewPacketsPath, `${JSON.stringify({ schemaVersion: 1, packets: packets.publicPackets }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(reviewKeyPath, `${JSON.stringify({ schemaVersion: 1, key: packets.key }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(reportPath, markdown(result), { mode: 0o600, flag: 'wx' })
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  report: reportPath,
  trials: trials.length,
  aggregates,
  paired,
  decision,
  cleanup: result.integrity,
}, null, 2)}\n`)

async function withFreshPage({ browser, baseUrl, runId, blockedRequests, initScript }, run) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC',
    serviceWorkers: 'block',
  })
  try {
    if (initScript) await context.addInitScript({ content: initScript })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      let allowed = false
      try { allowed = new URL(url).origin === baseUrl } catch { allowed = false }
      if (allowed) await route.continue()
      else { blockedRequests.push(url); await route.abort('blockedbyclient') }
    })
    const page = await context.newPage()
    await page.goto(`${baseUrl}/run/${runId}`, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    return await run(page)
  } finally {
    await context.close()
  }
}

function classify(verdict, oracle) {
  return {
    correct: (verdict === 'PASS' || verdict === 'FAIL') && verdict === oracle,
    falseGreen: verdict === 'PASS' && oracle === 'FAIL',
    falseNegative: verdict === 'FAIL' && oracle === 'PASS',
    unknown: verdict === 'UNKNOWN',
    opError: verdict === 'OP_ERROR',
  }
}

function aggregate(trials) {
  return [...new Set(trials.map((trial) => trial.arm))].map((arm) => {
    const rows = trials.filter((trial) => trial.arm === arm)
    return {
      arm,
      trials: rows.length,
      correct: rows.filter((trial) => trial.correct).length,
      falseGreens: rows.filter((trial) => trial.falseGreen).length,
      falseNegatives: rows.filter((trial) => trial.falseNegative).length,
      unknowns: rows.filter((trial) => trial.unknown).length,
      opErrors: rows.filter((trial) => trial.opError).length,
      medianVerificationMs: median(rows.map((trial) => trial.timingMs.verification)),
      medianEvidenceBytes: median(rows.map((trial) => trial.evidenceBytes)),
      medianCheckCount: median(rows.map((trial) => trial.checks.length)),
      byOracle: Object.fromEntries(['PASS', 'FAIL'].map((oracle) => {
        const subset = rows.filter((trial) => trial.oracle === oracle)
        return [oracle, {
          trials: subset.length,
          medianVerificationMs: median(subset.map((trial) => trial.timingMs.verification)),
          medianEvidenceJsonBytes: median(subset.map((trial) => trial.evidenceBytes)),
        }]
      })),
      evidenceEncoding: 'UTF-8 bytes of JSON.stringify(evidence)',
    }
  })
}

function pairedSummary(trials) {
  const pairs = new Map()
  for (const trial of trials) {
    if (!pairs.has(trial.pairId)) pairs.set(trial.pairId, [])
    pairs.get(trial.pairId).push(trial)
  }
  let snapOnlyCorrect = 0
  let playwrightOnlyCorrect = 0
  let bothCorrect = 0
  let neitherCorrect = 0
  let incomplete = 0
  for (const rows of pairs.values()) {
    const snap = rows.find((row) => row.arm === 'snapdom-authored')
    const playwright = rows.find((row) => row.arm === 'playwright-authored')
    if (!snap || !playwright || rows.length !== 2) { incomplete++; continue }
    if (snap.correct && playwright.correct) bothCorrect++
    else if (snap.correct) snapOnlyCorrect++
    else if (playwright.correct) playwrightOnlyCorrect++
    else neitherCorrect++
  }
  return {
    pairs: pairs.size,
    bothCorrect,
    snapOnlyCorrect,
    playwrightOnlyCorrect,
    neitherCorrect,
    discordant: snapOnlyCorrect + playwrightOnlyCorrect,
    incomplete,
  }
}

function diagnosticSummary(trials, sealedPairs) {
  const truth = new Map(sealedPairs.map((pair) => [pair.pairId, pair.violatedConjuncts]))
  return [...new Set(trials.map((trial) => trial.arm))].map((arm) => {
    const rows = trials.filter((trial) => trial.arm === arm && trial.oracle === 'FAIL')
    let expectedTotal = 0
    let identifiedTotal = 0
    let reportedTotal = 0
    let exactSets = 0
    const cases = new Set()
    for (const row of rows) {
      const expected = new Set(truth.get(row.pairId) || [])
      const reported = new Set(row.checks.filter((check) => !check.pass).map((check) => check.id))
      expectedTotal += expected.size
      reportedTotal += reported.size
      identifiedTotal += [...reported].filter((id) => expected.has(id)).length
      if (expected.size === reported.size && [...expected].every((id) => reported.has(id))) exactSets++
      if (expected.size || reported.size) cases.add(row.caseId)
    }
    return {
      arm,
      oracleFailTrials: rows.length,
      violatedConjunctRecall: expectedTotal ? roundFraction(identifiedTotal / expectedTotal) : null,
      violatedConjunctPrecision: reportedTotal ? roundFraction(identifiedTotal / reportedTotal) : null,
      exactViolationSets: exactSets,
      casesWithDiagnosticEvents: cases.size,
      note: 'objective conjunct localization only; qualitative evidence usefulness requires identity-redacted review',
    }
  })
}

function pilotDecision(trials, diagnostic, integrityProblems) {
  if (integrityProblems.length) return { integrity: 'INVALID', direction: 'UNKNOWN', estimability: 'INVALID', next: 'REPAIR_AND_RERUN' }
  const snap = trials.filter((trial) => trial.arm === 'snapdom-authored')
  const playwright = trials.filter((trial) => trial.arm === 'playwright-authored')
  const snapFalseGreen = snap.filter((trial) => trial.falseGreen).length
  const caseDirections = CASES.map((testCase) => {
    const snapCorrect = snap.filter((trial) => trial.caseId === testCase.id && trial.correct).length
    const playwrightCorrect = playwright.filter((trial) => trial.caseId === testCase.id && trial.correct).length
    return snapCorrect > playwrightCorrect ? 'SNAP_FAVORED'
      : (playwrightCorrect > snapCorrect ? 'PLAYWRIGHT_FAVORED' : 'TIED')
  })
  const snapFavoredCases = caseDirections.filter((value) => value === 'SNAP_FAVORED').length
  const playwrightFavoredCases = caseDirections.filter((value) => value === 'PLAYWRIGHT_FAVORED').length
  const direction = snapFavoredCases > playwrightFavoredCases ? 'SNAP_FAVORED'
    : (playwrightFavoredCases > snapFavoredCases ? 'PLAYWRIGHT_FAVORED' : 'TIED')
  const discordantCases = new Set(trials.filter((trial) => {
    const mate = trials.find((other) => other.pairId === trial.pairId && other.arm !== trial.arm)
    return mate && mate.correct !== trial.correct
  }).map((trial) => trial.caseId)).size
  const estimability = discordantCases >= 4 ? 'DIRECTIONAL_CASE_EVENTS' : 'EVENT_STARVED'
  const snapDiagnostic = diagnostic.find((entry) => entry.arm === 'snapdom-authored')
  const playwrightDiagnostic = diagnostic.find((entry) => entry.arm === 'playwright-authored')
  return {
    integrity: 'VALID',
    safety: snapFalseGreen > 0 ? 'FALSE_GREEN_OBSERVED' : 'NO_EVENT_NOT_PROOF',
    direction,
    caseDirection: { snapFavored: snapFavoredCases, playwrightFavored: playwrightFavoredCases, tied: caseDirections.filter((value) => value === 'TIED').length },
    estimability,
    discordantCases,
    diagnosticDirection: snapDiagnostic?.violatedConjunctRecall > playwrightDiagnostic?.violatedConjunctRecall
      ? 'SNAP_FAVORED'
      : (playwrightDiagnostic?.violatedConjunctRecall > snapDiagnostic?.violatedConjunctRecall ? 'PLAYWRIGHT_FAVORED' : 'TIED'),
    next: snapFalseGreen > 0
      ? 'REPAIR_SAFETY'
      : (direction === 'SNAP_FAVORED' ? 'INDEPENDENT_CONFIRMATORY_REQUIRED' : 'IDENTITY_REDACTED_DIAGNOSIS_THEN_HELPER_ONLY'),
    note: 'Repetitions are stability checks, not independent evidence. This pilot cannot clear superiority or non-inferiority gates.',
  }
}

function buildReviewPackets(trials, sealedPairs, repetitionsPerTruth) {
  const selected = new Set(sealedPairs.filter((pair) => pair.repetition < repetitionsPerTruth).map((pair) => pair.pairId))
  const publicPackets = []
  const key = []
  for (const trial of trials.filter((entry) => selected.has(entry.pairId))) {
    const testCase = CASES.find((entry) => entry.id === trial.caseId)
    const packetId = randomBytes(12).toString('hex')
    const payload = jsonSafe({
      packetId,
      task: { action: testCase.action, conjuncts: testCase.conjuncts },
      finalVerdict: trial.verdict,
      checks: blind(trial.checks),
      evidence: blind(trial.evidence),
    })
    publicPackets.push({ ...payload, packetPayloadSha256: sha256(payload) })
    key.push({
      packetId, pairId: trial.pairId, arm: trial.arm, caseId: trial.caseId,
      siteId: trial.siteId, opaqueVariantId: trial.opaqueVariantId,
      expectedTruth: trial.expectedTruth,
      violatedConjuncts: sealedPairs.find((pair) => pair.pairId === trial.pairId).violatedConjuncts,
      rawSourceSha256: sha256(jsonSafe({ verdict: trial.verdict, checks: trial.checks, evidence: trial.evidence })),
    })
  }
  publicPackets.sort((a, b) => a.packetId.localeCompare(b.packetId))
  return { publicPackets, key }
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

function blind(value) {
  if (Array.isArray(value)) return value.map(blind)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['route', 'arm', 'runId'].includes(key))
      .map(([key, entry]) => [key, blind(entry)]))
  }
  if (typeof value === 'string') {
    return value
      .replaceAll(ROOT, '[workspace]')
      .replace(/playwright/gi, '[engine]')
      .replace(/snapdom/gi, '[verifier]')
  }
  return value
}

function markdown(result) {
  const lines = [
    '# Controlled multisite verification pilot', '',
    'Status: directional authored-verifier pilot; not confirmatory evidence  ',
    `Run: ${result.started} to ${result.finished}  `,
    `Cases: ${CASES.length} across four versioned site-family replicas; arm trials: ${result.trials.length}`, '',
    '## Outcome', '',
    '| Arm | Correct | False green | False negative | UNKNOWN | OP_ERROR | Verify ms PASS/FAIL | Evidence JSON B PASS/FAIL |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const row of result.aggregates) {
    lines.push(`| ${row.arm} | ${row.correct}/${row.trials} | ${row.falseGreens} | ${row.falseNegatives} | ${row.unknowns} | ${row.opErrors} | ${row.byOracle.PASS.medianVerificationMs}/${row.byOracle.FAIL.medianVerificationMs} | ${row.byOracle.PASS.medianEvidenceJsonBytes}/${row.byOracle.FAIL.medianEvidenceJsonBytes} |`)
  }
  lines.push('', '## Paired direction', '',
    `Both correct: ${result.paired.bothCorrect}; SnapDOM only: ${result.paired.snapOnlyCorrect}; Playwright only: ${result.paired.playwrightOnlyCorrect}; neither: ${result.paired.neitherCorrect}; discordant: ${result.paired.discordant}.`, '',
    `Pilot decision: **${result.decision.direction} / ${result.decision.estimability} / ${result.decision.next}**.`, '',
    '## Objective diagnostic localization', '',
    '| Arm | Violated-conjunct recall | Precision | Exact sets |',
    '|---|---:|---:|---:|',
    ...result.diagnostic.map((row) => `| ${row.arm} | ${row.violatedConjunctRecall} | ${row.violatedConjunctPrecision} | ${row.exactViolationSets}/${row.oracleFailTrials} |`), '',
    '## Interpretation boundary', '',
    'The truth variants were committed before browser startup and hidden behind opaque run IDs. The two arms received the same neutral action and postcondition in fresh contexts. A separate server-side application model was calibrated against primitive DOM state for every case and variant before arm trials.', '',
    'These are self-authored, versioned replicas with deliberately balanced faults. Repetitions measure stability, not independent case or site coverage. This run can expose false-green direction and produce identity-redacted diagnostic packets; their structure can still reveal the arm, so reviewers record an arm guess. It cannot establish general accuracy, safety, non-inferiority, superiority, model task success, or live-web performance.', '',
    'Timing is descriptive only: failed Playwright assertions consume bounded retry time, while SnapDOM reads one post-action snapshot. Evidence sizes are UTF-8 JSON bytes, not token or information-quality measurements.', '',
    'All browsers used headless isolated Playwright Chromium contexts. No personal Chrome profile, tab, cookie, session, history, password, or extension was accessed.', '')
  return lines.join('\n')
}

function requireSame(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch\nexpected=${canonicalJson(expected)}\nactual=${canonicalJson(actual)}`)
  }
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

function roundFraction(value) {
  return Math.round(value * 10_000) / 10_000
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : rounded((sorted[middle - 1] + sorted[middle]) / 2)
}

function serializeError(error) {
  return { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 10_000) }
}

function hashFileContent(content) {
  return createHash('sha256').update(content).digest('hex')
}
async function hashFiles(paths) {
  const hash = createHash('sha256')
  for (const path of paths) {
    const content = await readFile(join(ROOT, path))
    hash.update(`${Buffer.byteLength(path)}:${path}:${content.byteLength}:`)
    hash.update(content)
  }
  return hash.digest('hex')
}
async function isPortClosed(port) {
  return await new Promise((resolveClosed) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); resolveClosed(false) }, 500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveClosed(false) })
    socket.once('error', () => { clearTimeout(timer); resolveClosed(true) })
  })
}

async function pathExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
