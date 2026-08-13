/**
 * Resident sensor architecture probe.
 *
 * This does not compare browser controllers. Playwright is only the isolated harness.
 * It asks whether a fixed semantic scope stays cheap when unrelated exterior DOM grows,
 * while the baseline remains private and only the descriptive report is serialized.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER_PATH = fileURLToPath(import.meta.url)
const ROOT = join(HERE, '..')
const BUNDLE_PATH = join(ROOT, 'browser-sdk', 'dist', 'snapdom-receipt.js')
const MANIFEST_PATH = join(ROOT, 'browser-sdk', 'dist-manifest.json')
const RESULT_PATH = join(HERE, 'results', 'resident-sensor-value-v2.json')
const RESULT_MD_PATH = join(HERE, 'results', 'resident-sensor-value-v2.md')
const SCALES = [10_000, 100, 1_000]
const WARMUPS = 5
const REPS = 30

const round = (value, digits = 3) => Number(value.toFixed(digits))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function stats(values) {
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
  }
}

function fixtureHtml(exteriorElements) {
  const decoys = Array.from({ length: exteriorElements }, (_, index) =>
    `<label for="outside-control-${index}">Exterior ${index}</label>`
  ).join('')
  const scopeRows = Array.from({ length: 24 }, (_, index) =>
    `<li><span>Stable row ${index}</span></li>`
  ).join('')
  return `<!doctype html>
    <style>
      body { margin: 0; font: 14px system-ui; }
      #sensor-root { padding: 12px; }
      #scope { width: 420px; min-height: 120px; }
      #outside { display: block; }
    </style>
    <main id="sensor-root">
      <section id="scope">
        <h1>Workspace</h1>
        <button data-testid="mode" aria-pressed="false">Mode</button>
        <p data-testid="status" role="status">Ready 0</p>
        <button data-testid="continue">Continue</button>
        <ul>${scopeRows}</ul>
      </section>
      <div id="outside">${decoys}</div>
    </main>`
}

async function installSdk(page, bundleText) {
  await page.evaluate(async (source) => {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([source], { type: 'text/javascript' }))
    try {
      globalThis.__residentSensorSdk = await import(url)
    } finally {
      globalThis.URL.revokeObjectURL(url)
    }
  }, bundleText)
}

async function taskDurationMs(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const task = metrics.find((metric) => metric.name === 'TaskDuration')
  if (!task || !Number.isFinite(task.value)) throw new Error('CDP TaskDuration metric unavailable')
  return task.value * 1_000
}

async function runScale(page, cdp, exteriorElements) {
  await page.setContent(fixtureHtml(exteriorElements))
  const bundleText = await readFile(BUNDLE_PATH, 'utf8')
  await installSdk(page, bundleText)

  const exteriorElementCount = await page.evaluate(() => {
    const sdk = globalThis.__residentSensorSdk
    const root = globalThis.document.querySelector('#sensor-root')
    globalThis.__residentSensor = sdk.createSensor(root, {
      budgetMs: 8,
      limits: { changes: 12, actionability: 6, blindSpots: 6, stringLength: 120 },
    })
    globalThis.__residentSensorState = false
    globalThis.__residentSensorHandle = null
    globalThis.__residentSensorReport = null
    return globalThis.document.querySelector('#outside').querySelectorAll('*').length
  })
  assert.equal(exteriorElementCount, exteriorElements)

  const mark = () => page.evaluate(async () => {
      const scope = globalThis.document.querySelector('#scope')
      const markStart = globalThis.performance.now()
      const handle = await globalThis.__residentSensor.mark({ scope })
      const markMs = globalThis.performance.now() - markStart
      globalThis.__residentSensorHandle = handle
      return { markMs }
    })
  const act = () => page.evaluate(() => {
      const actStart = globalThis.performance.now()
      const scope = globalThis.document.querySelector('#scope')
      const before = globalThis.__residentSensorState
      const after = !before
      globalThis.__residentSensorState = after
      scope.querySelector('[data-testid="mode"]').setAttribute('aria-pressed', String(after))
      scope.querySelector('[data-testid="status"]').textContent = `Ready ${after ? 1 : 0}`
      return { before, after, actMs: globalThis.performance.now() - actStart }
    })
  const read = () => page.evaluate(async () => {
      const readStart = globalThis.performance.now()
      const report = await globalThis.__residentSensor.read(globalThis.__residentSensorHandle)
      const readMs = globalThis.performance.now() - readStart
      globalThis.__residentSensorReport = report
      return { readMs }
    })
  const serialize = (direction) => page.evaluate(({ before, after }) => {
      const report = globalThis.__residentSensorReport
      const serializationStart = globalThis.performance.now()
      const wire = JSON.stringify(report)
      const serializationMs = globalThis.performance.now() - serializationStart
      const bytes = new globalThis.TextEncoder().encode(wire).byteLength
      const items = report.observation.semanticDelta.items
      const stateFact = items.some((item) =>
        item.kind === 'state' &&
        item.beforeNode?.testid === 'mode' &&
        item.afterNode?.testid === 'mode' &&
        item.beforeNode?.state?.pressed === before &&
        item.afterNode?.state?.pressed === after
      )
      const statusFact = items.some((item) =>
        item.kind === 'content' &&
        item.beforeNode?.testid === 'status' &&
        item.afterNode?.testid === 'status' &&
        item.beforeNode?.name === `Ready ${before ? 1 : 0}` &&
        item.afterNode?.name === `Ready ${after ? 1 : 0}`
      )
      const forbiddenWireKey = /"(?:baseline|checkpoint|expected|postcondition)"/.test(wire)
      const forbiddenVerdictKey = /"(?:outcome|taskOutcome)"/.test(wire)
      const handleBytes = JSON.stringify(globalThis.__residentSensorHandle).length
      globalThis.__residentSensorHandle = null
      globalThis.__residentSensorReport = null
      return {
        serializationMs,
        bytes,
        handleBytes,
        nodesBefore: report.localState.nodesBefore,
        nodesAfter: report.localState.nodesAfter,
        scopeStatus: report.observation.scopeStatus,
        stateFact,
        statusFact,
        forbiddenWireKey,
        forbiddenVerdictKey,
        semanticTotal: report.observation.semanticDelta.total,
        semanticItems: report.observation.semanticDelta.items.length,
        semanticTruncated: report.observation.semanticDelta.truncated,
        actionabilityLost: report.observation.renderedActionabilityDelta.lost.total,
        actionabilityGained: report.observation.renderedActionabilityDelta.gained.total,
        blindSpots: report.coverage.knownSemanticBlindSpots.total,
        uncertaintyReasons: report.uncertainty.reasons.length,
        outsideStatus: report.coverage.outsideScopeDomActivity.status,
        noRaster: report.visual.raster === 'NOT_CAPTURED' &&
          !/data:image|<svg/i.test(wire),
        noTaskVerdict: report.taskAssessment.status === 'NOT_ASSESSED',
        privatePriorState: report.localState.priorState === 'OPAQUE_IN_MEMORY' &&
          report.localState.checkpointEncoding === 'NOT_USED',
      }
    }, direction)

  for (let i = 0; i < WARMUPS; i++) {
    await mark()
    const direction = await act()
    await read()
    await serialize(direction)
  }

  const rows = []
  for (let i = 0; i < REPS; i++) {
    const markTaskBefore = await taskDurationMs(cdp)
    const marked = await mark()
    const markTaskAfter = await taskDurationMs(cdp)
    const actTaskBefore = await taskDurationMs(cdp)
    const direction = await act()
    const actTaskAfter = await taskDurationMs(cdp)
    const readTaskBefore = await taskDurationMs(cdp)
    const observed = await read()
    const readTaskAfter = await taskDurationMs(cdp)
    const projected = await serialize(direction)
    rows.push({
      ...marked,
      ...observed,
      ...projected,
      markTaskMs: markTaskAfter - markTaskBefore,
      actTaskMs: actTaskAfter - actTaskBefore,
      readTaskMs: readTaskAfter - readTaskBefore,
    })
  }

  const exteriorProbe = await page.evaluate(async () => {
    const scope = globalThis.document.querySelector('#scope')
    const outside = globalThis.document.querySelector('#outside')
    const exteriorHandle = await globalThis.__residentSensor.mark({ scope })
    const secret = globalThis.document.createElement('span')
    secret.textContent = 'exterior-secret-must-not-egress-7bfe'
    outside.appendChild(secret)
    const exteriorReport = await globalThis.__residentSensor.read(exteriorHandle)
    const exteriorWire = JSON.stringify(exteriorReport)
    secret.remove()
    return {
      radarStatus: exteriorReport.coverage.outsideScopeDomActivity.status,
      secretPresent: exteriorWire.includes('exterior-secret-must-not-egress-7bfe'),
      reportBytes: new globalThis.TextEncoder().encode(exteriorWire).byteLength,
    }
  })
  await page.evaluate(() => {
    globalThis.__residentSensor.dispose()
    globalThis.__residentSensor = null
  })

  // Approximate retained-heap delta while the opaque mark is alive. This is a noisy
  // Chromium heap probe, reported separately from exact retained node counts.
  await page.evaluate(() => {
    const sdk = globalThis.__residentSensorSdk
    globalThis.__heapSensor = sdk.createSensor(globalThis.document.querySelector('#sensor-root'))
  })
  const heapSamples = []
  for (let i = 0; i < 5; i++) {
    await cdp.send('HeapProfiler.collectGarbage')
    const releasedBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize
    await page.evaluate(async () => {
      globalThis.__heapHandle = await globalThis.__heapSensor.mark({
        scope: globalThis.document.querySelector('#scope'),
      })
    })
    await cdp.send('HeapProfiler.collectGarbage')
    const active = (await cdp.send('Runtime.getHeapUsage')).usedSize
    await page.evaluate(() => {
      globalThis.__heapSensor.cancel(globalThis.__heapHandle)
      globalThis.__heapHandle = null
    })
    await cdp.send('HeapProfiler.collectGarbage')
    const releasedAfter = (await cdp.send('Runtime.getHeapUsage')).usedSize
    heapSamples.push({
      before: releasedBefore,
      active,
      after: releasedAfter,
      delta: active - ((releasedBefore + releasedAfter) / 2),
    })
  }
  await page.evaluate(() => {
    globalThis.__heapSensor.dispose()
    globalThis.__heapSensor = null
  })

  // Counterfactual only, measured after the heap probe because createBaseline() uses
  // the legacy global compatibility snapshot. It is not included in sensor egress or
  // timing comparisons.
  const portableCounterfactual = await page.evaluate(() => {
    const sdk = globalThis.__residentSensorSdk
    const scope = globalThis.document.querySelector('#scope')
    const button = scope.querySelector('[data-testid="mode"]')
    const status = scope.querySelector('[data-testid="status"]')
    const before = button.getAttribute('aria-pressed') === 'true'
    const baseline = sdk.createBaseline(scope)
    button.setAttribute('aria-pressed', String(!before))
    status.textContent = `Ready ${before ? 0 : 1}`
    const receipt = sdk.createReceipt(scope, {
      baseline,
      expected: { changed: true },
      limits: { changes: 12, actionability: 6, unobservable: 6 },
    })
    const encoder = new globalThis.TextEncoder()
    const baselineBytes = encoder.encode(JSON.stringify(baseline)).byteLength
    const receiptBytes = encoder.encode(JSON.stringify(receipt)).byteLength
    const stateChange = receipt.observed.changes.items.find((item) => item.kind === 'state')
    return {
      baselineContract: baseline.contract,
      receiptContract: receipt.contract,
      taskOutcome: receipt.taskOutcome,
      postconditionOutcome: receipt.postcondition.outcome,
      changed: receipt.observed.changed,
      changeTotal: receipt.observed.changes.total,
      stateDirectionExact: stateChange?.before?.pressed === before &&
        stateChange?.after?.pressed === !before,
      baselineBytes,
      receiptBytes,
      cycleBytes: baselineBytes + receiptBytes,
    }
  })

  for (const row of rows) {
    assert.equal(row.scopeStatus, 'DELTA_DETECTED')
    assert.equal(row.handleBytes, 2)
    assert.equal(row.stateFact, true)
    assert.equal(row.statusFact, true)
    assert.equal(row.forbiddenWireKey, false)
    assert.equal(row.forbiddenVerdictKey, false)
    assert.equal(row.semanticTotal, 2)
    assert.equal(row.semanticItems, 2)
    assert.equal(row.semanticTruncated, 0)
    assert.equal(row.actionabilityLost, 0)
    assert.equal(row.actionabilityGained, 0)
    assert.equal(row.blindSpots, 0)
    assert.equal(row.uncertaintyReasons, 0)
    assert.equal(row.outsideStatus, 'NOT_DETECTED')
    assert.equal(row.noRaster, true)
    assert.equal(row.noTaskVerdict, true)
    assert.equal(row.privatePriorState, true)
    assert.equal(row.nodesBefore, row.nodesAfter)
  }
  assert.equal(new Set(rows.map((row) => row.nodesBefore)).size, 1)
  assert.equal(exteriorProbe.radarStatus, 'DETECTED')
  assert.equal(exteriorProbe.secretPresent, false)
  assert.equal(portableCounterfactual.baselineContract, 'snapdom.action-baseline/v1')
  assert.equal(portableCounterfactual.receiptContract, 'snapdom.action-receipt/v1')
  assert.equal(portableCounterfactual.taskOutcome, 'NOT_ASSESSED')
  assert.equal(portableCounterfactual.postconditionOutcome, 'PASS')
  assert.equal(portableCounterfactual.changed, true)
  assert.equal(portableCounterfactual.stateDirectionExact, true)
  const markWall = stats(rows.map((row) => row.markMs))
  const readWall = stats(rows.map((row) => row.readMs))
  const totalWall = stats(rows.map((row) => row.markMs + row.readMs))
  const markTask = stats(rows.map((row) => row.markTaskMs))
  const actTask = stats(rows.map((row) => row.actTaskMs))
  const readTask = stats(rows.map((row) => row.readTaskMs))
  const totalTask = stats(rows.map((row) => row.markTaskMs + row.readTaskMs))
  const serialization = stats(rows.map((row) => row.serializationMs))
  const bytes = stats(rows.map((row) => row.bytes))
  const heap = stats(heapSamples.map((sample) => sample.delta))
  return {
    exteriorElements,
    scopeNodes: rows[0].nodesBefore,
    repetitions: REPS,
    markWallMs: markWall,
    readWallMs: readWall,
    markPlusReadWallMs: totalWall,
    markRendererTaskMs: markTask,
    actionRendererTaskMs: actTask,
    readRendererTaskMs: readTask,
    markPlusReadRendererTaskMs: totalTask,
    serializationMs: serialization,
    reportBytes: bytes,
    opaqueHandleBytes: 2,
    approximateRetainedHeapBytes: heap,
    heapSamples,
    portableCounterfactual: {
      ...portableCounterfactual,
      cycleToSensorReportP50Ratio: round(portableCounterfactual.cycleBytes / bytes.p50, 2),
    },
    exteriorProbe,
    trials: rows,
  }
}

let browser
let context
try {
  const bundle = await readFile(BUNDLE_PATH)
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const runnerBefore = await readFile(RUNNER_PATH)
  assert.equal(manifest.sha256, sha256(bundle))
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
  const scales = []
  const externalRequests = []
  for (const scale of SCALES) {
    const page = await context.newPage()
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url())
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Performance.enable')
    scales.push(await runScale(page, cdp, scale))
    await page.close()
  }
  scales.sort((a, b) => a.exteriorElements - b.exteriorElements)
  assert.equal(new Set(scales.map((scale) => scale.scopeNodes)).size, 1)
  assert.equal(scales[0].scopeNodes, 54)
  assert.deepEqual(externalRequests, [])

  const smallest = scales[0]
  const largest = scales.at(-1)
  const smallestBytes = percentile(smallest.trials.map((row) => row.bytes), 0.5)
  const largestBytes = percentile(largest.trials.map((row) => row.bytes), 0.5)
  const smallestTask = percentile(smallest.trials.map((row) => row.markTaskMs + row.readTaskMs), 0.5)
  const largestTask = percentile(largest.trials.map((row) => row.markTaskMs + row.readTaskMs), 0.5)
  const byteGrowthPct = smallestBytes > 0 ? ((largestBytes - smallestBytes) / smallestBytes) * 100 : null
  const p50RendererTaskGrowthPct = smallestTask > 0
    ? ((largestTask - smallestTask) / smallestTask) * 100
    : null
  const runnerAfter = await readFile(RUNNER_PATH)
  assert.equal(sha256(runnerAfter), sha256(runnerBefore), 'runner changed during execution')
  const result = {
    schemaVersion: 2,
    experiment: 'resident-sensor-value-v2',
    generatedAt: new Date().toISOString(),
    status: 'DESCRIPTIVE_SINGLE_RUN',
    analysisStatus: { kind: 'descriptive', preregisteredThreshold: null },
    priorIteration: {
      result: 'experiment/results/resident-sensor-value.json',
      status: 'DEVELOPMENT_DIAGNOSTIC',
      finding: 'The first run found that open-shadow discovery scanned the entire sensor root, so local work scaled with exterior DOM. V2 restricts shadow discovery to the paid scope and preserves the first artifact.',
    },
    question: 'How do report egress and local semantic work vary while a fixed scope is surrounded by an adversarial label-heavy exterior?',
    productBoundary: {
      controllerComparison: 'NONE',
      playwrightRole: 'isolated Chromium harness and heap instrumentation only',
      personalChromeAccessed: false,
      externalHttpRequestsObserved: 0,
      portUsed: false,
      baseline: 'opaque in-memory snapshot; never serialized by createSensor',
      report: 'descriptive; no expected result, task verdict, SVG, or pixels',
    },
    implementation: {
      bundle: manifest.artifact,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      gzipBytes: manifest.gzipBytes,
      dependencies: manifest.dependencies,
      runnerSha256: sha256(runnerBefore),
      browserVersion: browser.version(),
      viewport: context.pages()[0]?.viewportSize() || { width: 1280, height: 720 },
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    protocol: {
      exteriorDecoyLabelScaleOrder: SCALES,
      exteriorComposition: '100% label[for] elements with missing targets; adversarial to historical document-global label lookup',
      scopeComposition: '54 fixed elements: section, heading, two buttons, status, list, 24 listitems and 24 spans',
      warmups: WARMUPS,
      measuredRepetitions: REPS,
      fixedScope: true,
      sameUnannouncedEffect: 'toggle aria-pressed and status text after mark()',
      candidateWireMetric: 'UTF-8 bytes of JSON.stringify(report); no network transmission performed',
      rendererCpuProxy: 'CDP Performance TaskDuration deltas around mark, action and read; mark/read exclude action and report serialization',
      actionMetricBoundary: 'action TaskDuration includes DOM mutation and scheduled mutation-radar delivery observable before the CDP response',
      heapMetric: 'noisy Runtime.getHeapUsage delta after forced GC; not a precise allocation measurement',
    },
    scales,
    summary: {
      reportMedianByteGrowth100To10000Pct: byteGrowthPct === null ? null : round(byteGrowthPct, 2),
      p50RendererTaskGrowth100To10000Pct: p50RendererTaskGrowthPct === null
        ? null
        : round(p50RendererTaskGrowthPct, 2),
      maxReportP50Bytes: Math.max(...scales.map((row) => row.reportBytes.p50)),
      maxMarkPlusReadWallP95Ms: Math.max(...scales.map((row) => row.markPlusReadWallMs.p95)),
      maxMarkPlusReadRendererTaskP50Ms: Math.max(...scales.map((row) => row.markPlusReadRendererTaskMs.p50)),
      baselineCrossedBoundary: false,
      checkpointEncodingUsed: false,
      rasterUsed: false,
      taskOutcomeAssessed: false,
      exteriorSecretLeaked: scales.some((row) => row.exteriorProbe.secretPresent),
    },
    interpretation: [
      'This tests the resident/scoped architecture, not browser automation or task correctness.',
      'The opaque handle is two JSON bytes and contains no prior-state graph. The report is the candidate wire payload; this run performs no transmission.',
      'Retained heap numbers are diagnostic and noisy; exact retained semantic node counts are the stronger local-state invariant.',
      'The mutation radar covers the sensor-root DOM tree plus open shadow roots inside the paid scope registered without gaps. NOT_DETECTED remains bounded to that stated coverage.',
      'The exterior is deliberately label-heavy and adversarial, not a representative sample of all DOM compositions.',
    ],
  }
  const lines = [
    '# Resident sensor value probe v2',
    '',
    `Status: **${result.status}**`,
    '',
    '| Exterior decoy labels | Scope elements | report p50 | mark p50 | read p50 | mark+read p95 | retained heap p50 |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...scales.map((row) => `| ${row.exteriorElements.toLocaleString('en-US')} | ${row.scopeNodes} | ${row.reportBytes.p50.toLocaleString('en-US')} B | ${row.markWallMs.p50} ms | ${row.readWallMs.p50} ms | ${row.markPlusReadWallMs.p95} ms | ${row.approximateRetainedHeapBytes.p50.toLocaleString('en-US')} B |`),
    '',
    `Median report-byte growth from 100 to 10,000 exterior labels: **${result.summary.reportMedianByteGrowth100To10000Pct}%**.`,
    `p50 renderer TaskDuration growth: **${result.summary.p50RendererTaskGrowth100To10000Pct}%** (single-run CPU proxy; no speed claim).`,
    '',
    'The prior state stayed as an opaque in-memory graph and never crossed the boundary. The report is descriptive: no expected result, PASS/FAIL, task verdict, SVG, or pixel capture.',
    '',
    ...scales.map((row) => `At ${row.exteriorElements.toLocaleString('en-US')} labels, the portable counterfactual was ${row.portableCounterfactual.cycleBytes.toLocaleString('en-US')} B (baseline + receipt), ${row.portableCounterfactual.cycleToSensorReportP50Ratio}× the resident report p50; it is a wire-ready artifact comparison, not observed network egress.`),
    '',
    'The heap delta is a noisy Chromium diagnostic after forced GC, not an exact allocation measurement. No performance threshold was preregistered; timings are descriptive.',
  ]
  await Promise.all([
    writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' }),
    writeFile(RESULT_MD_PATH, `${lines.join('\n')}\n`, { flag: 'wx' }),
  ])
  process.stdout.write(`${JSON.stringify(result.summary)}\n`)
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
}
