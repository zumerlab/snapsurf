import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SENSOR = join(ROOT, 'packages', 'sensor')
const BUILD = join(SENSOR, 'build.mjs')
const SNAPDOM_PEER = '>=3.0.0-beta.0 <4'
const EXPORTS = ['SENSOR_PLUGIN_NAME', 'SENSOR_REPORT_CONTRACT', 'sensor']
const FORBIDDEN = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['node: import', /\bnode:/],
  ['Playwright', /(?:@playwright|\bplaywright\b)/i],
  ['agent package', /@zumer\/snapdom-agent/],
  ['MCP import', /(?:^|["'])\.?\.?\/[^"']*mcp\//m],
]

function packCoreFixture(temp) {
  const fixture = join(temp, 'snapdom-core')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({
    name: '@zumer/snapdom',
    version: '3.0.0-beta.0',
    type: 'module',
    exports: { '.': './snapdom.mjs' },
  }, null, 2)}\n`)
  copyFileSync(join(ROOT, 'vendor', 'snapdom', 'dist', 'snapdom.mjs'), join(fixture, 'snapdom.mjs'))
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
  ], { cwd: fixture, encoding: 'utf8' }))[0]
  return join(temp, packed.filename)
}

test('packed SnapDOM Sensor is a standard plugin with an external SnapDOM peer', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'snapdom-sensor-package-'))
  let context
  try {
    execFileSync(process.execPath, [BUILD, '--check'], { cwd: ROOT, stdio: 'pipe' })

    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
    ], { cwd: SENSOR, encoding: 'utf8' }))[0]
    const archive = join(temp, packed.filename)
    const coreArchive = packCoreFixture(temp)
    const install = join(temp, 'install')
    mkdirSync(install)
    execFileSync('npm', [
      'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      coreArchive, archive,
    ], { cwd: install, stdio: 'pipe' })

    const installed = join(install, 'node_modules', '@zumer', 'snapdom-sensor')
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.dependencies || {}, {})
    assert.deepEqual(pkg.optionalDependencies || {}, {})
    assert.deepEqual(pkg.peerDependencies, { '@zumer/snapdom': SNAPDOM_PEER })
    assert.deepEqual(pkg.devDependencies, { '@zumer/snapdom': '3.0.0-beta.0' })
    assert.equal(pkg.private, true)
    assert.equal(pkg.sideEffects, false)

    const bundlePath = join(installed, pkg.exports['.'].import)
    const bundle = readFileSync(bundlePath)
    const bundleText = bundle.toString('utf8')
    const manifest = JSON.parse(readFileSync(join(installed, 'dist-manifest.json'), 'utf8'))
    assert.equal(manifest.package, '@zumer/snapdom-sensor')
    assert.equal(manifest.bytes, bundle.byteLength)
    assert.equal(manifest.sha256, createHash('sha256').update(bundle).digest('hex'))
    assert.deepEqual(manifest.exports, EXPORTS)
    assert.deepEqual(manifest.peerDependencies, { '@zumer/snapdom': SNAPDOM_PEER })
    assert.deepEqual(manifest.externalImports, [])
    assert.deepEqual(manifest.staticEvidence.matches, [])
    for (const [label, pattern] of FORBIDDEN) {
      assert.doesNotMatch(bundleText, pattern, `bundle contains forbidden ${label}`)
    }

    const sdk = await import(`${pathToFileURL(bundlePath).href}?audit=${manifest.sha256}`)
    assert.deepEqual(Object.keys(sdk).sort(), EXPORTS.slice().sort())
    assert.equal(sdk.SENSOR_PLUGIN_NAME, 'snapdom-sensor')
    assert.equal(sdk.SENSOR_REPORT_CONTRACT, 'snapdom.sensor/v1')
    const pluginShape = sdk.sensor()
    assert.equal(pluginShape.name, 'snapdom-sensor')
    assert.equal(typeof pluginShape.afterClone, 'function')
    assert.equal(typeof pluginShape.defineExports, 'function')
    assert.equal(pluginShape.observe, undefined)

    // Playwright is only the isolated test harness. It imports the installed tarballs
    // into a temporary Chromium profile; neither package controls a browser itself.
    context = await chromium.launchPersistentContext(join(temp, 'chromium-profile'), {
      headless: true,
    })
    const page = context.pages()[0] || await context.newPage()
    await page.setContent(`
      <!doctype html>
      <main id="fixture">
        <button data-testid="mode" aria-pressed="false">Mode</button>
        <p data-testid="status" role="status">Ready</p>
      </main>
    `)
    const coreText = readFileSync(
      join(install, 'node_modules', '@zumer', 'snapdom', 'snapdom.mjs'),
      'utf8',
    )
    const browserResult = await page.evaluate(async ({ sensorSource, coreSource }) => {
      const coreUrl = globalThis.URL.createObjectURL(new globalThis.Blob([coreSource], {
        type: 'text/javascript',
      }))
      const sensorUrl = globalThis.URL.createObjectURL(new globalThis.Blob([sensorSource], {
        type: 'text/javascript',
      }))
      try {
        const [{ snapdom }, sensorSdk] = await Promise.all([import(coreUrl), import(sensorUrl)])
        const root = globalThis.document.querySelector('#fixture')
        const plugin = sensorSdk.sensor()
        const before = await snapdom(root, {
          plugins: [plugin], embedFonts: false, cache: 'disabled',
        })
        root.querySelector('button').setAttribute('aria-pressed', 'true')
        root.querySelector('[role="status"]').textContent = 'Saved'
        const after = await snapdom(root, {
          plugins: [plugin], embedFonts: false, cache: 'disabled',
        })
        return {
          firstUrl: before.url.slice(0, 32),
          baseline: await before.toSensor(),
          report: await after.toSensor(),
          hasPng: typeof after.toPng === 'function',
        }
      } finally {
        globalThis.URL.revokeObjectURL(sensorUrl)
        globalThis.URL.revokeObjectURL(coreUrl)
      }
    }, { sensorSource: bundleText, coreSource: coreText })

    assert.match(browserResult.firstUrl, /^data:image\/svg\+xml/)
    assert.equal(browserResult.hasPng, true)
    assert.equal(browserResult.baseline.observation.status, 'BASELINE_ESTABLISHED')
    assert.equal(browserResult.report.contract, 'snapdom.sensor/v1')
    assert.equal(browserResult.report.taskAssessment.status, 'NOT_ASSESSED')
    assert.equal(browserResult.report.observation.status, 'DELTA_DETECTED')
    assert.equal(browserResult.report.observation.semanticDelta.total, 2)
    assert.equal(browserResult.report.localState.checkpointEncoding, 'NOT_USED')
    assert.equal(browserResult.report.visual.svg, 'CAPTURED_BY_SNAPDOM')
    assert.equal('postcondition' in browserResult.report, false)
  } finally {
    if (context) await context.close().catch(() => {})
    rmSync(temp, { recursive: true, force: true })
  }
})

