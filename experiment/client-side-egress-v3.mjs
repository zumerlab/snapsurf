#!/usr/bin/env node
/**
 * Browser-SDK evidence-body experiment, version 3.
 *
 * This descriptive repeat packs and installs the current browser-only SDK, imports
 * that installed ESM bundle into a task-owned Chromium profile, then compares:
 *   - a whole-root ARIA snapshot used only as a full-state reader; and
 *   - the official createBaseline(root) + createReceipt(root) SDK cycle.
 *
 * Playwright is only the hermetic browser harness. This script never opens a
 * personal Chrome profile. Every measured body is retained verbatim with hashes.
 */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { createHash } from 'node:crypto'
import { createServer, get } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from 'playwright'

const RUNNER = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(RUNNER), '..')
const SDK = join(ROOT, 'browser-sdk')
const ROW_SCALES = [50, 250, 1000, 3000]
const UNCERTAINTY_SCALES = [0, 10, 100, 300]
const REPS = 4
const FORBIDDEN_PORT = 8377
const RECEIPT_LIMITS = Object.freeze({ changes: 24, actionability: 12, unobservable: 12 })
const RESULT_OUTPUT = argumentPath('--output') || join(ROOT, 'experiment', 'results', 'client-side-egress-v3.json')
const ARTIFACT_OUTPUT = argumentPath('--artifacts') || join(ROOT, 'experiment', 'results', 'client-side-egress-v3.artifacts.json.gz')

if (process.argv.includes('--contract-fixture')) {
  const fixture = runDirectionalContractFixture()
  console.log(JSON.stringify({ mode: 'contract-fixture', ...fixture }, null, 2))
  process.exit(0)
}

await assertAbsent(RESULT_OUTPUT)
await assertAbsent(ARTIFACT_OUTPUT)

const runnerSha256 = sha256(await readFile(RUNNER))
const startedAt = new Date().toISOString()
const artifactBodies = []
const execution = await executeFailClosed(artifactBodies)
const completedAt = new Date().toISOString()
const run = execution.run

const artifactIds = new Set(artifactBodies.map((entry) => entry.id))
const referencedArtifactIds = collectArtifactIds(run)
const artifactIntegrity = {
  expectedBodies: ROW_SCALES.length * REPS * 4 + UNCERTAINTY_SCALES.length * REPS * 2,
  bodies: artifactBodies.length,
  uniqueIds: artifactIds.size === artifactBodies.length,
  allHashesMatch: artifactBodies.every((entry) =>
    entry.sha256 === sha256(entry.body) && entry.byteLength === utf8Bytes(entry.body)),
  allBodiesReferenced: artifactBodies.every((entry) => referencedArtifactIds.has(entry.id)),
  noDanglingReferences: [...referencedArtifactIds].every((id) => artifactIds.has(id)),
}
assertIntegrity('artifact bodies', artifactIntegrity, [
  ['body count', artifactIntegrity.bodies === artifactIntegrity.expectedBodies],
  ['unique ids', artifactIntegrity.uniqueIds],
  ['body hashes', artifactIntegrity.allHashesMatch],
  ['all bodies referenced', artifactIntegrity.allBodiesReferenced],
  ['no dangling references', artifactIntegrity.noDanglingReferences],
])

const primarySummary = summarizePrimary(run.primaryTrials)
const uncertaintySummary = summarizeUncertainty(run.uncertaintyTrials)
const integrity = {
  primaryTrials: run.primaryTrials.length,
  expectedPrimaryTrials: ROW_SCALES.length * REPS,
  uncertaintyTrials: run.uncertaintyTrials.length,
  expectedUncertaintyTrials: UNCERTAINTY_SCALES.length * REPS,
  balancedPreReadOrder: balancedOrder(run.primaryTrials, 'pre'),
  balancedPostReadOrder: balancedOrder(run.primaryTrials, 'post'),
  allPrimitiveOraclesExact: run.primaryTrials.every((trial) => trial.oracle.contractPass),
  allAriaDirectionalContractsExact: run.primaryTrials.every((trial) => trial.contracts.aria.exactPrePost),
  allReceiptDirectionalContractsExact: run.primaryTrials.every((trial) => trial.contracts.receipt.exactPrePost),
  allTaskOutcomesNotAssessed: [
    ...run.primaryTrials.map((trial) => trial.receipt.post.parsed),
    ...run.uncertaintyTrials.map((trial) => trial.receipt.post.parsed),
  ].every((receipt) => receipt.taskOutcome === 'NOT_ASSESSED'),
  allBoundedSectionsConsistent: [
    ...run.primaryTrials.map((trial) => trial.receipt.post.parsed),
    ...run.uncertaintyTrials.map((trial) => trial.receipt.post.parsed),
  ].every(boundedSectionsConsistent),
  allUnobservableTotalsExact: run.uncertaintyTrials.every((trial) =>
    trial.oracle.totalRegions === trial.receipt.post.unobservable.total),
  allUnobservableTruncationExact: run.uncertaintyTrials.every((trial) => {
    const bounded = trial.receipt.post.unobservable
    return bounded.items === Math.min(trial.oracle.totalRegions, RECEIPT_LIMITS.unobservable) &&
      bounded.truncated === Math.max(0, trial.oracle.totalRegions - RECEIPT_LIMITS.unobservable)
  }),
  uncertaintyOutcomesHonest: run.uncertaintyTrials.every((trial) =>
    trial.receipt.post.postconditionOutcome === (trial.regionCount === 0 ? 'PASS' : 'UNKNOWN')),
  fixturePortAssignedByOs: run.environment.fixturePortSelection === 'operating-system ephemeral port',
  fixturePortNot8377: run.environment.fixturePort !== FORBIDDEN_PORT,
  fixturePortClosed: run.environment.fixturePortClosed,
  temporaryProfileRemoved: run.environment.profileRemoved,
  temporarySdkInstallRemoved: execution.sdkInstallRemoved,
  artifactBodies: artifactIntegrity,
}
assertIntegrity('experiment', integrity, [
  ['primary trial count', integrity.primaryTrials === integrity.expectedPrimaryTrials],
  ['uncertainty trial count', integrity.uncertaintyTrials === integrity.expectedUncertaintyTrials],
  ['balanced pre order', integrity.balancedPreReadOrder],
  ['balanced post order', integrity.balancedPostReadOrder],
  ['primitive oracle', integrity.allPrimitiveOraclesExact],
  ['ARIA directional contract', integrity.allAriaDirectionalContractsExact],
  ['receipt directional contract', integrity.allReceiptDirectionalContractsExact],
  ['task outcomes', integrity.allTaskOutcomesNotAssessed],
  ['bounded sections', integrity.allBoundedSectionsConsistent],
  ['unobservable totals', integrity.allUnobservableTotalsExact],
  ['unobservable truncation', integrity.allUnobservableTruncationExact],
  ['uncertainty outcomes', integrity.uncertaintyOutcomesHonest],
  ['OS-assigned port', integrity.fixturePortAssignedByOs],
  ['forbidden port', integrity.fixturePortNot8377],
  ['closed port', integrity.fixturePortClosed],
  ['removed profile', integrity.temporaryProfileRemoved],
  ['removed SDK install', integrity.temporarySdkInstallRemoved],
])

