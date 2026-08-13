/**
 * Fair incremental-value experiment:
 *   H   = a strong, directed host verifier
 *   H+R = the exact same verifier plus the packed browser receipt SDK
 *
 * Playwright is test scaffolding only. Chromium always uses a temporary profile;
 * the fixture is loopback-only on an OS-assigned port that may never be 8377.
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER = fileURLToPath(import.meta.url)
const SDK_DIR = join(ROOT, 'browser-sdk')
const PREREG = join(ROOT, 'experiment', 'results', 'directed-host-receipt-value.preregistration.json')
const RESULT = join(ROOT, 'experiment', 'results', 'directed-host-receipt-value.json')
const REPETITIONS = 5
const DECOYS = 3000
const CASES = Object.freeze([
  { id: 'intended', truth: 'PASS' },
  { id: 'wrong-target', truth: 'FAIL' },
  { id: 'occlusion', truth: 'FAIL' },
  { id: 'unknown', truth: 'FAIL' },
])

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value))
const round = (value, digits = 3) => Number(Number(value).toFixed(digits))
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Directed host receipt fixture</title>
  <style>
    * { box-sizing: border-box }
    body { margin: 0; color: #142033; font: 14px/1.4 system-ui, sans-serif; background: #f4f7fb }
    main { width: min(960px, calc(100% - 32px)); margin: 16px auto }
    #operation-scope { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px; background: white; border: 1px solid #ccd5e2 }
    #operation-scope > h1 { grid-column: 1 / -1; margin: 0 }
    .card { min-height: 150px; padding: 16px; border: 1px solid #9eacc0; background: white }
    .status { display: inline-block; min-width: 90px; padding: 4px 8px; background: #eef2f7 }
    button { min-height: 34px; padding: 6px 12px }
    #decoys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 20px }
    #decoys article { min-height: 52px; padding: 4px; border: 1px solid #dfe5ed; background: white }
    #decoys h2 { display: inline; margin: 0; font-size: 12px }
    #decoys button { float: right; min-height: 26px; padding: 2px 5px }
  </style>
</head>
<body>
  <main>
    <section id="operation-scope" data-testid="operation-scope">
      <h1>Approval queue</h1>
      <article id="target-card" class="card" data-testid="target-card">
        <h2>Target account</h2>
        <p>Status <span id="target-status" class="status" data-testid="target-status">Ready</span></p>
        <button id="target-action" data-testid="target-action">Approve target</button>
        <div id="target-output"></div>
      </article>
      <article id="neighbor-card" class="card" data-testid="neighbor-card">
        <h2>Neighbor account</h2>
        <p>Status <span id="neighbor-status" class="status" data-testid="neighbor-status">Ready</span></p>
        <button id="neighbor-action" data-testid="neighbor-action">Approve neighbor</button>
      </article>
    </section>
    <section id="decoys" aria-label="Unrelated records"></section>
  </main>
  <script>
    (() => {
      const decoys = document.querySelector('#decoys')
      const fragment = document.createDocumentFragment()
      for (let i = 0; i < ${DECOYS}; i++) {
        const card = document.createElement('article')
        card.innerHTML = '<h2>Record ' + i + '</h2><span>Pending</span><button>Inspect ' + i + '</button>'
        fragment.appendChild(card)
      }
      decoys.appendChild(fragment)

      window.__applyDirectedFixtureEffect = (variant) => {
        const target = document.querySelector('#target-status')
        const neighbor = document.querySelector('#neighbor-status')
        if (variant === 'intended') {
          target.textContent = 'Approved'
        } else if (variant === 'wrong-target') {
          neighbor.textContent = 'Approved'
        } else if (variant === 'occlusion') {
          target.textContent = 'Approved'
          const button = document.querySelector('#target-action')
          const rect = button.getBoundingClientRect()
          const blocker = document.createElement('div')
          blocker.id = 'action-blocker'
          blocker.dataset.testid = 'action-blocker'
          blocker.setAttribute('aria-label', 'Approval safety overlay')
          blocker.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:auto;' +
            'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height +
            'px;background:rgba(180,0,0,.08)'
          document.body.appendChild(blocker)
        } else if (variant === 'unknown') {
          target.textContent = 'Approved'
          const canvas = document.createElement('canvas')
          canvas.width = 8
          canvas.height = 8
          canvas.dataset.testid = 'opaque-risk-indicator'
          canvas.setAttribute('aria-label', 'Risk indicator')
          canvas.style.cssText = 'display:block;width:32px;height:32px;margin-top:8px'
          const context = canvas.getContext('2d')
          context.fillStyle = 'rgb(255,0,0)'
          context.fillRect(0, 0, 8, 8)
          document.querySelector('#target-output').appendChild(canvas)
        } else {
          throw new Error('unknown fixture effect')
        }
        document.body.dataset.effectApplied = 'true'
      }
    })()
  </script>
</body>
</html>`
}

function installRuntimeSource() {
  /* global Blob, TextEncoder, URL, customElements, document, performance, window */
  // This function is serialized into the isolated page. Its four directed predicates
  // are shared byte-for-byte by H and H+R.
  return async ({ bundleText }) => {
    const moduleUrl = URL.createObjectURL(new Blob([bundleText], { type: 'text/javascript' }))
    const sdk = await import(moduleUrl)
    const state = {}
    const receiptLimits = Object.freeze({
      changes: 24,
      actionability: 12,
      unobservable: 12,
    })

    const marker = (element) => {
      if (!element) return null
      return element.getAttribute('data-testid') || element.id || element.localName
    }

    const evidenceGaps = (scope) => {
      const gaps = []
      for (const element of scope.querySelectorAll('*')) {
        const tag = element.localName
        let sourceType = null
        if (tag === 'canvas') sourceType = 'canvas'
        else if (tag === 'iframe') sourceType = 'iframe'
        else if (tag.includes('-') && customElements.get(tag) && !element.shadowRoot) {
          sourceType = 'possible-closed-shadow'
        }
        if (sourceType) gaps.push({ sourceType, marker: marker(element) })
      }
      return gaps
    }

    const directedCapture = () => {
      const scope = document.querySelector('#operation-scope')
      const targetAction = scope.querySelector('#target-action')
      const rect = targetAction.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        targetStatus: scope.querySelector('#target-status').textContent.trim(),
        neighborStatus: scope.querySelector('#neighbor-status').textContent.trim(),
        targetHittable: top === targetAction || targetAction.contains(top),
        topAtTarget: marker(top),
        evidenceGaps: evidenceGaps(scope),
      }
    }

    const directedVerify = (before) => {
      const after = directedCapture()
      const checks = [
        {
          id: 'target-transition',
          pass: before.targetStatus === 'Ready' && after.targetStatus === 'Approved',
          before: before.targetStatus,
          after: after.targetStatus,
        },
        {
          id: 'neighbor-stable',
          pass: before.neighborStatus === 'Ready' && after.neighborStatus === 'Ready',
          before: before.neighborStatus,
          after: after.neighborStatus,
        },
        {
          id: 'target-actionable',
          pass: after.targetHittable,
          topAtTarget: after.topAtTarget,
        },
        {
          id: 'scope-observable',
          pass: after.evidenceGaps.length === 0,
          evidenceGaps: after.evidenceGaps,
        },
      ]
      const observable = checks.find((check) => check.id === 'scope-observable').pass
      const effectChecks = checks.filter((check) => check.id !== 'scope-observable')
      const verdict = !observable ? 'UNKNOWN' : (effectChecks.every((check) => check.pass) ? 'PASS' : 'FAIL')
      return { schemaVersion: 1, verdict, checks, observed: { before, after } }
    }

    const receiptStart = async (root) => {
      if (typeof sdk.createBaseline !== 'function' || typeof sdk.createReceipt !== 'function') {
        throw new Error('installed SDK does not expose createBaseline/createReceipt')
      }
      return {
        adapter: 'createBaseline+createReceipt',
        baseline: await sdk.createBaseline(root),
        apiCalls: 1,
      }
    }

    const receiptFinish = async (root, baseline) => {
      return {
        adapter: baseline.adapter,
        apiCalls: 1,
        publicReceipt: await sdk.createReceipt(root, {
          baseline: baseline.baseline,
          expected: { changed: true },
          limits: receiptLimits,
        }),
      }
    }

    window.__directedValueExperiment = {
      sdkExports: Object.keys(sdk).sort(),
      async start(arm) {
        const started = performance.now()
        const before = directedCapture()
        if (arm === 'H') {
          state.H = { before }
          return {
            elapsedMs: performance.now() - started,
            hostCalls: 1,
            receiptApiCalls: 0,
            baselineStateBytes: new TextEncoder().encode(JSON.stringify(before)).byteLength,
          }
        }
        const receipt = await receiptStart(document.querySelector('#operation-scope'))
        state.HR = { before, receipt }
        return {
          elapsedMs: performance.now() - started,
          hostCalls: 1,
          receiptApiCalls: receipt.apiCalls,
          baselineStateBytes: new TextEncoder().encode(JSON.stringify(before)).byteLength,
          receiptCheckpointBytes: new TextEncoder().encode(JSON.stringify(receipt.baseline)).byteLength,
          receiptAdapter: receipt.adapter,
        }
      },
      async finish(arm) {
        const started = performance.now()
        if (arm === 'H') {
          const evidence = directedVerify(state.H.before)
          return {
            verdict: evidence.verdict,
            evidence,
            evidenceBytes: new TextEncoder().encode(JSON.stringify(evidence)).byteLength,
            elapsedMs: performance.now() - started,
            hostCalls: 1,
            receiptApiCalls: 0,
          }
        }
        const host = directedVerify(state.HR.before)
        const receipt = await receiptFinish(document.querySelector('#operation-scope'), state.HR.receipt)
        const receiptUncertain = receipt.publicReceipt.postcondition.outcome === 'UNKNOWN' ||
          receipt.publicReceipt.observed.torn > 0 ||
          receipt.publicReceipt.observed.unobservable.total > 0
        const verdict = receiptUncertain ? 'UNKNOWN' : host.verdict
        const evidence = {
          schemaVersion: 1,
          verdict,
          host,
          receipt: receipt.publicReceipt,
        }
        return {
          verdict,
          evidence,
          evidenceBytes: new TextEncoder().encode(JSON.stringify(evidence)).byteLength,
          elapsedMs: performance.now() - started,
          hostCalls: 1,
          receiptApiCalls: receipt.apiCalls,
          receiptAdapter: receipt.adapter,
        }
      },
      dispose() {
        URL.revokeObjectURL(moduleUrl)
      },
    }
    return { exports: window.__directedValueExperiment.sdkExports }
  }
}

