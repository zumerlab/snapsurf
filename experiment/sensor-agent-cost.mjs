#!/usr/bin/env node
/**
 * SnapDOM AgentMap + Sensor cost/composition probe.
 *
 * Playwright is only the isolated Chromium harness. The fixture has no external
 * resources, no result is uploaded, and no persistent or personal browser profile
 * is opened. This script deliberately separates local browser work from the exact
 * payload bytes a host might choose to send to an agent.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const RUNNER = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(RUNNER), '..')
const ATTACHED_ROOT = '/Users/martin/GitHub/zumerlab/snapdom'
const PREREG = join(ROOT, 'experiment', 'results', 'sensor-agent-cost-v1.preregistration.json')
const OUTPUT = join(ROOT, 'experiment', 'results', 'sensor-agent-cost-v1.json')
const OUTPUT_MD = join(ROOT, 'experiment', 'results', 'sensor-agent-cost-v1.md')
const SOURCES = Object.freeze({
  snapdom3: join(ROOT, 'vendor', 'snapdom', 'dist', 'snapdom.mjs'),
  sensor: join(ROOT, 'packages', 'sensor', 'dist', 'snapdom-sensor.js'),
  snapdom224: join(ATTACHED_ROOT, 'dist', 'snapdom.mjs'),
  agentMap: join(ATTACHED_ROOT, 'packages', 'plugins', 'agent-map.js'),
})
const ROWS = 120
const WARMUPS = 1
const REPS = 7
const VISUAL_REPS = 3
const ARMS = ['raw', 'agent-map', 'sensor', 'combined']
const SCOPES = ['target', 'page']
const VISUAL_PROFILES = Object.freeze([
  { name: 'low', scale: 0.5, dpr: 1 },
  { name: 'standard', scale: 1, dpr: 1 },
  { name: 'equal-effective', scale: 0.5, dpr: 2 },
  { name: 'retina', scale: 1, dpr: 2 },
])
const AGENT_MAP_IMAGE_WIDTHS = [320, 640, 1024]

if (process.argv.includes('--dry')) {
  process.stdout.write(`${JSON.stringify({
    mode: 'dry', ROWS, WARMUPS, REPS, VISUAL_REPS, ARMS, SCOPES,
    VISUAL_PROFILES, AGENT_MAP_IMAGE_WIDTHS, sources: SOURCES,
  }, null, 2)}\n`)
  process.exit(0)
}

await assertAbsent(OUTPUT)
await assertAbsent(OUTPUT_MD)

const sourceEntries = Object.fromEntries(await Promise.all(
  Object.entries(SOURCES).map(async ([name, path]) => {
    const bytes = await readFile(path)
    return [name, {
      path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      source: bytes.toString('utf8'),
    }]
  }),
))
const preregBytes = await readFile(PREREG)
const runnerBytes = await readFile(RUNNER)
const attachedPackage = JSON.parse(await readFile(join(ATTACHED_ROOT, 'package.json'), 'utf8'))
const attachedPluginPackage = JSON.parse(
  await readFile(join(ATTACHED_ROOT, 'packages', 'plugins', 'package.json'), 'utf8'),
)
const sensorManifest = JSON.parse(
  await readFile(join(ROOT, 'packages', 'sensor', 'dist-manifest.json'), 'utf8'),
)

let browser
let context
let page
let run
const httpRequests = []
try {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  })
  page = await context.newPage()
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) httpRequests.push(request.url())
  })
  await installModules(page, sourceEntries)

  const primaryTrials = await runPrimary(page)
  const quality = await runQualityProbes(page)
  const visualTrials = await runVisualProfiles(page)
  const agentMapImageTrials = await runAgentMapImages(page)

  run = {
    browserVersion: browser.version(),
    primaryTrials,
    quality,
    visualTrials,
    agentMapImageTrials,
  }
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
}

assert(run, 'browser run did not complete')
assert.equal(httpRequests.length, 0, `unexpected HTTP(S) requests: ${httpRequests.join(', ')}`)

const primarySummary = summarizePrimary(run.primaryTrials)
const visualSummary = summarizeVisual(run.visualTrials)
const agentMapImageSummary = summarizeAgentMapImages(run.agentMapImageTrials)
const decisions = decide({ primarySummary, visualSummary, quality: run.quality })
const integrity = validateRun({ run, primarySummary, httpRequests, decisions })
const completedAt = new Date().toISOString()

const result = {
  schema: 1,
  classification: 'single-machine synthetic descriptive local-cost and candidate-boundary-byte probe; not a token, model-quality, production-site, or commercial-demand claim',
  completedAt,
  runHistory: [
    {
      attempt: 1,
      status: 'RUN_DISCARDED_HARNESS_EXPECTATION',
      outputsWritten: false,
      reason: 'The no-op probe contained a synthetic password. Sensor correctly returned zero semantic/actionability delta while retaining INDETERMINATE because a sensitive-input blind spot remained; the harness had incorrectly required NO_SUPPORTED_DELTA_DETECTED.',
    },
    {
      attempt: 2,
      status: 'REPORTED',
      correction: 'The frozen gate is applied literally: zero semantic and actionability delta. INDETERMINATE remains visible and is not converted to PASS.',
    },
  ],
  question: 'When SnapDOM already runs in the client, what local work and candidate agent-boundary bytes are observed for raw SnapDOM, agent-map, Sensor, and their composition?',
  provenance: {
    runner: { path: 'experiment/sensor-agent-cost.mjs', bytes: runnerBytes.byteLength, sha256: sha256(runnerBytes) },
    preregistration: {
      path: 'experiment/results/sensor-agent-cost-v1.preregistration.json',
      bytes: preregBytes.byteLength,
      sha256: sha256(preregBytes),
    },
    snapdom3: omitSource(sourceEntries.snapdom3),
    sensor: { ...omitSource(sourceEntries.sensor), manifest: sensorManifest },
    snapdom224: {
      ...omitSource(sourceEntries.snapdom224),
      packageVersion: attachedPackage.version,
    },
    agentMap: {
      ...omitSource(sourceEntries.agentMap),
      package: attachedPluginPackage.name,
      packageVersion: attachedPluginPackage.version,
    },
  },
  environment: {
    browser: 'Playwright Chromium used only as an isolated harness',
    browserVersion: run.browserVersion,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    persistentProfile: false,
    personalChromeAccessed: false,
    externalFixtureResources: 0,
    observedHttpRequests: httpRequests,
    actualCloudOrModelCalls: 0,
  },
  fixture: {
    unrelatedRows: ROWS,
    actionablesPerUnrelatedRow: 3,
    targetAction: 'aria-pressed false to true; status Idle to Saved; add link View receipt',
    scopes: SCOPES,
    authoredActionExcludedFromTiming: true,
  },
  measurement: {
    localCycleMs: 'pre capture/export plus post capture/export; action excluded',
    candidateBoundaryBytes: 'UTF-8 bytes of the exact data URL or JSON.stringify body; these bytes were measured locally and not transmitted',
    svgDecodedBytes: 'UTF-8 bytes after decoding the data URL payload',
    visualBytes: 'UTF-8 bytes of the PNG/WebP data URL',
    repetitions: REPS,
    warmupsPerCell: WARMUPS,
    visualRepetitions: VISUAL_REPS,
  },
  quality: run.quality,
  primary: {
    arms: ARMS,
    scopes: SCOPES,
    summary: primarySummary,
    trials: run.primaryTrials,
  },
  visualScaleDpr: {
    profiles: VISUAL_PROFILES,
    summary: visualSummary,
    trials: run.visualTrials,
  },
  agentMapImageWidth: {
    widths: AGENT_MAP_IMAGE_WIDTHS,
    summary: agentMapImageSummary,
    trials: run.agentMapImageTrials,
  },
  decisions,
  integrity,
  interpretation: [
    'There is no cloud saving to measure because this run made no cloud/model call. The relevant boundary metric is the exact body a host might choose to send later.',
    'AgentMap and Sensor are complementary: AgentMap is a current actionable map; Sensor is private temporal state plus a bounded delta.',
    'image:false prevents AgentMap\'s second raster pass but does not prevent SnapDOM from producing its normal SVG.',
    'scale and dpr are raster controls. Scope/clip/exclude are the structural controls for SnapDOM capture work and SVG size.',
    'The attached AgentMap source is from the public SnapDOM 2.24.1 tree, but the composition benchmark uses the vendored SnapDOM 3 beta because that is the Sensor package\'s declared peer range.',
    'Local wall times are descriptive for one machine and one authored fixture; no speed or population claim follows.',
  ],
}

await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
await writeFile(OUTPUT_MD, renderMarkdown(result), { flag: 'wx', mode: 0o600 })

process.stdout.write(`${JSON.stringify({
  output: OUTPUT,
  markdown: OUTPUT_MD,
  decisions,
  quality: run.quality,
  primarySummary,
  visualSummary,
  agentMapImageSummary,
  integrity,
}, null, 2)}\n`)

async function installModules(targetPage, entries) {
  await targetPage.evaluate(async (sources) => {
    const load = async (source) => {
      const url = globalThis.URL.createObjectURL(
        new globalThis.Blob([source], { type: 'text/javascript' }),
      )
      try {
        return await import(url)
      } finally {
        globalThis.URL.revokeObjectURL(url)
      }
    }
    globalThis.__sensorCostModules = {
      snapdom3: await load(sources.snapdom3),
      sensor: await load(sources.sensor),
      snapdom224: await load(sources.snapdom224),
      agentMap: await load(sources.agentMap),
    }
  }, Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, value.source])))
}

async function runPrimary(targetPage) {
  const trials = []
  for (const scope of SCOPES) {
    for (let repetition = -WARMUPS; repetition < REPS; repetition++) {
      const offset = (repetition + WARMUPS + (scope === 'page' ? 2 : 0)) % ARMS.length
      const order = [...ARMS.slice(offset), ...ARMS.slice(0, offset)]
      for (const arm of order) {
        const trial = await targetPage.evaluate(async ({ arm, scope, rows }) => {
          const { snapdom3, sensor: sensorModule, agentMap: mapModule } = globalThis.__sensorCostModules
          renderFixture(rows)
          const root = globalThis.document.querySelector(
            scope === 'target' ? '#target-card' : '#fixture-root',
          )
          const plugins = []
          let mapPlugin
          let sensorPlugin
          if (arm === 'agent-map' || arm === 'combined') {
            mapPlugin = mapModule.agentMap({ image: false, semantic: false, fields: 'minimal' })
            plugins.push(mapPlugin)
          }
          if (arm === 'sensor' || arm === 'combined') {
            sensorPlugin = sensorModule.sensor({
              limits: { changes: 24, actionability: 12, blindSpots: 12, stringLength: 160 },
            })
            plugins.push(sensorPlugin)
          }
          const options = {
            plugins,
            cache: 'disabled',
            burst: false,
            embedFonts: false,
            scale: 1,
            dpr: 1,
            compress: true,
          }
          const capture = async () => {
            const captureStart = globalThis.performance.now()
            const result = await snapdom3.snapdom(root, options)
            const captureMs = globalThis.performance.now() - captureStart
            const exportStart = globalThis.performance.now()
            const map = mapPlugin ? await result.toAgentMap() : null
            const report = sensorPlugin ? await result.toSensor() : null
            const exportMs = globalThis.performance.now() - exportStart
            const url = result.url
            const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
            return {
              captureMs,
              exportMs,
              svgUrlBytes: byteLength(url),
              svgDecodedBytes: byteLength(svg),
              map,
              mapBytes: map ? byteLength(JSON.stringify(map)) : 0,
              report,
              reportBytes: report ? byteLength(JSON.stringify(report)) : 0,
            }
          }

          const before = await capture()
          applyTargetAction()
          const after = await capture()
          const reportItems = after.report?.observation?.semanticDelta?.items || []
          const exactState = reportItems.some((item) =>
            item.kind === 'state' &&
            item.beforeNode?.testid === 'target-toggle' &&
            item.afterNode?.testid === 'target-toggle' &&
            item.beforeNode?.state?.pressed === false &&
            item.afterNode?.state?.pressed === true)
          const exactStatus = reportItems.some((item) =>
            item.kind === 'content' &&
            item.beforeNode?.testid === 'target-status' &&
            item.afterNode?.testid === 'target-status' &&
            item.beforeNode?.name === 'Idle' &&
            item.afterNode?.name === 'Saved')
          const exactAdded = reportItems.some((item) =>
            item.kind === 'added' &&
            item.afterNode?.testid === 'target-receipt' &&
            item.afterNode?.role === 'link' &&
            item.afterNode?.name === 'View receipt')
          const mapToggle = after.map?.map?.find((entry) =>
            entry.n === 'Toggle mode' && entry.r === 'button')
          const mapReceipt = after.map?.map?.find((entry) =>
            entry.n === 'View receipt' && entry.r === 'link')
          sensorPlugin?.dispose()
          return {
            arm,
            scope,
            localCycleMs: before.captureMs + before.exportMs + after.captureMs + after.exportMs,
            captureCycleMs: before.captureMs + after.captureMs,
            exportCycleMs: before.exportMs + after.exportMs,
            before: slimEndpoint(before),
            after: slimEndpoint(after),
            transitionStateBytes: {
              svgPair: before.svgUrlBytes + after.svgUrlBytes,
              mapPair: before.mapBytes + after.mapBytes,
              sensorDelta: after.reportBytes,
            },
            quality: {
              sensorExact: after.report ? exactState && exactStatus && exactAdded : null,
              sensorFacts: after.report ? { exactState, exactStatus, exactAdded } : null,
              mapExact: after.map ? !!(mapToggle?.s?.pressed === true && mapReceipt) : null,
              mapEntries: after.map?.map?.length || 0,
              combinedExports: arm === 'combined'
                ? typeof after.map === 'object' && typeof after.report === 'object'
                : null,
            },
          }

          function slimEndpoint(endpoint) {
            return {
              captureMs: endpoint.captureMs,
              exportMs: endpoint.exportMs,
              svgUrlBytes: endpoint.svgUrlBytes,
              svgDecodedBytes: endpoint.svgDecodedBytes,
              mapBytes: endpoint.mapBytes,
              mapEntries: endpoint.map?.map?.length || 0,
              reportBytes: endpoint.reportBytes,
              reportStatus: endpoint.report?.observation?.status || null,
              semanticChanges: endpoint.report?.observation?.semanticDelta?.total || 0,
            }
          }

          function byteLength(value) {
            return new globalThis.TextEncoder().encode(value).byteLength
          }

          function renderFixture(rowCount) {
            const rowsMarkup = Array.from({ length: rowCount }, (_, index) => `
              <article class="row">
                <a href="#item-${index}">Item ${index}</a>
                <button type="button">Open ${index}</button>
                <label><input type="checkbox"> Select ${index}</label>
                <p>Stable description ${index}</p>
              </article>`).join('')
            globalThis.document.body.innerHTML = `
              <style>
                * { box-sizing: border-box; }
                body { margin: 0; color: #172033; background: white; font: 14px system-ui; }
                #fixture-root { width: 900px; padding: 20px; }
                #target-card { position: relative; width: 520px; height: 170px; padding: 18px; border: 1px solid #ccd3df; border-radius: 12px; }
                #target-card button, #target-card a { margin-right: 12px; }
                #target-slot { display: block; height: 28px; margin-top: 10px; }
                #unrelated { margin-top: 18px; }
                .row { display: grid; grid-template-columns: 150px 90px 130px 1fr; align-items: center; height: 38px; border-top: 1px solid #edf0f4; }
                .row p { margin: 0; }
              </style>
              <main id="fixture-root">
                <section id="target-card" aria-label="Target card">
                  <h1>Checkout state</h1>
                  <button data-testid="target-toggle" aria-pressed="false">Toggle mode</button>
                  <p data-testid="target-status" role="status">Idle</p>
                  <span id="target-slot"></span>
                </section>
                <section id="unrelated" aria-label="Unrelated controls">${rowsMarkup}</section>
              </main>`
          }

          function applyTargetAction() {
            globalThis.document.querySelector('[data-testid="target-toggle"]')
              .setAttribute('aria-pressed', 'true')
            globalThis.document.querySelector('[data-testid="target-status"]').textContent = 'Saved'
            const link = globalThis.document.createElement('a')
            link.href = '#receipt'
            link.dataset.testid = 'target-receipt'
            link.textContent = 'View receipt'
            globalThis.document.querySelector('#target-slot').appendChild(link)
          }
        }, { arm, scope, rows: ROWS })
        if (repetition >= 0) trials.push({ repetition, order: order.indexOf(arm), ...trial })
      }
    }
  }
  return trials
}

async function runQualityProbes(targetPage) {
  return targetPage.evaluate(async () => {
    const { snapdom3, snapdom224, sensor: sensorModule, agentMap: mapModule } = globalThis.__sensorCostModules
    const options = { cache: 'disabled', burst: false, embedFonts: false, scale: 1, dpr: 1 }

    globalThis.document.body.innerHTML = `
      <main id="probe-root">
        <section id="probe-scope">
          <button data-testid="probe-button" aria-pressed="false">Probe</button>
          <p data-testid="probe-status" role="status">Quiet</p>
          <label>Password <input data-testid="probe-secret" type="password"></label>
        </section>
      </main>`
    const syntheticSecret = 'synthetic-secret-7f31-not-user-data'
    globalThis.document.querySelector('[data-testid="probe-secret"]').value = syntheticSecret
    const root = globalThis.document.querySelector('#probe-scope')
    const sensorPlugin = sensorModule.sensor()
    const mapPlugin = mapModule.agentMap({ image: false, semantic: false, fields: 'minimal' })
    const first = await snapdom3.snapdom(root, { ...options, plugins: [mapPlugin, sensorPlugin] })
    const firstMap = await first.toAgentMap()
    const baseline = await first.toSensor()
    const quiet = await snapdom3.snapdom(root, { ...options, plugins: [mapPlugin, sensorPlugin] })
    const quietMap = await quiet.toAgentMap()
    const quietReport = await quiet.toSensor()
    const mapWire = JSON.stringify(quietMap)
    const reportWire = JSON.stringify(quietReport)
    const svgDecoded = decodeURIComponent(quiet.url.slice(quiet.url.indexOf(',') + 1))
    const composition = {
      baselineStatus: baseline.observation.status,
      quietStatus: quietReport.observation.status,
      quietSemanticTotal: quietReport.observation.semanticDelta.total,
      quietActionabilityLost: quietReport.observation.renderedActionabilityDelta.lost.total,
      quietActionabilityGained: quietReport.observation.renderedActionabilityDelta.gained.total,
      firstResultHasAgentMap: typeof first.toAgentMap === 'function',
      firstResultHasSensor: typeof first.toSensor === 'function',
      firstMapEntries: firstMap.map.length,
    }
    const privacy = {
      syntheticSecret,
      agentMapContainsSyntheticSecret: mapWire.includes(syntheticSecret),
      sensorReportContainsSyntheticSecret: reportWire.includes(syntheticSecret),
      snapdomSvgContainsSyntheticSecret: svgDecoded.includes(syntheticSecret),
    }
    sensorPlugin.dispose()

    globalThis.document.body.innerHTML = '<button id="root-button" type="button">Root action</button>'
    const rootButton = globalThis.document.querySelector('#root-button')
    const nativeMapPlugin = mapModule.agentMap({ image: false })
    const nativeResult = await snapdom224.snapdom(rootButton, {
      ...options,
      plugins: [nativeMapPlugin],
    })
    const nativeRootMap = await nativeResult.toAgentMap()

    return {
      composition,
      privacy,
      attachedAgentMap224: {
        nativeRuntimeWorked: typeof nativeResult.toAgentMap === 'function',
        interactiveRootMapEntries: nativeRootMap.map.length,
        interactiveRootDimensions: nativeRootMap.dimensions,
        finding: nativeRootMap.map.length === 0
          ? 'ROOT_ELEMENT_OMITTED_BY_QUERY_SELECTOR_ALL'
          : 'ROOT_ELEMENT_INCLUDED',
      },
    }
  })
}

async function runVisualProfiles(targetPage) {
  const trials = []
  for (const runtime of ['snapdom224', 'snapdom3']) {
    for (const profile of VISUAL_PROFILES) {
      for (let repetition = 0; repetition < VISUAL_REPS; repetition++) {
        trials.push(await targetPage.evaluate(async ({ runtime, profile, repetition }) => {
          const snapdomModule = globalThis.__sensorCostModules[runtime]
          renderVisual()
          const root = globalThis.document.querySelector('#visual-root')
          const captureStart = globalThis.performance.now()
          const result = await snapdomModule.snapdom(root, {
            cache: 'disabled', burst: false, embedFonts: false,
            compress: true, scale: profile.scale, dpr: profile.dpr,
          })
          const captureMs = globalThis.performance.now() - captureStart
          const exportStart = globalThis.performance.now()
          const png = await result.toPng()
          const exportMs = globalThis.performance.now() - exportStart
          const svg = decodeURIComponent(result.url.slice(result.url.indexOf(',') + 1))
          return {
            runtime,
            profile: profile.name,
            scale: profile.scale,
            dpr: profile.dpr,
            effectiveRasterScale: profile.scale * profile.dpr,
            repetition,
            captureMs,
            exportMs,
            svgUrlBytes: byteLength(result.url),
            svgDecodedBytes: byteLength(svg),
            pngDataUrlBytes: byteLength(png.src),
            pngNaturalWidth: png.naturalWidth,
            pngNaturalHeight: png.naturalHeight,
          }

          function byteLength(value) {
            return new globalThis.TextEncoder().encode(value).byteLength
          }
          function renderVisual() {
            globalThis.document.body.innerHTML = `
              <style>
                body { margin: 0; background: white; font: 16px system-ui; }
                #visual-root { width: 900px; height: 520px; padding: 32px; color: #fff; background: linear-gradient(135deg,#16213e,#0f8b8d); }
                .panel { width: 720px; height: 360px; padding: 28px; border-radius: 24px; background: rgba(255,255,255,.15); box-shadow: 0 24px 60px rgba(0,0,0,.25); }
                button { padding: 12px 20px; border: 0; border-radius: 10px; }
              </style>
              <main id="visual-root">
                <section class="panel">
                  <h1>Local visual fallback</h1>
                  <p>A raster is optional and can be deliberately small.</p>
                  <button>Continue</button>
                </section>
              </main>`
          }
        }, { runtime, profile, repetition }))
      }
    }
  }
  return trials
}

async function runAgentMapImages(targetPage) {
  const trials = []
  for (const maxImageWidth of AGENT_MAP_IMAGE_WIDTHS) {
    for (let repetition = 0; repetition < VISUAL_REPS; repetition++) {
      trials.push(await targetPage.evaluate(async ({ maxImageWidth, repetition }) => {
        const { snapdom224, agentMap: mapModule } = globalThis.__sensorCostModules
        globalThis.document.body.innerHTML = `
          <style>
            body { margin: 0; font: 16px system-ui; }
            #map-visual { width: 900px; height: 520px; padding: 28px; color: white; background: linear-gradient(135deg,#381d64,#c84b8f); }
            button, a { display:inline-block; margin:10px; padding:12px 18px; background:white; color:#222; border-radius:8px; }
          </style>
          <main id="map-visual"><h1>Agent map</h1><button>Confirm</button><a href="#next">Next</a></main>`
        const plugin = mapModule.agentMap({
          image: 'raw', semantic: false, fields: 'minimal',
          maxImageWidth, imageFormat: 'webp', imageQuality: 0.72,
        })
        const captureStart = globalThis.performance.now()
        const result = await snapdom224.snapdom(globalThis.document.querySelector('#map-visual'), {
          plugins: [plugin], cache: 'disabled', burst: false, embedFonts: false,
          scale: 1, dpr: 1,
        })
        const captureMs = globalThis.performance.now() - captureStart
        const exportStart = globalThis.performance.now()
        const map = await result.toAgentMap()
        const exportMs = globalThis.performance.now() - exportStart
        return {
          maxImageWidth,
          repetition,
          captureMs,
          exportMs,
          imageBytes: new globalThis.TextEncoder().encode(map.image).byteLength,
          mapBytes: new globalThis.TextEncoder()
            .encode(JSON.stringify({ dimensions: map.dimensions, map: map.map })).byteLength,
          width: map.dimensions.width,
          height: map.dimensions.height,
          entries: map.map.length,
        }
      }, { maxImageWidth, repetition }))
    }
  }
  return trials
}

function summarizePrimary(trials) {
  const out = {}
  for (const scope of SCOPES) {
    out[scope] = {}
    for (const arm of ARMS) {
      const rows = trials.filter((trial) => trial.scope === scope && trial.arm === arm)
      out[scope][arm] = {
        trials: rows.length,
        localCycleMs: summarize(rows.map((row) => row.localCycleMs)),
        captureCycleMs: summarize(rows.map((row) => row.captureCycleMs)),
        exportCycleMs: summarize(rows.map((row) => row.exportCycleMs)),
        postSvgUrlBytes: summarize(rows.map((row) => row.after.svgUrlBytes)),
        postSvgDecodedBytes: summarize(rows.map((row) => row.after.svgDecodedBytes)),
        postMapBytes: summarize(rows.map((row) => row.after.mapBytes)),
        mapPairBytes: summarize(rows.map((row) => row.transitionStateBytes.mapPair)),
        postSensorReportBytes: summarize(rows.map((row) => row.after.reportBytes)),
        mapEntries: summarize(rows.map((row) => row.after.mapEntries)),
      }
    }
  }
  return out
}

function summarizeVisual(trials) {
  const out = {}
  for (const runtime of ['snapdom224', 'snapdom3']) {
    out[runtime] = {}
    for (const profile of VISUAL_PROFILES) {
      const rows = trials.filter((trial) => trial.runtime === runtime && trial.profile === profile.name)
      out[runtime][profile.name] = {
        scale: profile.scale,
        dpr: profile.dpr,
        effectiveRasterScale: profile.scale * profile.dpr,
        captureMs: summarize(rows.map((row) => row.captureMs)),
        exportMs: summarize(rows.map((row) => row.exportMs)),
        svgDecodedBytes: summarize(rows.map((row) => row.svgDecodedBytes)),
        pngDataUrlBytes: summarize(rows.map((row) => row.pngDataUrlBytes)),
        pngNaturalWidth: summarize(rows.map((row) => row.pngNaturalWidth)),
        pngNaturalHeight: summarize(rows.map((row) => row.pngNaturalHeight)),
      }
    }
  }
  return out
}

function summarizeAgentMapImages(trials) {
  return Object.fromEntries(AGENT_MAP_IMAGE_WIDTHS.map((width) => {
    const rows = trials.filter((trial) => trial.maxImageWidth === width)
    return [width, {
      captureMs: summarize(rows.map((row) => row.captureMs)),
      exportMs: summarize(rows.map((row) => row.exportMs)),
      imageBytes: summarize(rows.map((row) => row.imageBytes)),
      mapBytes: summarize(rows.map((row) => row.mapBytes)),
      outputWidth: summarize(rows.map((row) => row.width)),
      outputHeight: summarize(rows.map((row) => row.height)),
      entries: summarize(rows.map((row) => row.entries)),
    }]
  }))
}

function decide({ primarySummary, visualSummary, quality }) {
  const page = primarySummary.page
  const target = primarySummary.target
  const sensorReport = page.sensor.postSensorReportBytes.p50
  const rawSvg = page.raw.postSvgUrlBytes.p50
  const mapPost = page['agent-map'].postMapBytes.p50
  const sensorVsSvg = sensorReport / rawSvg
  const sensorVsMap = sensorReport / mapPost
  const sensorVsRawLocal = page.sensor.localCycleMs.p50 / page.raw.localCycleMs.p50
  const combinedVsMapLocal = page.combined.localCycleMs.p50 / page['agent-map'].localCycleMs.p50
  const targetVsPage = target.combined.localCycleMs.p50 / page.combined.localCycleMs.p50
  const qualityPass = quality.composition.baselineStatus === 'BASELINE_ESTABLISHED' &&
    quality.composition.quietSemanticTotal === 0 &&
    quality.composition.quietActionabilityLost === 0 &&
    quality.composition.quietActionabilityGained === 0
  const agentBoundaryPass = qualityPass && sensorVsSvg <= 0.25 && sensorVsMap <= 0.5
  const localCheapPass = sensorVsRawLocal <= 1.25 && combinedVsMapLocal <= 1.35
  const localCostVerdict = localCheapPass
    ? 'PASS'
    : (sensorVsRawLocal <= 1.5 && combinedVsMapLocal <= 1.5 ? 'HELPER_ONLY' : 'FAIL')
  const scaleChecks = Object.fromEntries(Object.entries(visualSummary).map(([runtime, rows]) => {
    const low = rows.low
    const standard = rows.standard
    const equal = rows['equal-effective']
    const retina = rows.retina
    const svgValues = Object.values(rows).map((row) => row.svgDecodedBytes.p50)
    const svgSpread = (Math.max(...svgValues) - Math.min(...svgValues)) / median(svgValues)
    return [runtime, {
      lowPngVsStandard: low.pngDataUrlBytes.p50 / standard.pngDataUrlBytes.p50,
      lowPixelsVsStandard: (low.pngNaturalWidth.p50 * low.pngNaturalHeight.p50) /
        (standard.pngNaturalWidth.p50 * standard.pngNaturalHeight.p50),
      equalEffectivePngRatio: equal.pngDataUrlBytes.p50 / standard.pngDataUrlBytes.p50,
      retinaPngVsStandard: retina.pngDataUrlBytes.p50 / standard.pngDataUrlBytes.p50,
      decodedSvgSpreadRatio: svgSpread,
      pass: low.pngDataUrlBytes.p50 < standard.pngDataUrlBytes.p50 &&
        low.pngNaturalWidth.p50 < standard.pngNaturalWidth.p50,
    }]
  }))
  return {
    quality: qualityPass ? 'PASS' : 'FAIL',
    agentBoundaryValue: {
      verdict: agentBoundaryPass ? 'PASS' : 'FAIL',
      sensorReportVsOnePostSvg: sensorVsSvg,
      sensorReportVsOnePostAgentMap: sensorVsMap,
      rule: 'report <=25% of post SVG and <=50% of one post map on whole-root fixture',
    },
    localCost: {
      verdict: localCostVerdict,
      sensorVsRawCycle: sensorVsRawLocal,
      combinedVsAgentMapCycle: combinedVsMapLocal,
      rule: 'PASS <=1.25x / <=1.35x; HELPER_ONLY when both <=1.5x',
    },
    scopeValue: {
      verdict: targetVsPage <= 0.5 ? 'PASS' : 'FAIL',
      targetVsPageCombinedCycle: targetVsPage,
    },
    visualKnobs: {
      verdict: Object.values(scaleChecks).every((check) => check.pass) ? 'PASS' : 'FAIL',
      runtimes: scaleChecks,
    },
    commercialValue: 'NOT_ASSESSED',
  }
}

function validateRun({ run, primarySummary, httpRequests: requests, decisions }) {
  const sensorTrials = run.primaryTrials.filter((trial) => trial.arm === 'sensor' || trial.arm === 'combined')
  const mapTrials = run.primaryTrials.filter((trial) => trial.arm === 'agent-map' || trial.arm === 'combined')
  const exactCounts = run.primaryTrials.length === ARMS.length * SCOPES.length * REPS &&
    run.visualTrials.length === 2 * VISUAL_PROFILES.length * VISUAL_REPS &&
    run.agentMapImageTrials.length === AGENT_MAP_IMAGE_WIDTHS.length * VISUAL_REPS
  const sensorExact = sensorTrials.every((trial) => trial.quality.sensorExact === true)
  const mapExact = mapTrials.every((trial) => trial.quality.mapExact === true)
  const combinedExports = run.primaryTrials
    .filter((trial) => trial.arm === 'combined')
    .every((trial) => trial.quality.combinedExports === true)
  const finite = run.primaryTrials.every((trial) =>
    [trial.localCycleMs, trial.captureCycleMs, trial.exportCycleMs,
      trial.after.svgUrlBytes, trial.after.svgDecodedBytes]
      .every((value) => Number.isFinite(value) && value >= 0))
  const summaryCounts = SCOPES.every((scope) => ARMS.every((arm) =>
    primarySummary[scope][arm].trials === REPS))
  const noOpExact = run.quality.composition.quietSemanticTotal === 0 &&
    run.quality.composition.quietActionabilityLost === 0 &&
    run.quality.composition.quietActionabilityGained === 0
  const sensorSecretSafe = !run.quality.privacy.sensorReportContainsSyntheticSecret
  const checks = {
    exactTrialCounts: exactCounts,
    sensorExactOnAllMeasuredActions: sensorExact,
    agentMapExactOnAllMeasuredActions: mapExact,
    combinedExportsOnSameResult: combinedExports,
    finiteNonNegativeMetrics: finite,
    summaryCellCounts: summaryCounts,
    sensorNoOpExact: noOpExact,
    sensorSyntheticSecretAbsent: sensorSecretSafe,
    noHttpRequests: requests.length === 0,
    decisionQualityPass: decisions.quality === 'PASS',
  }
  assert(Object.values(checks).every(Boolean), `integrity failure: ${JSON.stringify(checks)}`)
  return { valid: true, checks }
}

function renderMarkdown(result) {
  const p = result.primary.summary
  const d = result.decisions
  const v = result.visualScaleDpr.summary
  const a = result.agentMapImageWidth.summary
  const lines = [
    '# SnapDOM AgentMap + Sensor cost probe',
    '',
    `Classification: ${result.classification}.`,
    '',
    '## Outcome',
    '',
    `- Candidate agent-boundary value: **${d.agentBoundaryValue.verdict}**. Sensor/post-SVG = ${pct(d.agentBoundaryValue.sensorReportVsOnePostSvg)}; Sensor/post-map = ${pct(d.agentBoundaryValue.sensorReportVsOnePostAgentMap)}.`,
    `- Cheap local overhead claim: **${d.localCost.verdict}**. Sensor/raw cycle = ${ratio(d.localCost.sensorVsRawCycle)}; combined/map cycle = ${ratio(d.localCost.combinedVsAgentMapCycle)}.`,
    `- Scope value: **${d.scopeValue.verdict}**. Target/whole-page combined cycle = ${pct(d.scopeValue.targetVsPageCombinedCycle)}.`,
    `- Raster knobs: **${d.visualKnobs.verdict}**.`,
    `- Commercial value: **${d.commercialValue}**.`,
    '',
    'No cloud or model call occurred. “Boundary bytes” below are candidate payloads measured locally, not observed network egress.',
    `The no-op probe retained status **${result.quality.composition.quietStatus}** because it deliberately contained a sensitive password blind spot, while reporting zero semantic and actionability delta. That uncertainty was not coerced to PASS.`,
    '',
    '## Primary local cycle and candidate payload',
    '',
    '| Scope | Arm | Local cycle p50 | Capture p50 | Export p50 | Post SVG URL | Post map | Map pair | Sensor delta | Map entries |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const scope of SCOPES) {
    for (const arm of ARMS) {
      const row = p[scope][arm]
      lines.push(`| ${scope} | ${arm} | ${ms(row.localCycleMs.p50)} | ${ms(row.captureCycleMs.p50)} | ${ms(row.exportCycleMs.p50)} | ${bytes(row.postSvgUrlBytes.p50)} | ${bytes(row.postMapBytes.p50)} | ${bytes(row.mapPairBytes.p50)} | ${bytes(row.postSensorReportBytes.p50)} | ${Math.round(row.mapEntries.p50)} |`)
    }
  }
  lines.push(
    '',
    'AgentMap and Sensor are not substitutes: AgentMap answers “what can I act on now?”; Sensor answers “what changed since the last capture?”. The combined arm obtains both from the same two SnapDOM results.',
    '',
    '## Scale and DPR',
    '',
    '| Runtime | Profile | scale | DPR | PNG p50 | PNG dimensions | decoded SVG p50 |',
    '|---|---:|---:|---:|---:|---:|---:|',
  )
  for (const runtime of ['snapdom224', 'snapdom3']) {
    for (const profile of VISUAL_PROFILES) {
      const row = v[runtime][profile.name]
      lines.push(`| ${runtime} | ${profile.name} | ${profile.scale} | ${profile.dpr} | ${bytes(row.pngDataUrlBytes.p50)} | ${Math.round(row.pngNaturalWidth.p50)}×${Math.round(row.pngNaturalHeight.p50)} | ${bytes(row.svgDecodedBytes.p50)} |`)
    }
  }
  lines.push(
    '',
    'The fixture has no embedded raster assets. Therefore scale/DPR change the optional PNG but not the DOM/CSS structure serialized into the raw SVG. For structural savings, capture a smaller root or use clip/exclude.',
    '',
    '## AgentMap image width',
    '',
    '| maxImageWidth | output dimensions | image p50 | map p50 |',
    '|---:|---:|---:|---:|',
  )
  for (const width of AGENT_MAP_IMAGE_WIDTHS) {
    const row = a[width]
    lines.push(`| ${width} | ${Math.round(row.outputWidth.p50)}×${Math.round(row.outputHeight.p50)} | ${bytes(row.imageBytes.p50)} | ${bytes(row.mapBytes.p50)} |`)
  }
  lines.push(
    '',
    'AgentMap performs its own raster pass. Its effective visual-cost knob is `maxImageWidth`; `image:false` omits that pass entirely, while SnapDOM still produces the normal SVG capture.',
    '',
    '## Attached AgentMap finding',
    '',
    `- Native SnapDOM ${result.provenance.snapdom224.packageVersion} + AgentMap loaded: ${result.quality.attachedAgentMap224.nativeRuntimeWorked}.`,
    `- Capturing an interactive root returned ${result.quality.attachedAgentMap224.interactiveRootMapEntries} entries: **${result.quality.attachedAgentMap224.finding}**.`,
    `- A synthetic password was present in AgentMap JSON: **${result.quality.privacy.agentMapContainsSyntheticSecret}**.`,
    `- The same synthetic password was present in Sensor JSON: **${result.quality.privacy.sensorReportContainsSyntheticSecret}**.`,
    '',
    'This is why the old plugin matters but is not the whole product. It already proved local actionable perception. The Sensor adds temporal memory, bounded typed deltas, privacy handling, and explicit uncertainty; AgentMap itself still needs privacy and geometry hardening.',
    '',
    '## Boundaries',
    '',
    '- Synthetic fixture, one machine, one browser version.',
    '- No token estimate and no model task-success claim.',
    '- Local timings are descriptive; bytes are exact UTF-8 lengths.',
    '- The attached AgentMap source came from the SnapDOM 2.24.1 tree; the composition arm ran on the Sensor peer runtime (vendored SnapDOM 3 beta).',
    '- No personal Chrome profile, session, tab, cookie store, password store, or extension was accessed.',
    '',
    `JSON evidence: [sensor-agent-cost-v1.json](./sensor-agent-cost-v1.json). Preregistration: [sensor-agent-cost-v1.preregistration.json](./sensor-agent-cost-v1.preregistration.json).`,
    '',
  )
  return `${lines.join('\n')}\n`
}

function summarize(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b)
  assert(clean.length, 'cannot summarize empty values')
  return {
    min: round(clean[0]),
    p50: round(percentile(clean, 0.5)),
    p95: round(percentile(clean, 0.95)),
    max: round(clean.at(-1)),
  }
}

function percentile(sorted, p) {
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 0.5)
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function omitSource(entry) {
  return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }
}

async function assertAbsent(path) {
  try {
    await readFile(path)
    throw new Error(`refusing to overwrite existing output: ${path}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function pct(value) {
  return `${round(value * 100, 1)}%`
}

function ratio(value) {
  return `${round(value, 2)}×`
}

function ms(value) {
  return `${round(value, 1)} ms`
}

function bytes(value) {
  const rounded = Math.round(value)
  if (rounded < 1024) return `${rounded} B`
  return `${round(rounded / 1024, 1)} KiB`
}