const artifactDocument = {
  schema: 1,
  classification: 'verbatim measured evidence bodies for client-side-egress-v3',
  generatedAt: completedAt,
  encoding: 'UTF-8 strings inside gzip-compressed JSON',
  bodies: artifactBodies,
}
const artifactCompressed = gzipSync(Buffer.from(`${JSON.stringify(artifactDocument)}\n`), { level: 9, mtime: 0 })
const artifactArchive = {
  path: basename(ARTIFACT_OUTPUT),
  mediaType: 'application/gzip',
  byteLength: artifactCompressed.byteLength,
  sha256: sha256(artifactCompressed),
  bodyCount: artifactBodies.length,
}

const output = {
  schema: 3,
  classification: 'single-machine, synthetic, descriptive browser-SDK evidence-body repeat; not a speed, token, task-success, or commercial-value claim',
  question: 'When the packed browser-only SDK is installed and used on one rendered root, what baseline-plus-post-receipt bytes and reader wall time are observed versus whole-root ARIA full-state snapshots?',
  analysisStatus: {
    kind: 'descriptive repeat',
    preregisteredThreshold: null,
    interpretation: 'No retroactive pass/fail threshold is applied. Results are descriptive and all scales/repetitions are reported.',
  },
  runHistory: [
    {
      attempt: 1,
      status: 'RUN_DISCARDED_HARNESS_EXPECTATION',
      artifactFilesWritten: false,
      reason: 'The harness incorrectly required kind:content for all three directional facts. The installed SDK emitted its explicit ambiguity taxonomy: kind:possible-replacement, match:ambiguous, beforeName -> name.',
      disposition: 'No measured output was retained because the runner failed closed before writing either v3 evidence file. Temporary browser, port, profile, and SDK install cleanup all reported successful in the thrown integrity payload.',
    },
    {
      attempt: 2,
      status: 'REPORTED',
      correction: 'The harness accepts either stable-id content evidence or explicit possible-replacement beforeName -> name evidence, while still requiring the exact three authored directional facts.',
    },
  ],
  exactContract: {
    pre: { cart: '0', status: 'Ready', banner: 'Cart 0 | Ready' },
    post: { cart: '1', status: 'Added Item 0', banner: 'Cart 1 | Added Item 0' },
    sdkPostcondition: { kind: 'changed', expected: { changed: true }, outcome: 'PASS' },
    taskOutcome: 'NOT_ASSESSED',
  },
  startedAt,
  completedAt,
  provenance: {
    runner: basename(RUNNER),
    runnerSha256,
    sdkPackage: execution.packageEvidence,
  },
  browser: {
    engine: 'chromium',
    version: run.environment.browserVersion,
    profile: 'task-owned temporary profile',
    personalChromeAccessed: false,
  },
  fixture: {
    host: '127.0.0.1',
    portSelection: 'operating-system ephemeral port (listen port 0); 8377 forbidden',
    port: run.environment.fixturePort,
  },
  readers: {
    aria: 'Playwright whole-root ariaSnapshot used as a full-state reader. It is explicitly not a best directed host verifier.',
    receipt: 'Official createBaseline(root) before the action plus createReceipt(root, { baseline, expected, limits }) after the action, from the installed tarball bundle.',
    rootScope: '#receipt-root for both readers',
  },
  receiptLimits: RECEIPT_LIMITS,
  primary: {
    rowScales: ROW_SCALES,
    actionablesByScale: ROW_SCALES.map((rows) => rows + 1),
    repetitions: REPS,
    readOrder: 'balanced independently before and after; post order reverses pre order in each repetition',
    summary: primarySummary,
    trials: run.primaryTrials,
  },
  uncertaintyBoundary: {
    regionScales: UNCERTAINTY_SCALES,
    repetitions: REPS,
    composition: 'alternating visible canvas and sandboxed opaque iframe regions',
    procedure: 'Official baseline followed by an unchanged expected:false receipt on the same root; unobservable items are capped and total/truncated remain explicit.',
    summary: uncertaintySummary,
    trials: run.uncertaintyTrials,
  },
  measurements: {
    bytes: 'UTF-8 byte length of the exact retained ARIA string or exact JSON.stringify output from the official SDK object',
    wallTime: 'descriptive elapsed wall time around each Playwright-harness read; SDK browser work time is also retained separately',
    post: 'post-action ARIA full-state body or post-action SDK receipt body',
    cycle: 'sum of that reader\'s baseline body/time and post body/time; the SDK cycle explicitly includes createBaseline',
  },
  artifactArchive,
  integrity,
  caveats: [
    'ARIA and SDK bodies are not equivalent formats. ARIA is a whole-root full-state representation; the receipt is a typed selective post-action contract plus a compact baseline.',
    'The ARIA comparator is not the best directed host implementation. A host that already knows the target can verify a few DOM properties more cheaply than either reader.',
    'The fixture is authored, synthetic, and changes one fixed semantic region. It does not establish production-site behavior, model-token savings, task success, or commercial value.',
    'Wall times are not a speed comparison: implementations differ, readers execute sequentially, and this is one machine.',
    'Bytes exclude Playwright protocol framing and any downstream serialization chosen by a host.',
    'Receipt caps bound returned item arrays, not the baseline checkpoint. Totals and truncation are reported so omitted evidence is explicit.',
    'Playwright launches the isolated test browser only. The measured SDK is the zero-runtime-dependency ESM installed from the task-created tarball.',
  ],
}

