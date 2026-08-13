/**
 * Hermetic deployment gate for the browser-only receipt SDK embedded in an
 * existing MV3 buyer extension.
 *
 * Product boundary under test:
 *   existing content script -> embedded @zumer/snapdom-receipt ->
 *   chrome.runtime messaging -> existing service worker -> extension audit page
 *
 * Playwright, npm, esbuild, the loopback fixture, and the temporary Chromium
 * profile are test/build harnesses only. They are not part of the extension's
 * runtime path. This gate never opens Chrome or a user profile.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK_DIR = join(ROOT, 'browser-sdk')
const RESULT_PATH = join(ROOT, 'experiment', 'results', 'oem-embed-gate.json')
const WRITE_RESULT = process.argv.includes('--write')
const COOKIE_NAME = 'oem_mock_session'
const COOKIE_SECRET = 'cookie-secret-only-for-hermetic-oem-gate'
const STORAGE_KEY = 'oem.mock.session'
const STORAGE_SECRET = 'storage-secret-only-for-hermetic-oem-gate'
const CHANNEL = 'oem-buyer-internal-v1'
const FORBIDDEN_PORT = 8377

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const jsonClone = (value) => JSON.parse(JSON.stringify(value))

function manifestRuntimeSurface(manifest) {
  return {
    permissions: manifest.permissions || [],
    optional_permissions: manifest.optional_permissions || [],
    host_permissions: manifest.host_permissions || [],
    optional_host_permissions: manifest.optional_host_permissions || [],
    content_scripts: (manifest.content_scripts || []).map((script) => ({
      matches: script.matches || [],
      exclude_matches: script.exclude_matches || [],
      all_frames: !!script.all_frames,
      match_about_blank: !!script.match_about_blank,
      world: script.world || 'ISOLATED',
    })),
    externally_connectable: manifest.externally_connectable || null,
  }
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function createFixtureServer(requests) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const server = createServer((req, res) => {
      const authenticated = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=${COOKIE_SECRET}(?:;|$)`)
        .test(req.headers.cookie || '')
      requests.push({
        method: req.method,
        path: req.url,
        authenticated,
        // Never retain the Cookie header or its value in the evidence artifact.
        cookieHeaderPresent: !!req.headers.cookie,
      })

      if (req.method !== 'GET' || req.url !== '/fixture') {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      if (!authenticated) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end('<!doctype html><h1>Fixture sign-in required</h1>')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' 'unsafe-inline'; img-src data:",
      })
      res.end(`<!doctype html>
        <html><head><meta charset="utf-8"><link rel="icon" href="data:,">
        <style>body{font:16px system-ui;margin:0}main{padding:24px}button{padding:8px 14px}</style></head>
        <body>
          <main data-oem-receipt-root aria-label="Existing buyer workspace">
            <h1>Existing authenticated workspace</h1>
            <p data-testid="auth-state" data-authenticated="true">Synthetic member session is active</p>
            <button data-testid="add-item" aria-pressed="false">Add item</button>
            <p data-testid="status" role="status">Ready</p>
          </main>
          <script>
            const localStatePresent = Boolean(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
            document.documentElement.dataset.buyerLocalState = localStatePresent ? 'present' : 'missing';
            globalThis.__fixtureActionCount = 0;
            document.querySelector('[data-testid="add-item"]').addEventListener('click', (event) => {
              globalThis.__fixtureActionCount++;
              event.currentTarget.setAttribute('aria-pressed', 'true');
              document.querySelector('[data-testid="status"]').textContent = 'Added item';
            });
          </script>
        </body></html>`)
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new Error('fixture did not bind an IPv4 loopback port')
    }
    if (address.port !== FORBIDDEN_PORT) return { server, port: address.port }
    await closeServer(server)
  }
  throw new Error('OS repeatedly selected the reserved manual-service port')
}

const CONTENT_ENTRY = `
import { createBaseline, createReceipt } from '@zumer/snapdom-receipt'

const CHANNEL = ${JSON.stringify(CHANNEL)}
const BUYER_STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)}
const root = document.querySelector('[data-oem-receipt-root]')
const target = root?.querySelector('[data-testid="add-item"]')
const status = root?.querySelector('[data-testid="status"]')
const renderedAuthenticatedState =
  root?.querySelector('[data-testid="auth-state"]')?.dataset.authenticated === 'true'
// This is the buyer host's pre-existing browser-state read. Only presence crosses into
// the receipt; the local value itself is never read into an output field.
const buyerLocalStatePresent = Boolean(localStorage.getItem(BUYER_STORAGE_KEY))

if (!root || !target || !status) {
  document.documentElement.dataset.buyerHostReady = 'fixture-missing'
} else {
  // This marker represents the buyer extension's pre-existing feature: its content
  // script recognizes the already-rendered workspace and local browser state. The SDK
  // is embedded into this same script; it does not introduce another extension.
  document.documentElement.dataset.buyerHostMode =
    renderedAuthenticatedState && buyerLocalStatePresent ? 'authenticated-workspace' : 'unavailable'

  let baseline = JSON.parse(JSON.stringify(createBaseline(root)))
  document.documentElement.dataset.buyerHostReady = 'true'
  void chrome.runtime.sendMessage({
    channel: CHANNEL,
    type: 'BUYER_HOST_READY',
    renderedAuthenticatedState,
    buyerLocalStatePresent,
    baselineContract: baseline.contract,
    checkpointVersion: baseline.checkpoint.version,
  })

  target.addEventListener('click', () => {
    // Capture in the isolated content-script world before the page's bubble listener.
    baseline = JSON.parse(JSON.stringify(createBaseline(root)))

    requestAnimationFrame(() => requestAnimationFrame(() => {
      // The public SDK owns the wire contract. Deliberately cap every evidence family at
      // zero here: this proves totals/truncation remain available without depending on a
      // hand-built host envelope or exporting page strings.
      const receipt = createReceipt(root, {
        baseline,
        expected: { changed: true },
        limits: { changes: 0, actionability: 0, unobservable: 0 },
      })
      void chrome.runtime.sendMessage({
        channel: CHANNEL,
        type: 'BUYER_ACTION_RECEIPT',
        receipt,
      })
    }))
  }, { capture: true })
}
`

const WORKER_SOURCE = `
const CHANNEL = ${JSON.stringify(CHANNEL)}
let hostReady = null
let lastReceipt = null
let receiptIngressCount = 0

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== CHANNEL || sender.id !== chrome.runtime.id) return false
  if (message.type === 'BUYER_HOST_READY') {
    if (!sender.tab) return false
      hostReady = {
      renderedAuthenticatedState: message.renderedAuthenticatedState === true,
      buyerLocalStatePresent: message.buyerLocalStatePresent === true,
      checkpointVersion: message.checkpointVersion,
      baselineContract: message.baselineContract,
    }
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'BUYER_ACTION_RECEIPT') {
    if (!sender.tab) return false
      // A second JSON round-trip (after the browser's structured clone) proves the
      // receipt is a portable wire object, not a live DOM/API handle. The service worker
      // receives it only through extension-internal messaging.
    lastReceipt = JSON.parse(JSON.stringify(message.receipt))
    receiptIngressCount++
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'BUYER_AUDIT_GET') {
    sendResponse({
      transport: {
        channel: CHANNEL,
        path: ['content-script', 'service-worker', 'extension-page'],
        api: 'chrome.runtime.sendMessage/onMessage',
      },
      hostReady,
      receiptIngressCount,
      receipt: lastReceipt,
    })
    return false
  }
  return false
})
`

const AUDIT_SOURCE = `
const CHANNEL = ${JSON.stringify(CHANNEL)}
const out = document.querySelector('#state')
const timer = setInterval(async () => {
  const state = await chrome.runtime.sendMessage({ channel: CHANNEL, type: 'BUYER_AUDIT_GET' })
  if (state?.receipt) {
    clearInterval(timer)
    out.textContent = JSON.stringify(state)
    document.documentElement.dataset.receiptReady = 'true'
  }
}, 25)
`

const AUDIT_HTML = `<!doctype html><meta charset="utf-8">
  <title>Buyer receipt audit</title><pre id="state">waiting</pre><script src="audit.js"></script>`

async function runGate() {
  const temp = mkdtempSync(join(tmpdir(), 'snapdom-oem-embed-gate-'))
  const extensionDir = join(temp, 'buyer-extension')
  const installDir = join(temp, 'buyer-build')
  const profileDir = join(temp, 'chromium-profile')
  const requests = []
  let context
  let server
  let result
  let primaryError

  try {
    mkdirSync(extensionDir, { recursive: true })
    mkdirSync(installDir, { recursive: true })

    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
    ], { cwd: SDK_DIR, encoding: 'utf8' }))[0]
    const archive = join(temp, packed.filename)
    execFileSync('npm', [
      'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive,
    ], { cwd: installDir, stdio: 'pipe' })

    const installedSdk = join(installDir, 'node_modules', '@zumer', 'snapdom-receipt')
    const sdkPackage = JSON.parse(readFileSync(join(installedSdk, 'package.json'), 'utf8'))
    const sdkManifest = JSON.parse(readFileSync(join(installedSdk, 'dist-manifest.json'), 'utf8'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      assert.deepEqual(sdkPackage[field] || {}, {}, `packed SDK ${field} must be empty`)
    }

    const existingBuyerManifest = {
      manifest_version: 3,
      name: 'Hermetic buyer extension host',
      version: '1.0.0',
      description: 'Synthetic existing buyer extension used only by the OEM embed gate.',
      background: { service_worker: 'worker.js' },
      content_scripts: [{
        // This match already belongs to the buyer's own rendered-workspace feature.
        matches: ['http://127.0.0.1/*'],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
        world: 'ISOLATED',
      }],
      action: { default_popup: 'audit.html' },
    }
    const snapdomIntegratedManifest = jsonClone(existingBuyerManifest)
    const beforeSurface = manifestRuntimeSurface(existingBuyerManifest)
    const afterSurface = manifestRuntimeSurface(snapdomIntegratedManifest)
    assert.deepEqual(afterSurface, beforeSurface, 'embedding SnapDOM must not alter the permission/runtime surface')
    assert.ok(!afterSurface.permissions.some((permission) =>
      ['debugger', 'tabs', 'scripting', 'nativeMessaging'].includes(permission)))
    assert.ok(!afterSurface.content_scripts.some((script) => script.matches.includes('<all_urls>')))

    const entryPath = join(installDir, 'content-entry.js')
    writeFileSync(entryPath, CONTENT_ENTRY)
    await build({
      absWorkingDir: installDir,
      entryPoints: [entryPath],
      bundle: true,
      charset: 'utf8',
      format: 'iife',
      legalComments: 'none',
      minify: true,
      platform: 'browser',
      target: ['chrome120'],
      outfile: join(extensionDir, 'content.js'),
      logLevel: 'silent',
    })
    writeFileSync(join(extensionDir, 'manifest.json'), `${JSON.stringify(snapdomIntegratedManifest, null, 2)}\n`)
    writeFileSync(join(extensionDir, 'worker.js'), WORKER_SOURCE)
    writeFileSync(join(extensionDir, 'audit.js'), AUDIT_SOURCE)
    writeFileSync(join(extensionDir, 'audit.html'), AUDIT_HTML)

    const runtimeSources = ['content.js', 'worker.js', 'audit.js']
      .map((name) => readFileSync(join(extensionDir, name), 'utf8'))
      .join('\n')
    const forbiddenRuntimePatterns = [
      ['network fetch', /\bfetch\s*\(/],
      ['XMLHttpRequest', /\bXMLHttpRequest\b/],
      ['WebSocket', /\bWebSocket\b/],
      ['sendBeacon', /\bsendBeacon\b/],
      ['Node import', /\bnode:/],
      ['Playwright import', /(?:@playwright|\bplaywright\b)/i],
      ['CDP debugger API', /chrome\.debugger|devtools\.protocol/i],
      ['native messaging', /connectNative|sendNativeMessage/i],
    ]
    const runtimeMatches = forbiddenRuntimePatterns
      .filter(([, pattern]) => pattern.test(runtimeSources))
      .map(([label]) => label)
    assert.deepEqual(runtimeMatches, [], `extension runtime contains forbidden surfaces: ${runtimeMatches.join(', ')}`)
    assert.ok(!runtimeSources.includes(COOKIE_SECRET), 'HttpOnly fixture secret leaked into extension runtime')
    assert.ok(!runtimeSources.includes(STORAGE_SECRET), 'localStorage fixture secret leaked into extension runtime')

    const fixture = await createFixtureServer(requests)
    server = fixture.server
    assert.notEqual(fixture.port, FORBIDDEN_PORT)
    const fixtureOrigin = `http://127.0.0.1:${fixture.port}`
    const fixtureUrl = `${fixtureOrigin}/fixture`

    // Playwright launches only a dedicated temporary Chromium profile as the test
    // harness. Neither Chrome nor any existing profile/session is addressed here.
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 900, height: 700 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    })
    await context.addCookies([{
      name: COOKIE_NAME,
      value: COOKIE_SECRET,
      url: fixtureOrigin,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    }])
    await context.addInitScript(({ origin, key, value }) => {
      if (globalThis.location.origin === origin) globalThis.localStorage.setItem(key, value)
    }, { origin: fixtureOrigin, key: STORAGE_KEY, value: STORAGE_SECRET })

    const page = context.pages()[0] || await context.newPage()
    const mainNavigations = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) mainNavigations.push(frame.url())
    })
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => globalThis.document.documentElement.dataset.buyerHostReady === 'true')
    const initialUrl = page.url()
    const preActionState = await page.evaluate(({ key, cookieName }) => ({
      buyerHostMode: globalThis.document.documentElement.dataset.buyerHostMode,
      localValuePresent: Boolean(globalThis.localStorage.getItem(key)),
      httpOnlyCookieVisibleToPage: globalThis.document.cookie.includes(`${cookieName}=`),
      renderedAuthenticated: globalThis.document.querySelector('[data-testid="auth-state"]')?.dataset.authenticated,
      actionCount: globalThis.__fixtureActionCount,
    }), { key: STORAGE_KEY, cookieName: COOKIE_NAME })

    await page.click('[data-testid="add-item"]')
    await page.waitForFunction(() => globalThis.document.querySelector('[data-testid="status"]')?.textContent === 'Added item')

    let worker = context.serviceWorkers()[0]
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
    const extensionId = new globalThis.URL(worker.url()).host
    assert.match(extensionId, /^[a-p]{32}$/)

    const auditPage = await context.newPage()
    await auditPage.goto(`chrome-extension://${extensionId}/audit.html`)
    await auditPage.waitForFunction(() => globalThis.document.documentElement.dataset.receiptReady === 'true')
    const wireText = await auditPage.locator('#state').textContent()
    const wire = JSON.parse(wireText)
    const receipt = wire.receipt
    const receiptWire = JSON.stringify(receipt)

    const postActionState = await page.evaluate(() => ({
      url: globalThis.location.href,
      actionCount: globalThis.__fixtureActionCount,
      pressed: globalThis.document.querySelector('[data-testid="add-item"]')?.getAttribute('aria-pressed'),
      status: globalThis.document.querySelector('[data-testid="status"]')?.textContent,
      navigationEntries: globalThis.performance.getEntriesByType('navigation').length,
    }))

    assert.equal(preActionState.buyerHostMode, 'authenticated-workspace')
    assert.equal(preActionState.localValuePresent, true)
    assert.equal(preActionState.httpOnlyCookieVisibleToPage, false)
    assert.equal(preActionState.renderedAuthenticated, 'true')
    assert.equal(preActionState.actionCount, 0)
    assert.equal(postActionState.url, initialUrl)
    assert.equal(postActionState.actionCount, 1)
    assert.equal(postActionState.pressed, 'true')
    assert.equal(postActionState.status, 'Added item')
    assert.equal(postActionState.navigationEntries, 1)
    assert.deepEqual(mainNavigations, [fixtureUrl])
    assert.deepEqual(requests, [{
      method: 'GET', path: '/fixture', authenticated: true, cookieHeaderPresent: true,
    }])

    assert.equal(wire.transport.channel, CHANNEL)
    assert.deepEqual(wire.transport.path, ['content-script', 'service-worker', 'extension-page'])
    assert.equal(wire.transport.api, 'chrome.runtime.sendMessage/onMessage')
    assert.equal(wire.receiptIngressCount, 1)
    assert.deepEqual(wire.hostReady, {
      renderedAuthenticatedState: true,
      buyerLocalStatePresent: true,
      checkpointVersion: 2,
      baselineContract: 'snapdom.action-baseline/v1',
    })
    assert.equal(receipt.contract, 'snapdom.action-receipt/v1')
    assert.equal(receipt.version, 1)
    assert.equal(receipt.taskOutcome, 'NOT_ASSESSED')
    assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(receipt.postcondition.outcome))
    assert.equal(receipt.postcondition.outcome, 'PASS')
    assert.equal(receipt.postcondition.kind, 'changed')
    assert.deepEqual(receipt.postcondition.expected, { changed: true })
    assert.equal(receipt.observed.changed, true)
    assert.equal(receipt.observed.torn, 0)
    assert.deepEqual(receipt.limits, { changes: 0, actionability: 0, unobservable: 0 })
    const boundedSurfaces = [
      receipt.observed.changes,
      receipt.observed.actionabilityDelta.becameCovered,
      receipt.observed.actionabilityDelta.becameVisible,
      receipt.observed.unobservable,
    ]
    for (const surface of boundedSurfaces) {
      assert.deepEqual(Object.keys(surface).sort(), ['items', 'total', 'truncated'])
      assert.deepEqual(surface.items, [])
      assert.equal(surface.truncated, surface.total)
    }
    assert.ok(receipt.observed.changes.total >= 2, 'official receipt must retain the hidden effect count')
    assert.ok(receipt.observed.changes.truncated >= 2, 'official receipt must expose evidence truncation')
    assert.equal('checkpoint' in receipt, false)
    assert.equal('nextBaseline' in receipt, false)
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt)
    assert.ok(!receiptWire.includes(COOKIE_SECRET), 'HttpOnly secret leaked into receipt')
    assert.ok(!receiptWire.includes(STORAGE_SECRET), 'localStorage secret leaked into receipt')
    assert.ok(!wireText.includes(COOKIE_SECRET) && !wireText.includes(STORAGE_SECRET), 'secret leaked onto extension wire')

    result = {
      schemaVersion: 1,
      verdict: 'PASS',
      scope: {
      claim: 'In this synthetic buyer fixture, the browser SDK embeds into an existing extension host with an identical manifest permission surface.',
        excludes: [
          'real Chrome or a user profile',
          'real SSO/authentication',
          'production reliability or customer value',
          'Playwright as product runtime',
        ],
      },
      package: {
        name: sdkPackage.name,
        version: sdkPackage.version,
        packedBytes: packed.size,
        unpackedBytes: packed.unpackedSize,
        runtimeDependencies: [],
        bundleBytes: sdkManifest.bytes,
        bundleGzipBytes: sdkManifest.gzipBytes,
        bundleSha256: sdkManifest.sha256,
      },
      integration: {
        buyerFunctionBeforeSnapdom: 'Existing isolated content script recognizes its authenticated workspace.',
        sdkPlacement: 'Bundled into the buyer content script at build time.',
        manifestPermissionDelta: {},
        beforeSurface,
        afterSurface,
        runtimeForbiddenSurfaceMatches: runtimeMatches,
        integratedContentSha256: sha256(readFileSync(join(extensionDir, 'content.js'))),
        transport: wire.transport,
      },
      hermeticFixture: {
        loopback: true,
        osAssignedPort: true,
        forbiddenManualPortUsed: false,
        temporaryChromiumProfile: true,
        personalChromeAccessed: false,
        auth: {
          kind: 'synthetic preseeded fixture state',
          httpOnlyCookieReadableByPage: false,
          localStorageValuePresentBeforeObservation: true,
          navigationOrLoginReplayByExtension: false,
        },
        requests,
      },
      wireEvidence: {
        secretPresent: false,
        receiptIngressCount: wire.receiptIngressCount,
        hostReady: wire.hostReady,
        receipt,
      },
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  if (context) {
    try { await context.close() } catch (error) { cleanupErrors.push(error) }
  }
  if (server) {
    try { await closeServer(server) } catch (error) { cleanupErrors.push(error) }
  }
  try { rmSync(temp, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
  try {
    accessSync(temp, constants.F_OK)
    cleanupErrors.push(new Error(`temporary gate directory still exists: ${temp}`))
  } catch (error) {
    if (error?.code !== 'ENOENT') cleanupErrors.push(error)
  }

  if (cleanupErrors.length) {
    throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'OEM embed gate cleanup failed closed')
  }
  if (primaryError) throw primaryError
  return result
}

const result = await runGate()
if (WRITE_RESULT) {
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`)
}
process.stdout.write(`${JSON.stringify({
  verdict: result.verdict,
  package: result.package,
  permissionDelta: result.integration.manifestPermissionDelta,
  transport: result.integration.transport.api,
  receiptChanged: result.wireEvidence.receipt.observed.changed,
  result: WRITE_RESULT ? relative(ROOT, RESULT_PATH) : null,
}, null, 2)}\n`)