function oracleSource() {
  // Separate primitive reader: it neither calls the arms nor consults receipt output.
  return () => {
    const doc = globalThis.document
    const scope = doc.querySelector('#operation-scope')
    const targetAction = scope.querySelector('#target-action')
    const rect = targetAction.getBoundingClientRect()
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const canvas = scope.querySelector('canvas')
    let harmfulCanvas = false
    let pixel = null
    if (canvas) {
      pixel = [...canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data]
      harmfulCanvas = pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255
    }
    const facts = {
      targetStatus: scope.querySelector('#target-status').textContent.trim(),
      neighborStatus: scope.querySelector('#neighbor-status').textContent.trim(),
      targetHittable: top === targetAction || targetAction.contains(top),
      topAtTarget: top?.getAttribute('data-testid') || top?.id || top?.localName || null,
      harmfulCanvas,
      pixel,
    }
    const verdict = facts.targetStatus === 'Approved' &&
      facts.neighborStatus === 'Ready' && facts.targetHittable && !facts.harmfulCanvas
      ? 'PASS'
      : 'FAIL'
    return { verdict, facts }
  }
}

async function listenOnSafeEphemeralPort(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    if (port !== 8377) return port
    await new Promise((resolve) => server.close(resolve))
  }
  throw new Error('could not obtain an OS-assigned port other than 8377')
}