await writeFile(ARTIFACT_OUTPUT, artifactCompressed, { flag: 'wx', mode: 0o600 })
await writeFile(RESULT_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({
  output: RESULT_OUTPUT,
  artifacts: ARTIFACT_OUTPUT,
  packageEvidence: execution.packageEvidence,
  primarySummary,
  uncertaintySummary,
  integrity,
}, null, 2))

async function executeFailClosed(bodies) {
  const cleanupErrors = []
  let sdkTemp
  let run
  let packageEvidence
  let runError
  try {
    sdkTemp = await mkdtemp(join(tmpdir(), 'snapdom-egress-v3-sdk-'))
    const installed = await installPackedSdk(sdkTemp)
    packageEvidence = installed.evidence
    run = await runInIsolatedBrowser(installed.bundleText, bodies)
  } catch (error) {
    runError = error
  } finally {
    try {
      if (sdkTemp) await rm(sdkTemp, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(new Error(`SDK install cleanup failed: ${errorMessage(error)}`))
    }
  }
  const sdkInstallRemoved = sdkTemp ? !(await exists(sdkTemp)) : false
  if (!sdkInstallRemoved) cleanupErrors.push(new Error(`temporary SDK install remained at ${sdkTemp}`))
  if (runError || cleanupErrors.length) {
    throw new AggregateError([...(runError ? [runError] : []), ...cleanupErrors], 'client-side-egress-v3 failed closed')
  }
  return { run, packageEvidence, sdkInstallRemoved }
}

async function installPackedSdk(temp) {
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
  ], { cwd: SDK, encoding: 'utf8' }))[0]
  if (!packed?.filename) throw new Error('npm pack did not report a tarball filename')
  const archive = join(temp, packed.filename)
  const install = join(temp, 'install')
  await mkdir(install)
  execFileSync('npm', [
    'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive,
  ], { cwd: install, stdio: 'pipe' })
  const installed = join(install, 'node_modules', '@zumer', 'snapdom-receipt')
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    if (Object.keys(pkg[field] || {}).length) throw new Error(`packed SDK ${field} must be empty`)
  }
  const manifestBytes = await readFile(join(installed, 'dist-manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const relativeBundle = pkg.exports?.['.']?.import
  if (typeof relativeBundle !== 'string') throw new Error('packed SDK is missing its ESM import export')
  const bundle = await readFile(join(installed, relativeBundle))
  if (manifest.bytes !== bundle.byteLength || manifest.sha256 !== sha256(bundle)) {
    throw new Error('installed SDK bundle does not match its manifest')
  }
  const archiveBytes = await readFile(archive)
  return {
    bundleText: bundle.toString('utf8'),
    evidence: {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      dependencyFieldsEmpty: true,
      tarball: {
        filename: packed.filename,
        byteLength: archiveBytes.byteLength,
        sha256: sha256(archiveBytes),
      },
      installedBundle: {
        path: relativeBundle,
        byteLength: bundle.byteLength,
        sha256: sha256(bundle),
      },
      installedManifestSha256: sha256(manifestBytes),
      manifestStaticEvidence: manifest.staticEvidence,
    },
  }
}

async function runInIsolatedBrowser(bundleText, bodies) {
  const primaryTrials = []
  const uncertaintyTrials = []
  const cleanupErrors = []
  let context
  let browser
  let server
  let profile
  let fixturePort
  let browserVersion
  let runError

  try {
    profile = await mkdtemp(join(tmpdir(), 'snapdom-client-egress-v3-'))
    server = createServer(fixtureHandler)
    fixturePort = await listenOnOsEphemeralPort(server)
    if (fixturePort === FORBIDDEN_PORT) throw new Error(`refusing forbidden fixture port ${FORBIDDEN_PORT}`)
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1100, height: 800 },
    })
    browser = context.browser()
    browserVersion = browser?.version() || null

    for (const rowCount of ROW_SCALES) {
      for (let rep = 0; rep < REPS; rep++) {
        const page = await context.newPage()
        try {
          primaryTrials.push(await runPrimaryTrial({ page, bundleText, fixturePort, rowCount, rep, bodies }))
        } finally {
          await page.close()
        }
      }
    }
    for (const regionCount of UNCERTAINTY_SCALES) {
      for (let rep = 0; rep < REPS; rep++) {
        const page = await context.newPage()
        try {
          uncertaintyTrials.push(await runUncertaintyTrial({ page, bundleText, fixturePort, regionCount, rep, bodies }))
        } finally {
          await page.close()
        }
      }
    }
  } catch (error) {
    runError = error
  } finally {
    try {
      if (context) await context.close()
    } catch (error) {
      cleanupErrors.push(new Error(`context cleanup failed: ${errorMessage(error)}`))
    } finally {
      try {
        if (browser?.isConnected()) await browser.close()
      } catch (error) {
        cleanupErrors.push(new Error(`browser fallback cleanup failed: ${errorMessage(error)}`))
      } finally {
        try {
          if (server?.listening) await closeServer(server)
        } catch (error) {
          cleanupErrors.push(new Error(`fixture cleanup failed: ${errorMessage(error)}`))
        } finally {
          try {
            if (profile) await rm(profile, { recursive: true, force: true })
          } catch (error) {
            cleanupErrors.push(new Error(`profile cleanup failed: ${errorMessage(error)}`))
          }
        }
      }
    }
  }

  const fixturePortClosed = await portClosed(fixturePort)
  const profileRemoved = profile ? !(await exists(profile)) : false
  if (!fixturePortClosed) cleanupErrors.push(new Error(`fixture port ${fixturePort} remained open`))
  if (!profileRemoved) cleanupErrors.push(new Error(`temporary profile remained at ${profile}`))
  if (runError || cleanupErrors.length) {
    throw new AggregateError([...(runError ? [runError] : []), ...cleanupErrors], 'isolated browser run failed closed')
  }
  return {
    primaryTrials,
    uncertaintyTrials,
    environment: {
      browserVersion,
      fixturePort,
      fixturePortSelection: 'operating-system ephemeral port',
      fixturePortClosed,
      profileRemoved,
    },
  }
}

