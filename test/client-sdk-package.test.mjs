import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'browser-sdk')
const BUILD = join(SDK, 'build.mjs')
const FORBIDDEN = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['node: import', /['"`]node:[^'"`]+['"`]/],
  ['Playwright', /(?:@playwright|\bplaywright\b)/i],
]

test('packed browser SDK preserves the historical portable receipt surface', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'snapdom-receipt-package-'))
  let context

  try {
    execFileSync(process.execPath, [BUILD, '--check'], { cwd: ROOT, stdio: 'pipe' })

    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
    ], { cwd: SDK, encoding: 'utf8' }))[0]
    const archive = join(temp, packed.filename)
    const install = join(temp, 'install')
    mkdirSync(install)
    execFileSync('npm', [
      'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive,
    ], { cwd: install, stdio: 'pipe' })

    const installed = join(install, 'node_modules', '@zumer', 'snapdom-receipt')
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      assert.deepEqual(pkg[field] || {}, {}, `${field} must be empty in the packed SDK`)
    }
    assert.equal(pkg.private, true)
    assert.equal(pkg.sideEffects, false)

    const relativeBundle = pkg.exports['.'].import
    const bundlePath = join(installed, relativeBundle)
    const bundle = readFileSync(bundlePath)
    const bundleText = bundle.toString('utf8')
    const manifest = JSON.parse(readFileSync(join(installed, 'dist-manifest.json'), 'utf8'))
    assert.equal(manifest.bytes, bundle.byteLength)
    assert.equal(manifest.sha256, createHash('sha256').update(bundle).digest('hex'))
    assert.deepEqual(manifest.dependencies, [])
    assert.deepEqual(manifest.staticEvidence.matches, [])
    for (const [label, pattern] of FORBIDDEN) {
      assert.doesNotMatch(bundleText, pattern, `bundle contains forbidden ${label}`)
    }

    // Playwright is only the test harness. A dedicated temporary Chromium profile is
    // removed below; this test never opens the user's Chrome or any network port.
    context = await chromium.launchPersistentContext(join(temp, 'chromium-profile'), {
      headless: true,
    })
    const page = context.pages()[0] || await context.newPage()
    await page.setContent(`
      <!doctype html>
      <style>body { margin: 0; } main { padding: 24px; }</style>
      <main id="fixture">
        <h1>Notification settings</h1>
        <button data-testid="alerts" aria-pressed="false">Enable alerts</button>
        <p data-testid="status">Alerts are off</p>
        <canvas data-testid="chart" width="20" height="20"></canvas>
      </main>
    `)

    const result = await page.evaluate(async (source) => {
      const moduleUrl = globalThis.URL.createObjectURL(new globalThis.Blob([source], { type: 'text/javascript' }))
      try {
        const sdk = await import(moduleUrl)
        const root = globalThis.document.querySelector('#fixture')
        const baseline = JSON.parse(JSON.stringify(sdk.createBaseline(root)))
        const statusRow = baseline.checkpoint.nodes.find((row) => {
          const bits = row[8]
          if (!(bits & (1 << 5))) return false
          let index = 9
          for (const bit of [1 << 0, 1 << 1, 1 << 2, 1 << 3, 1 << 4]) {
            if (bits & bit) index++
          }
          return row[index] === 'status'
        })
        const statusId = statusRow?.[0]

        root.querySelector('[data-testid="alerts"]').setAttribute('aria-pressed', 'true')
        root.querySelector('[data-testid="status"]').textContent = 'Alerts are on'

        const receipt = sdk.createReceipt(root, {
          baseline,
          expected: { changed: true },
          limits: { changes: 8, actionability: 4, unobservable: 4 },
        })
        const canvasBaseline = JSON.parse(JSON.stringify(sdk.createBaseline(root)))
        root.querySelector('canvas').getContext('2d').fillRect(0, 0, 1, 1)
        const unknownReceipt = sdk.createReceipt(root, {
          baseline: canvasBaseline,
          expected: { changed: false },
          limits: { changes: 1, actionability: 1, unobservable: 1 },
        })

        const capRoot = globalThis.document.createElement('section')
        capRoot.innerHTML = Array.from({ length: 12 }, (_, i) => `<span data-testid="cap-${i}">before</span>`).join('')
        globalThis.document.body.append(capRoot)
        const capBaseline = sdk.createBaseline(capRoot)
        for (const span of capRoot.querySelectorAll('span')) span.textContent = 'after'
        const cappedReceipt = sdk.createReceipt(capRoot, {
          baseline: capBaseline,
          expected: { changed: true },
          limits: { changes: 2, actionability: 1, unobservable: 1 },
        })

        const privacyRoot = globalThis.document.createElement('section')
        privacyRoot.innerHTML = '<p data-testid="private-status">Secret account</p>'
        globalThis.document.body.append(privacyRoot)
        const privacyBaseline = JSON.parse(JSON.stringify(sdk.createBaseline(privacyRoot, {
          privacy: { redact: ['Secret account'] },
        })))
        privacyRoot.querySelector('p').textContent = 'Updated'
        const privateReceipt = sdk.createReceipt(privacyRoot, {
          baseline: privacyBaseline,
          expected: { changed: true },
          limits: { changes: 4, actionability: 1, unobservable: 1 },
        })
        return {
          exports: Object.keys(sdk).sort(),
          baseline,
          receipt,
          unknownReceipt,
          cappedReceipt,
          privateReceipt,
          statusId,
        }
      } finally {
        globalThis.URL.revokeObjectURL(moduleUrl)
      }
    }, bundleText)

    assert.deepEqual(result.exports, manifest.exports.slice().sort())
    assert.equal(result.baseline.contract, 'snapdom.action-baseline/v1')
    assert.equal(result.baseline.checkpoint.version, 2)
    assert.equal(result.receipt.contract, 'snapdom.action-receipt/v1')
    assert.equal(result.receipt.taskOutcome, 'NOT_ASSESSED')
    assert.equal(result.receipt.postcondition.outcome, 'PASS')
    assert.deepEqual(result.receipt.postcondition.expected, { changed: true })
    assert.equal(result.receipt.observed.changed, true)
    assert.ok(result.receipt.observed.changes.items.every((change) => typeof change.kind === 'string'))
    assert.ok(result.receipt.observed.changes.items.some((change) =>
      change.kind === 'state' &&
      change.role === 'button' &&
      change.before?.pressed === false &&
      change.after?.pressed === true
    ), 'receipt must include the typed button state transition')
    assert.ok(result.receipt.observed.changes.items.some((change) =>
      change.kind === 'content' && change.id === result.statusId
    ), 'receipt must preserve the status identity and include its typed content transition')
    assert.equal(result.unknownReceipt.taskOutcome, 'NOT_ASSESSED')
    assert.equal(result.unknownReceipt.postcondition.outcome, 'UNKNOWN')
    assert.equal(result.unknownReceipt.observed.unobservable.total, 1)
    assert.equal(result.cappedReceipt.postcondition.outcome, 'PASS')
    assert.equal(result.cappedReceipt.observed.changes.items.length, 2)
    assert.ok(result.cappedReceipt.observed.changes.total > 2)
    assert.equal(
      result.cappedReceipt.observed.changes.truncated,
      result.cappedReceipt.observed.changes.total - 2,
    )
    assert.equal(result.receipt.privacy.rulesActive, 0)
    assert.equal(JSON.stringify(result.receipt).includes('__snapshot'), false)
    assert.equal(result.privateReceipt.postcondition.outcome, 'PASS')
    assert.equal(result.privateReceipt.privacy.rulesActive, 1)
    assert.equal(JSON.stringify(result.privateReceipt).includes('Secret account'), false)
    assert.equal('checkpoint' in result.privateReceipt, false)
  } finally {
    if (context) await context.close().catch(() => {})
    rmSync(temp, { recursive: true, force: true })
  }
})