const closeServer = (server) => new Promise((resolve) => {
  if (!server.listening) return resolve()
  server.close(resolve)
})

function summarizeArm(trials, key) {
  const rows = trials.map((trial) => ({ trial, arm: trial.arms[key] }))
  const total = rows.length
  const verdictCounts = Object.fromEntries(['PASS', 'FAIL', 'UNKNOWN', 'OP_ERROR'].map((verdict) => [
    verdict,
    rows.filter(({ arm }) => arm.verdict === verdict).length,
  ]))
  const correct = rows.filter(({ trial, arm }) => arm.verdict === trial.oracle.verdict).length
  const falseGreen = rows.filter(({ trial, arm }) => trial.oracle.verdict === 'FAIL' && arm.verdict === 'PASS').length
  const falseNegative = rows.filter(({ trial, arm }) => trial.oracle.verdict === 'PASS' && arm.verdict === 'FAIL').length
  return {
    scheduled: total,
    correct,
    correctnessRate: round(correct / total),
    falseGreen,
    falseNegative,
    unknown: verdictCounts.UNKNOWN,
    opError: verdictCounts.OP_ERROR,
    verdictCounts,
    evidenceBytes: {
      median: median(rows.map(({ arm }) => arm.evidenceBytes)),
      min: Math.min(...rows.map(({ arm }) => arm.evidenceBytes)),
      max: Math.max(...rows.map(({ arm }) => arm.evidenceBytes)),
    },
    browserWallMs: {
      medianBaseline: round(median(rows.map(({ arm }) => arm.baseline.elapsedMs))),
      medianPost: round(median(rows.map(({ arm }) => arm.elapsedMs))),
      medianCycle: round(median(rows.map(({ arm }) => arm.baseline.elapsedMs + arm.elapsedMs))),
      interpretation: 'descriptive browser-side reader wall time; not a speed-superiority metric',
    },
  }
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'snapdom-directed-host-value-'))
  const preregBytes = readFileSync(PREREG)
  const runnerBytes = readFileSync(RUNNER)
  let context
  let server

  try {
    execFileSync(process.execPath, [join(SDK_DIR, 'build.mjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    })
    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
    ], { cwd: SDK_DIR, encoding: 'utf8' }))[0]
    const tarballPath = join(temp, packed.filename)
    const installDir = join(temp, 'install')
    mkdirSync(installDir)
    execFileSync('npm', [
      'install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--package-lock=false', tarballPath,
    ], { cwd: installDir, stdio: 'pipe' })

    const installedDir = join(installDir, 'node_modules', '@zumer', 'snapdom-receipt')
    const installedPackage = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      assert.deepEqual(installedPackage[field] || {}, {}, `installed ${field} must be empty`)
    }
    const bundlePath = join(installedDir, installedPackage.exports['.'].import)
    const bundleBytes = readFileSync(bundlePath)
    const bundleText = bundleBytes.toString('utf8')
    const distManifest = JSON.parse(readFileSync(join(installedDir, 'dist-manifest.json'), 'utf8'))
    assert.equal(distManifest.sha256, sha256(bundleBytes), 'installed bundle hash must match manifest')

    const html = fixtureHtml()
    const servedRequests = []
    server = createServer((request, response) => {
      servedRequests.push(request.url)
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(html)
    })
    const port = await listenOnSafeEphemeralPort(server)
    assert.notEqual(port, 8377)
    const baseUrl = `http://127.0.0.1:${port}/`

    /* eslint-disable no-undef */
    context = await chromium.launchPersistentContext(join(temp, 'chromium-profile'), {
      headless: true,
      viewport: { width: 1280, height: 900 },
    })
    const unexpectedRequests = []
    context.on('request', (request) => {
      const url = new URL(request.url())
      if (url.protocol === 'blob:' || url.protocol === 'data:') return
      if (url.origin !== new URL(baseUrl).origin) unexpectedRequests.push(request.url())
    })

    const trials = []
    for (let caseIndex = 0; caseIndex < CASES.length; caseIndex++) {
      const scenario = CASES[caseIndex]
      for (let repetition = 0; repetition < REPETITIONS; repetition++) {
        const page = await context.newPage()
        try {
          await page.goto(baseUrl, { waitUntil: 'load' })
          const fixtureFacts = await page.evaluate(() => ({
            decoys: document.querySelectorAll('#decoys article').length,
            totalElements: document.querySelectorAll('*').length,
            operationElements: document.querySelectorAll('#operation-scope *').length,
          }))
          assert.equal(fixtureFacts.decoys, DECOYS)

          const installedApi = await page.evaluate(installRuntimeSource(), { bundleText })
          assert.ok(installedApi.exports.includes('createBaseline'))
          assert.ok(installedApi.exports.includes('createReceipt'))
          const readerOrder = (caseIndex + repetition) % 2 === 0 ? ['H', 'HR'] : ['HR', 'H']
          const baseline = {}
          for (const arm of readerOrder) {
            baseline[arm] = await page.evaluate(async (which) => window.__directedValueExperiment.start(which), arm)
          }

          const actionStarted = performance.now()
          await page.evaluate((variant) => window.__applyDirectedFixtureEffect(variant), scenario.id)
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const actionAndSettleMs = performance.now() - actionStarted

          const arms = {}
          for (const arm of readerOrder.slice().reverse()) {
            try {
              const observed = await page.evaluate(async (which) => window.__directedValueExperiment.finish(which), arm)
              assert.equal(observed.evidenceBytes, jsonBytes(observed.evidence))
              arms[arm] = { ...observed, baseline: baseline[arm] }
            } catch (error) {
              const evidence = { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 4000) }
              arms[arm] = {
                verdict: 'OP_ERROR',
                evidence,
                evidenceBytes: jsonBytes(evidence),
                elapsedMs: 0,
                hostCalls: arm === 'H' ? 1 : 0,
                receiptApiCalls: 0,
                baseline: baseline[arm],
              }
            }
          }
          const oracle = await page.evaluate(oracleSource())
          assert.equal(oracle.verdict, scenario.truth, `oracle calibration ${scenario.id}`)
          await page.evaluate(() => window.__directedValueExperiment.dispose())

          trials.push({
            trialId: `${scenario.id}-r${repetition + 1}`,
            caseId: scenario.id,
            repetition: repetition + 1,
            preregisteredTruth: scenario.truth,
            readerOrder,
            fixture: fixtureFacts,
            actionAndSettleMs: round(actionAndSettleMs),
            oracle,
            arms,
            sdkExports: installedApi.exports,
          })
          process.stdout.write(`[directed-value] ${scenario.id} r${repetition + 1}: H=${arms.H.verdict} H+R=${arms.HR.verdict} oracle=${oracle.verdict}\n`)
        } finally {
          await page.close().catch(() => {})
        }
      }
    }

    assert.equal(trials.length, CASES.length * REPETITIONS)
    assert.deepEqual(unexpectedRequests, [])
    const armH = summarizeArm(trials, 'H')
    const armHR = summarizeArm(trials, 'HR')
    const integrityProblems = []
    if (trials.some((trial) => trial.oracle.verdict !== trial.preregisteredTruth)) {
      integrityProblems.push('oracle/preregistration mismatch')
    }
    if (trials.some((trial) => trial.arms.H.verdict === 'OP_ERROR' || trial.arms.HR.verdict === 'OP_ERROR')) {
      integrityProblems.push('operational error in scheduled arm')
    }
    if (unexpectedRequests.length) integrityProblems.push('unexpected non-fixture browser request')

    let direction
    if (integrityProblems.length) direction = 'INVALID'
    else if (armHR.falseGreen < armH.falseGreen && armHR.falseNegative <= armH.falseNegative) {
      direction = 'INCREMENTAL_PRIMARY_VALUE_DEMONSTRATED'
    } else if (armHR.correct === armH.correct && armHR.falseGreen === armH.falseGreen && armHR.falseNegative === armH.falseNegative) {
      direction = 'NO_INCREMENTAL_CORRECTNESS_ON_FIXED_STRONG_CONTRACT'
    } else direction = 'MIXED_OR_ADVERSE'

    const resultPayload = {
      schemaVersion: 1,
      experimentId: 'directed-host-receipt-value-v1',
      completedAt: new Date().toISOString(),
      question: 'What incremental value does the installed receipt SDK add to the same strong directed host verifier on a large page with a local effect?',
      method: {
        preregistration: 'experiment/results/directed-host-receipt-value.preregistration.json',
        pairedTrials: trials.length,
        repetitionsPerCase: REPETITIONS,
        decoyCards: DECOYS,
        receiptScope: '#operation-scope',
        actionControl: 'shared fixture mutation; browser control is not compared',
        oracle: 'separate primitive DOM, hit-test, and canvas-pixel reader',
        isolation: 'temporary Chromium persistent context and profile; loopback-only fixture; no personal Chrome state',
        readerOrder: 'balanced; post order reverses baseline order',
      },
      metricDefinitions: {
        correct: 'arm verdict equals independent oracle PASS/FAIL truth',
        falseGreen: 'oracle FAIL and arm PASS',
        falseNegative: 'oracle PASS and arm FAIL',
        unknown: 'arm verdict UNKNOWN; remains in the primary denominator and is not counted correct',
        evidenceBytes: 'UTF-8 bytes of exact post-action JSON evidence returned to the consumer; local baseline state is reported separately',
        wallTime: 'browser-side reader wall time, descriptive only',
      },
      primary: { H: armH, HR: armHR },
      byCase: Object.fromEntries(CASES.map((scenario) => [scenario.id, {
        truth: scenario.truth,
        H: summarizeArm(trials.filter((trial) => trial.caseId === scenario.id), 'H'),
        HR: summarizeArm(trials.filter((trial) => trial.caseId === scenario.id), 'HR'),
      }])),
      authoringAndIntegration: {
        H: {
          directedPredicates: 4,
          hostCallsPerCycle: 2,
          receiptApiCallsPerCycle: 0,
          runtimeDependencies: [],
          browserAccess: 'same-page DOM access to the declared operation scope; no special browser permission in this embedded fixture',
        },
        HR: {
          directedPredicates: 4,
          hostCallsPerCycle: 2,
          receiptApiCallsPerCycle: trials[0].arms.HR.baseline.receiptApiCalls + trials[0].arms.HR.receiptApiCalls,
          receiptAdapter: trials[0].arms.HR.receiptAdapter,
          package: installedPackage.name,
          version: installedPackage.version,
          bundleBytes: bundleBytes.byteLength,
          runtimeDependencies: [],
          browserAccess: 'same-page DOM access to the declared operation scope; no CDP/debugger, Node, daemon, browser download, or additional permission in this embedded fixture',
          staticEgressEvidenceScope: distManifest.staticEvidence?.scope,
          staticEgressMatches: distManifest.staticEvidence?.matches,
        },
        testHarnessExcludedFromProductIntegration: 'Playwright launches only the isolated experiment browser',
      },
      outcome: {
        integrity: integrityProblems.length ? 'INVALID' : 'VALID',
        integrityProblems,
        direction,
        estimable: [
          'incremental verdict correctness for this deterministic, fixed, well-authored contract',
          'consumer evidence bytes',
          'browser-side reader wall time',
          'packaged browser runtime/dependency surface',
        ],
        notEstimable: [
          'commercial demand or willingness to pay',
          'multisite generalization',
          'authoring savings across changing schemas',
          'token cost',
          'browser-control capability',
          'backend truth',
        ],
      },
      integrity: {
        runnerSha256: sha256(runnerBytes),
        preregistrationSha256: sha256(preregBytes),
        tarballSha256: sha256(readFileSync(tarballPath)),
        installedBundleSha256: sha256(bundleBytes),
        installedManifestSha256: sha256(readFileSync(join(installedDir, 'dist-manifest.json'))),
        portWasOsAssigned: true,
        portWas8377: false,
        loopbackPort: port,
        unexpectedBrowserRequests: unexpectedRequests,
        servedRequestCount: servedRequests.length,
        tempProfileDeletedOnExit: true,
      },
      trials,
    }
    const payloadWire = `${JSON.stringify(resultPayload, null, 2)}\n`
    const envelope = {
      payloadSha256: sha256(payloadWire),
      payloadHashDefinition: 'SHA-256 of UTF-8 JSON.stringify(resultPayload, null, 2) plus one trailing newline',
      resultPayload,
    }
    writeFileSync(RESULT, `${JSON.stringify(envelope, null, 2)}\n`)
    process.stdout.write(`[directed-value] wrote ${RESULT}\n`)
    process.stdout.write(`[directed-value] direction=${direction} H=${armH.correct}/${armH.scheduled} H+R=${armHR.correct}/${armHR.scheduled}\n`)
    /* eslint-enable no-undef */
  } finally {
    if (context) await context.close().catch(() => {})
    if (server) await closeServer(server).catch(() => {})
    rmSync(temp, { recursive: true, force: true })
  }
}

await main()