async function runPrimaryTrial({ page, bundleText, fixturePort, rowCount, rep, bodies }) {
  const id = `rows-${rowCount}-rep-${rep}`
  await page.goto(`http://127.0.0.1:${fixturePort}/catalog?rows=${rowCount}&rep=${rep}`, { waitUntil: 'domcontentloaded' })
  await installSdkInPage(page, bundleText)
  const oraclePre = await primitiveCatalogOracle(page)
  const preOrder = rep % 2 === 0 ? ['receipt', 'aria'] : ['aria', 'receipt']
  const postOrder = [...preOrder].reverse()
  const pre = await readOrdered(preOrder, {
    receipt: () => readBaseline(page),
    aria: () => readAria(page),
  })
  await page.locator('#target').click()
  await page.waitForFunction(() =>
    globalThis.document.querySelector('#badge')?.textContent?.trim() === '1' &&
    globalThis.document.querySelector('#status')?.textContent?.trim() === 'Added Item 0')
  const oraclePost = await primitiveCatalogOracle(page)
  const post = await readOrdered(postOrder, {
    receipt: () => readReceipt(page, { changed: true }),
    aria: () => readAria(page),
  })

  const ariaContract = ariaEvidenceContract(pre.aria.body, post.aria.body)
  const receiptContract = receiptEvidenceContract(pre.receipt.parsed, post.receipt.parsed)
  const oracleContract = primitiveContract(oraclePre, oraclePost, rowCount)
  const refs = {
    ariaPre: retainBody(bodies, { id: `${id}:aria:pre`, trialId: id, reader: 'aria-full-state', phase: 'pre', mediaType: 'text/yaml; profile=playwright-aria-snapshot', body: pre.aria.body }),
    ariaPost: retainBody(bodies, { id: `${id}:aria:post`, trialId: id, reader: 'aria-full-state', phase: 'post', mediaType: 'text/yaml; profile=playwright-aria-snapshot', body: post.aria.body }),
    receiptBaseline: retainBody(bodies, { id: `${id}:receipt:baseline`, trialId: id, reader: 'browser-sdk-receipt', phase: 'baseline', mediaType: 'application/json; profile=snapdom-action-baseline-v1', body: pre.receipt.body }),
    receiptPost: retainBody(bodies, { id: `${id}:receipt:post`, trialId: id, reader: 'browser-sdk-receipt', phase: 'post', mediaType: 'application/json; profile=snapdom-action-receipt-v1', body: post.receipt.body }),
  }
  return {
    id,
    rowCount,
    rep,
    readOrder: { pre: preOrder, post: postOrder },
    oracle: { pre: oraclePre, post: oraclePost, contractPass: oracleContract },
    contracts: { aria: ariaContract, receipt: receiptContract },
    aria: {
      baseline: metric(pre.aria, refs.ariaPre),
      post: metric(post.aria, refs.ariaPost),
      cycle: combinedMetric(pre.aria, post.aria),
    },
    receipt: {
      baseline: {
        ...metric(pre.receipt, refs.receiptBaseline),
        contract: pre.receipt.parsed.contract,
        checkpointNodes: pre.receipt.parsed.checkpoint.nodes.length,
      },
      post: {
        ...metric(post.receipt, refs.receiptPost),
        parsed: post.receipt.parsed,
        taskOutcome: post.receipt.parsed.taskOutcome,
        postconditionOutcome: post.receipt.parsed.postcondition.outcome,
        changes: boundedMetric(post.receipt.parsed.observed.changes),
        actionabilityCovered: boundedMetric(post.receipt.parsed.observed.actionabilityDelta.becameCovered),
        actionabilityVisible: boundedMetric(post.receipt.parsed.observed.actionabilityDelta.becameVisible),
        unobservable: boundedMetric(post.receipt.parsed.observed.unobservable),
      },
      cycle: combinedMetric(pre.receipt, post.receipt),
    },
  }
}

async function runUncertaintyTrial({ page, bundleText, fixturePort, regionCount, rep, bodies }) {
  const id = `uncertainty-${regionCount}-rep-${rep}`
  await page.goto(`http://127.0.0.1:${fixturePort}/uncertainty?regions=${regionCount}&rep=${rep}`, { waitUntil: 'domcontentloaded' })
  await installSdkInPage(page, bundleText)
  const oracle = await page.evaluate(() => ({
    canvases: globalThis.document.querySelectorAll('#receipt-root canvas').length,
    opaqueIframes: globalThis.document.querySelectorAll('#receipt-root iframe[sandbox]').length,
    totalRegions: globalThis.document.querySelectorAll('#receipt-root canvas,#receipt-root iframe[sandbox]').length,
  }))
  const baseline = await readBaseline(page)
  const post = await readReceipt(page, { changed: false })
  const refs = {
    baseline: retainBody(bodies, { id: `${id}:receipt:baseline`, trialId: id, reader: 'browser-sdk-receipt', phase: 'uncertainty-baseline', mediaType: 'application/json; profile=snapdom-action-baseline-v1', body: baseline.body }),
    post: retainBody(bodies, { id: `${id}:receipt:post`, trialId: id, reader: 'browser-sdk-receipt', phase: 'uncertainty-post', mediaType: 'application/json; profile=snapdom-action-receipt-v1', body: post.body }),
  }
  return {
    id,
    regionCount,
    rep,
    oracle,
    receipt: {
      baseline: metric(baseline, refs.baseline),
      post: {
        ...metric(post, refs.post),
        parsed: post.parsed,
        taskOutcome: post.parsed.taskOutcome,
        postconditionOutcome: post.parsed.postcondition.outcome,
        unobservable: boundedMetric(post.parsed.observed.unobservable),
      },
      cycle: combinedMetric(baseline, post),
    },
  }
}

async function installSdkInPage(page, bundleText) {
  await page.evaluate(async (source) => {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([source], { type: 'text/javascript' }))
    try {
      globalThis.__snapdomReceiptSdk = await import(url)
    } finally {
      globalThis.URL.revokeObjectURL(url)
    }
  }, bundleText)
}

async function readBaseline(page) {
  const external = await timed(() => page.evaluate(() => {
    const root = globalThis.document.querySelector('#receipt-root')
    const started = performance.now()
    const baseline = globalThis.__snapdomReceiptSdk.createBaseline(root)
    globalThis.__snapdomReceiptBaseline = baseline
    const body = JSON.stringify(baseline)
    return { body, browserWorkMs: performance.now() - started }
  }))
  const parsed = JSON.parse(external.value.body)
  validateBaseline(parsed)
  return bodyObservation(external, parsed)
}

async function readReceipt(page, expected) {
  const external = await timed(() => page.evaluate(({ expectedValue, limits }) => {
    const root = globalThis.document.querySelector('#receipt-root')
    const started = performance.now()
    const receipt = globalThis.__snapdomReceiptSdk.createReceipt(root, {
      baseline: globalThis.__snapdomReceiptBaseline,
      expected: expectedValue,
      limits,
    })
    const body = JSON.stringify(receipt)
    return { body, browserWorkMs: performance.now() - started }
  }, { expectedValue: expected, limits: RECEIPT_LIMITS }))
  const parsed = JSON.parse(external.value.body)
  validateReceipt(parsed, expected)
  return bodyObservation(external, parsed)
}

function bodyObservation(external, parsed) {
  const body = external.value.body
  return {
    body,
    parsed,
    byteLength: utf8Bytes(body),
    wallMs: external.elapsedMs,
    browserWorkMs: round(external.value.browserWorkMs),
  }
}

async function readAria(page) {
  const { value: body, elapsedMs } = await timed(() => page.locator('#receipt-root').ariaSnapshot())
  if (typeof body !== 'string') throw new Error('ARIA snapshot did not return a string')
  return { body, byteLength: utf8Bytes(body), wallMs: elapsedMs }
}

async function readOrdered(order, readers) {
  const output = {}
  for (const reader of order) output[reader] = await readers[reader]()
  return output
}

function validateBaseline(baseline) {
  if (baseline?.contract !== 'snapdom.action-baseline/v1' || baseline.version !== 1 || baseline.checkpoint?.version !== 2) {
    throw new Error(`unexpected SDK baseline contract: ${baseline?.contract}`)
  }
}

function validateReceipt(receipt, expected) {
  if (receipt?.contract !== 'snapdom.action-receipt/v1' || receipt.version !== 1) {
    throw new Error(`unexpected SDK receipt contract: ${receipt?.contract}`)
  }
  if (receipt.taskOutcome !== 'NOT_ASSESSED') throw new Error(`unexpected taskOutcome: ${receipt.taskOutcome}`)
  if (receipt.postcondition?.kind !== 'changed' || receipt.postcondition?.expected?.changed !== expected.changed) {
    throw new Error(`unexpected nested postcondition: ${JSON.stringify(receipt.postcondition)}`)
  }
  if (JSON.stringify(receipt.limits) !== JSON.stringify(RECEIPT_LIMITS)) {
    throw new Error(`receipt limits differ from protocol: ${JSON.stringify(receipt.limits)}`)
  }
  if (!boundedSectionsConsistent(receipt)) throw new Error('receipt bounded sections are inconsistent')
}

function fixtureHandler(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/catalog') {
    const rowCount = Number(url.searchParams.get('rows'))
    if (!ROW_SCALES.includes(rowCount)) return notFound(response)
    return html(response, catalogFixture(rowCount))
  }
  if (url.pathname === '/uncertainty') {
    const regionCount = Number(url.searchParams.get('regions'))
    if (!UNCERTAINTY_SCALES.includes(regionCount)) return notFound(response)
    return html(response, uncertaintyFixture(regionCount))
  }
  return notFound(response)
}

function catalogFixture(rowCount) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Browser SDK egress fixture ${rowCount}</title>
<style>
body{font:14px system-ui;margin:0}header{position:sticky;top:0;background:white;padding:12px;border-bottom:1px solid #ddd;z-index:2}
main{padding:12px}.row{display:flex;align-items:center;gap:12px;min-height:34px}.row p{margin:0;color:#555}.row button{min-width:120px}
</style></head><body><div id="receipt-root">
<header id="summary" role="banner" aria-label="Cart 0 | Ready"><button id="cart">Cart <span id="badge">0</span></button><span id="status" role="status">Ready</span></header>
<main aria-label="Catalog">
${Array.from({ length: rowCount }, (_, index) => `<article class="row"><h2>Item ${index}</h2><p>Catalog description ${index}</p><button ${index === 0 ? 'id="target"' : ''}>Add Item ${index}</button></article>`).join('')}
</main></div><script>
document.getElementById('target').addEventListener('click', () => {
  document.getElementById('badge').textContent = '1';
  document.getElementById('status').textContent = 'Added Item 0';
  document.getElementById('summary').setAttribute('aria-label', 'Cart 1 | Added Item 0');
});
</script></body></html>`
}

function uncertaintyFixture(regionCount) {
  const regions = Array.from({ length: regionCount }, (_, index) => index % 2 === 0
    ? `<canvas width="320" height="36" aria-label="Opaque canvas ${index}"></canvas>`
    : `<iframe sandbox="" title="Opaque frame ${index}" srcdoc="&lt;p&gt;opaque ${index}&lt;/p&gt;"></iframe>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Uncertainty ${regionCount}</title>
<style>body{font:14px system-ui;margin:16px}.regions{display:grid;gap:4px}canvas,iframe{display:block;width:320px;height:36px;border:1px solid #aaa}</style>
</head><body><section id="receipt-root"><h1>Uncertainty boundary</h1><div class="regions">${regions}</div></section></body></html>`
}

function html(response, body) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function notFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
}

async function primitiveCatalogOracle(page) {
  return await page.evaluate(() => ({
    badge: globalThis.document.querySelector('#badge')?.textContent?.trim() || null,
    status: globalThis.document.querySelector('#status')?.textContent?.trim() || null,
    bannerLabel: globalThis.document.querySelector('#summary')?.getAttribute('aria-label') || null,
    rows: globalThis.document.querySelectorAll('#receipt-root main .row').length,
    actionables: globalThis.document.querySelectorAll('#receipt-root button').length,
  }))
}

function primitiveContract(pre, post, expectedRows) {
  return pre.badge === '0' && pre.status === 'Ready' && pre.bannerLabel === 'Cart 0 | Ready' &&
    pre.rows === expectedRows && pre.actionables === expectedRows + 1 &&
    post.badge === '1' && post.status === 'Added Item 0' && post.bannerLabel === 'Cart 1 | Added Item 0' &&
    post.rows === expectedRows && post.actionables === expectedRows + 1
}

function ariaEvidenceContract(preBody, postBody) {
  const pre = String(preBody)
  const post = String(postBody)
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

function receiptEvidenceContract(baseline, receipt) {
  const changes = receipt.observed?.changes?.items || []
  const before = compactCheckpointNodes(baseline.checkpoint)
  const transition = (role, beforeName, name) => changes.some((change) => {
    if (change.role !== role || change.name !== name) return false
    if (change.kind === 'possible-replacement') {
      return change.match === 'ambiguous' && change.beforeName === beforeName
    }
    return change.kind === 'content' && before.get(change.id)?.role === role &&
      before.get(change.id)?.name === beforeName
  })
  const checks = {
    baselineContract: baseline.contract === 'snapdom.action-baseline/v1' && baseline.version === 1,
    receiptContract: receipt.contract === 'snapdom.action-receipt/v1' && receipt.version === 1,
    taskOutcomeNotAssessed: receipt.taskOutcome === 'NOT_ASSESSED',
    nestedChangedPostcondition: receipt.postcondition?.kind === 'changed' &&
      receipt.postcondition?.expected?.changed === true && receipt.postcondition?.outcome === 'PASS',
    observedChanged: receipt.observed?.changed === true,
    bannerDirection: transition('banner', 'Cart 0 | Ready', 'Cart 1 | Added Item 0'),
    badgeDirection: transition('generic', '0', '1'),
    statusDirection: transition('status', 'Ready', 'Added Item 0'),
    capsReported: JSON.stringify(receipt.limits) === JSON.stringify(RECEIPT_LIMITS),
    truncationReported: boundedSectionsConsistent(receipt),
  }
  return { checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function runDirectionalContractFixture() {
  const bounded = (items) => ({ items, total: items.length, truncated: 0 })
  const baseline = {
    contract: 'snapdom.action-baseline/v1',
    version: 1,
    checkpoint: {
      version: 2,
      tables: [['div'], ['banner', 'status'], ['00000000']],
      nodes: [
        ['n_banner', -1, 0, 0, 0, '', 0, null, 1 << 7, 'Cart 0 | Ready'],
        ['n_badge', -1, 0, -1, 0, '', 0, null, 1 << 7, '0'],
        ['n_status', -1, 0, 1, 0, '', 0, null, 1 << 7, 'Ready'],
      ],
    },
  }
  const changes = [
    { kind: 'possible-replacement', match: 'ambiguous', role: 'banner', beforeName: 'Cart 0 | Ready', name: 'Cart 1 | Added Item 0' },
    { kind: 'possible-replacement', match: 'ambiguous', role: 'generic', beforeName: '0', name: '1' },
    { kind: 'possible-replacement', match: 'ambiguous', role: 'status', beforeName: 'Ready', name: 'Added Item 0' },
  ]
  const receipt = {
    contract: 'snapdom.action-receipt/v1',
    version: 1,
    taskOutcome: 'NOT_ASSESSED',
    postcondition: { kind: 'changed', expected: { changed: true }, outcome: 'PASS', reason: 'changed is true' },
    observed: {
      changed: true,
      torn: 0,
      changes: bounded(changes),
      actionabilityDelta: { becameCovered: bounded([]), becameVisible: bounded([]) },
      unobservable: bounded([]),
    },
    privacy: { rulesActive: 0, applied: false },
    limits: { ...RECEIPT_LIMITS },
  }
  const positive = receiptEvidenceContract(baseline, receipt)
  const wrongDirection = globalThis.structuredClone(receipt)
  wrongDirection.observed.changes.items[2].beforeName = 'Not Ready'
  const negative = receiptEvidenceContract(baseline, wrongDirection)
  if (!positive.exactPrePost || negative.exactPrePost) {
    throw new Error(`directional contract fixture failed: ${JSON.stringify({ positive, negative })}`)
  }
  return {
    possibleReplacementBeforeNameToNameAccepted: true,
    allThreeExactFactsRequired: true,
    wrongDirectionRejected: true,
    checks: positive.checks,
  }
}

function compactCheckpointNodes(checkpoint) {
  const roles = checkpoint.tables?.[1] || []
  const nodes = new Map()
  for (const row of checkpoint.nodes || []) {
    const id = row[0]
    const role = row[3] < 0 ? 'generic' : roles[row[3]]
    const bits = row[8]
    let index = 9
    for (const bit of [1 << 0, 1 << 1, 1 << 2, 1 << 3, 1 << 4, 1 << 5, 1 << 6]) {
      if (bits & bit) index++
    }
    const name = bits & (1 << 7) ? row[index] : ''
    nodes.set(id, { role, name })
  }
  return nodes
}

function boundedSectionsConsistent(receipt) {
  const sections = [
    receipt?.observed?.changes,
    receipt?.observed?.actionabilityDelta?.becameCovered,
    receipt?.observed?.actionabilityDelta?.becameVisible,
    receipt?.observed?.unobservable,
  ]
  return sections.every((section) => section && Array.isArray(section.items) &&
    Number.isInteger(section.total) && Number.isInteger(section.truncated) &&
    section.total >= section.items.length && section.truncated === section.total - section.items.length)
}

function boundedMetric(section) {
  return { items: section.items.length, total: section.total, truncated: section.truncated }
}

function retainBody(bodies, entry) {
  const byteLength = utf8Bytes(entry.body)
  const digest = sha256(entry.body)
  bodies.push({ ...entry, byteLength, sha256: digest })
  return { id: entry.id, byteLength, sha256: digest, mediaType: entry.mediaType }
}

function metric(observation, artifact) {
  return {
    bytes: observation.byteLength,
    wallMs: observation.wallMs,
    ...(Number.isFinite(observation.browserWorkMs) ? { browserWorkMs: observation.browserWorkMs } : {}),
    artifact,
  }
}

function combinedMetric(pre, post) {
  return { bytes: pre.byteLength + post.byteLength, wallMs: round(pre.wallMs + post.wallMs) }
}

function summarizePrimary(trials) {
  return ROW_SCALES.map((rowCount) => {
    const rows = trials.filter((trial) => trial.rowCount === rowCount)
    return {
      rowCount,
      actionables: rowCount + 1,
      repetitions: rows.length,
      ariaFullState: summarizeReader(rows, 'aria'),
      browserSdkReceipt: summarizeReader(rows, 'receipt'),
      contractsExact: {
        aria: rows.every((trial) => trial.contracts.aria.exactPrePost),
        receipt: rows.every((trial) => trial.contracts.receipt.exactPrePost),
        primitiveOracle: rows.every((trial) => trial.oracle.contractPass),
      },
      receiptTruncation: {
        medianChangesTotal: median(rows.map((trial) => trial.receipt.post.changes.total)),
        medianChangesTruncated: median(rows.map((trial) => trial.receipt.post.changes.truncated)),
      },
    }
  })
}

function summarizeReader(rows, reader) {
  return {
    medianBaselineBytes: median(rows.map((trial) => trial[reader].baseline.bytes)),
    medianBaselineWallMs: median(rows.map((trial) => trial[reader].baseline.wallMs)),
    medianPostBytes: median(rows.map((trial) => trial[reader].post.bytes)),
    medianPostWallMs: median(rows.map((trial) => trial[reader].post.wallMs)),
    medianCycleBytes: median(rows.map((trial) => trial[reader].cycle.bytes)),
    medianCycleWallMs: median(rows.map((trial) => trial[reader].cycle.wallMs)),
  }
}

function summarizeUncertainty(trials) {
  return UNCERTAINTY_SCALES.map((regionCount) => {
    const rows = trials.filter((trial) => trial.regionCount === regionCount)
    return {
      regionCount,
      repetitions: rows.length,
      medianBaselineBytes: median(rows.map((trial) => trial.receipt.baseline.bytes)),
      medianReceiptBytes: median(rows.map((trial) => trial.receipt.post.bytes)),
      medianCycleBytes: median(rows.map((trial) => trial.receipt.cycle.bytes)),
      medianReceiptWallMs: median(rows.map((trial) => trial.receipt.post.wallMs)),
      medianUnobservableTotal: median(rows.map((trial) => trial.receipt.post.unobservable.total)),
      medianUnobservableItems: median(rows.map((trial) => trial.receipt.post.unobservable.items)),
      medianUnobservableTruncated: median(rows.map((trial) => trial.receipt.post.unobservable.truncated)),
      allTotalsExact: rows.every((trial) => trial.receipt.post.unobservable.total === trial.oracle.totalRegions),
      allOutcomesHonest: rows.every((trial) => trial.receipt.post.postconditionOutcome === (regionCount === 0 ? 'PASS' : 'UNKNOWN')),
    }
  })
}

function balancedOrder(trials, phase) {
  return ROW_SCALES.every((rowCount) => {
    const rows = trials.filter((trial) => trial.rowCount === rowCount)
    return rows.filter((trial) => trial.readOrder[phase][0] === 'receipt').length === REPS / 2 &&
      rows.filter((trial) => trial.readOrder[phase][0] === 'aria').length === REPS / 2
  })
}

function collectArtifactIds(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, found)
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && typeof value.sha256 === 'string' && Number.isInteger(value.byteLength)) found.add(value.id)
    for (const item of Object.values(value)) collectArtifactIds(item, found)
  }
  return found
}

async function listenOnOsEphemeralPort(server) {
  await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
  })
  const address = server.address()
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) throw new Error('OS did not report an ephemeral fixture port')
  return address.port
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

async function portClosed(port) {
  if (!Number.isInteger(port)) return false
  return await new Promise((resolveClosed) => {
    const request = get({ host: '127.0.0.1', port, path: '/', timeout: 300 }, () => {
      request.destroy()
      resolveClosed(false)
    })
    request.on('error', () => resolveClosed(true))
    request.on('timeout', () => {
      request.destroy()
      resolveClosed(false)
    })
  })
}

async function timed(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, elapsedMs: round(performance.now() - started) }
}

async function assertAbsent(path) {
  if (await exists(path)) throw new Error(`refusing to overwrite existing evidence: ${path}`)
}

async function exists(path) {
  return await stat(path).then(() => true, () => false)
}

function assertIntegrity(label, value, checks) {
  const failures = checks.filter(([, pass]) => !pass).map(([name]) => name)
  if (failures.length) throw new Error(`${label} integrity failed (${failures.join(', ')}): ${JSON.stringify(value)}`)
}

function argumentPath(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`)
  return resolve(process.cwd(), value)
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function median(values) {
  if (!values.length) throw new Error('median requires at least one value')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2)
}

function round(value) {
  return Math.round(value * 100) / 100
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
