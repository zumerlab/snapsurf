#!/usr/bin/env node
/**
 * Focal, descriptive comparison of direct Playwright Test assertions and the
 * SnapDOM Agent assertion envelope on public pages.
 *
 * This is not a throughput benchmark. Each arm gets an isolated Chromium context.
 * Schema 2 aligns its timing boundary (precondition/baseline outside; target lookup,
 * action and postconditions inside) and brings the declared effects closer. Observation
 * surfaces, retry boundaries, and evidence contracts still differ, so results remain
 * descriptive and noncausal.
 *
 * Usage:
 *   node experiment/value-focal.mjs --dry
 *   node experiment/value-focal.mjs --network
 *
 * Optional environment:
 *   VALUE_FOCAL_PLAYWRIGHT_ROOT=/tmp/pw-1.62.1-runtime
 *   VALUE_FOCAL_OUTPUT=/tmp/value-focal.json
 *
 * The default direct arm is the repository-pinned Playwright. To run the successor
 * schema-2 protocol with
 * Playwright 1.62.1, install that version OUTSIDE this repo and point
 * VALUE_FOCAL_PLAYWRIGHT_ROOT at its package root. This does NOT reproduce the committed
 * historical schema-1 observation: its timer and `add` predicate were intentionally
 * corrected. Never point either arm at a persistent browser profile.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delayTimer } from 'node:timers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = new Set(process.argv.slice(2))
const unknownArgs = [...args].filter((arg) => !['--dry', '--network'].includes(arg))
if (unknownArgs.length) throw new Error(`unknown argument(s): ${unknownArgs.join(', ')}`)
if (args.has('--dry') === args.has('--network')) {
  throw new Error('choose exactly one mode: --dry or --network')
}

const publicPages = Object.freeze({
  controls: 'https://the-internet.herokuapp.com/dynamic_controls',
  modal: 'https://getbootstrap.com/docs/5.3/components/modal/',
  delayed: 'https://the-internet.herokuapp.com/dynamic_loading/2',
})
const cases = Object.freeze([
  {
    effect: 'remove', page: 'controls', truth: 'The initially visible checkbox is absent and the page reports "It\'s gone!".',
    alignment: 'visible-checkbox precondition outside timing; timed target lookup, action, checkbox transition and final message; PW uses DOM absence while SnapDOM uses disappearance from its semantic snapshot',
  },
  {
    effect: 'add', page: 'controls', truth: 'A visible checkbox is added back and the page reports "It\'s back!".',
    alignment: 'absent-checkbox precondition outside timing; both arms check the checkbox transition and "It\'s back!"',
  },
  {
    effect: 'state-enable', page: 'controls', truth: 'The disabled input becomes enabled and the page reports "It\'s enabled!".',
    alignment: 'disabled-input baseline/precondition outside timing; both arms check the enabled transition and final message',
  },
  {
    effect: 'modal', page: 'modal', truth: 'The live Bootstrap dialog appears and its Woo-hoo paragraph is rendered without geometric occlusion.',
    alignment: 'same four claims; Playwright needs a custom elementFromPoint predicate for occlusion',
  },
  {
    effect: 'delayed', page: 'delayed', truth: 'After Start, Hello World! is rendered after the asynchronous loading phase.',
    alignment: 'same declared effect; both allow up to 10 seconds for target appearance, but their sequential assertion/retry boundaries differ',
  },
  {
    effect: 'no-op', page: 'delayed', truth: 'After the delayed result has settled, a 300 ms wait produces no semantic change.',
    alignment: 'same declared effect but different observation surfaces: Playwright compares body ARIA while SnapDOM also observes supported layout/style/state signals',
  },
])

const methodology = Object.freeze({
  classification: 'focal descriptive comparison; not a throughput benchmark',
  unit: 'one action-to-verdict observation per effect and arm; navigation/runtime installation excluded',
  truth: 'declared visible DOM/ARIA postconditions listed per case; no independent hidden oracle in this focal',
  timing: 'schema 2: setup/baseline/precondition outside timer; target lookup, action and postconditions inside timer; evidence serialization and controlled failure probe outside timer',
  bytes: 'UTF-8 serialized bytes; no token estimates',
  evidence: {
    playwrightSuccess: 'expect() serializes no semantic success evidence; ariaSnapshot() was called explicitly and counted separately',
    playwrightFailure: 'a deliberately wrong, short-timeout expect() captures matcher diagnostics; ariaSnapshot availability is recorded',
    snapdomSuccess: 'the authenticated command envelope includes structured assertion checks and diff evidence',
    snapdomFailure: 'a deliberately absent exists predicate captures the authenticated structured failure envelope',
  },
  comparabilityCaveat: 'Schema 2 aligns timer boundaries and declared effects more closely, but observation surfaces, retry boundaries, implementation/runtime versions, polling, action settling and evidence contracts differ. Latency and byte columns remain observations, not causal rankings.',
})

const dry = {
  schemaVersion: 2,
  mode: 'dry',
  publicPages,
  cases,
  methodology,
  safety: {
    networkRequiresExplicitFlag: true,
    persistentBrowserProfile: false,
    chromiumContext: 'fresh non-persistent context per arm',
    daemonPort: 'OS-assigned; 8377 explicitly rejected',
    temporaryState: 'mkdtemp plus finally cleanup',
  },
}
if (args.has('--dry')) {
  process.stdout.write(JSON.stringify(dry, null, 2) + '\n')
  process.exit(0)
}

let tmp = null
const outputPath = process.env.VALUE_FOCAL_OUTPUT
const delay = (ms) => new Promise((resolveDelay) => delayTimer(resolveDelay, ms))
const byteLength = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
const elapsed = (start) => Math.round((performance.now() - start) * 10) / 10
const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const packageVersion = packageJson.version
const snapdomPlaywrightVersion = packageJson.dependencies.playwright
const snapdomBrowsers = JSON.parse(await readFile(join(ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'))
const snapdomChromium = snapdomBrowsers.browsers.find((browser) => browser.name === 'chromium')
const directRoot = resolve(process.env.VALUE_FOCAL_PLAYWRIGHT_ROOT || ROOT)
const directPackage = JSON.parse(await readFile(join(directRoot, 'node_modules', 'playwright', 'package.json'), 'utf8'))
const directPlaywrightVersion = directPackage.version
const { chromium } = await import(pathToFileURL(join(directRoot, 'node_modules', 'playwright', 'index.mjs')).href)
const { expect } = await import(pathToFileURL(join(directRoot, 'node_modules', 'playwright', 'test.mjs')).href)

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  if (port === 8377) throw new Error('OS assigned forbidden shared development port 8377; rerun the experiment')
  return port
}

async function failureDiagnostic(run) {
  try {
    await run()
    return { bytes: 0, unexpectedPass: true, hasAriaSnapshot: false }
  } catch (error) {
    const payload = { name: error?.name, message: error?.message, matcherResult: error?.matcherResult }
    return {
      bytes: byteLength(payload),
      hasAriaSnapshot: typeof error?.matcherResult?.ariaSnapshot === 'string',
      firstLine: String(error?.message || error).split('\n')[0],
    }
  }
}

async function directPlaywrightArm() {
  let browser
  let context
  const results = []
  const record = async ({
    effect, outcomeLocators, preconditionAssertions = 1, timedAssertions,
    targetLookupCalls = 1, customPredicates = 0,
    setupApi, timedApi, evidenceApi, setup, run, evidence, fail,
  }) => {
    const setupStarted = performance.now()
    await setup()
    const setupMs = elapsed(setupStarted)
    const started = performance.now()
    await run()
    const latencyMs = elapsed(started)
    const aria = await evidence()
    const diagnostic = await failureDiagnostic(fail)
    if (diagnostic.unexpectedPass) throw new Error(`controlled Playwright failure probe unexpectedly passed for ${effect}`)
    results.push({
      effect, verdict: 'pass', setupApi, timedApi, evidenceApi, outcomeLocators,
      preconditionAssertions, targetLookupCalls, timedAssertions, customPredicates,
      setupMs, explicitEvidenceCalls: 1, latencyMs, automaticSuccessEvidenceBytes: 0,
      explicitAriaEvidenceBytes: byteLength({ aria }),
      failureDiagnosticBytes: diagnostic.bytes,
      failureHasAriaSnapshot: diagnostic.hasAriaSnapshot,
      failureFirstLine: diagnostic.firstLine,
    })
  }
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(publicPages.controls, { waitUntil: 'domcontentloaded' })
    let checkbox = page.locator('#checkbox')
    let button = page.locator('#checkbox-example button')
    let message = page.locator('#checkbox-example #message')
    await record({
      effect: 'remove', outcomeLocators: 3, timedAssertions: 2,
      setupApi: ["expect(page.locator('#checkbox')).toBeVisible()"],
      timedApi: ["page.locator('#checkbox-example button').waitFor({state:'visible'})", "button.click()", "expect(page.locator('#checkbox')).toHaveCount(0)", "expect(page.locator('#checkbox-example #message')).toHaveText(\"It's gone!\")"],
      evidenceApi: ["page.locator('#checkbox-example').ariaSnapshot()"],
      setup: () => expect(checkbox).toBeVisible(),
      run: async () => { await button.waitFor({ state: 'visible' }); await button.click(); await expect(checkbox).toHaveCount(0); await expect(message).toHaveText("It's gone!") },
      evidence: () => page.locator('#checkbox-example').ariaSnapshot(),
      fail: () => expect(checkbox).toBeVisible({ timeout: 150 }),
    })
    checkbox = page.locator('#checkbox')
    button = page.locator('#checkbox-example button')
    message = page.locator('#checkbox-example #message')
    await record({
      effect: 'add', outcomeLocators: 3, timedAssertions: 2,
      setupApi: ["expect(page.locator('#checkbox')).toHaveCount(0)"],
      timedApi: ["page.locator('#checkbox-example button').waitFor({state:'visible'})", "button.click()", "expect(page.locator('#checkbox')).toBeVisible()", "expect(page.locator('#checkbox-example #message')).toHaveText(\"It's back!\")"],
      evidenceApi: ["page.locator('#checkbox-example').ariaSnapshot()"],
      setup: () => expect(checkbox).toHaveCount(0),
      run: async () => { await button.waitFor({ state: 'visible' }); await button.click(); await expect(checkbox).toBeVisible(); await expect(message).toHaveText("It's back!") },
      evidence: () => page.locator('#checkbox-example').ariaSnapshot(),
      fail: () => expect(checkbox).toHaveCount(0, { timeout: 150 }),
    })
    const input = page.locator('#input-example input')
    const enable = page.locator('#input-example button')
    const inputMessage = page.locator('#input-example #message')
    await record({
      effect: 'state-enable', outcomeLocators: 3, timedAssertions: 2,
      setupApi: ["expect(page.locator('#input-example input')).toBeDisabled()"],
      timedApi: ["page.locator('#input-example button').waitFor({state:'visible'})", "enable.click()", "expect(page.locator('#input-example input')).toBeEnabled()", "expect(page.locator('#input-example #message')).toHaveText(\"It's enabled!\")"],
      evidenceApi: ["page.locator('#input-example').ariaSnapshot()"],
      setup: () => expect(input).toBeDisabled(),
      run: async () => { await enable.waitFor({ state: 'visible' }); await enable.click(); await expect(input).toBeEnabled(); await expect(inputMessage).toHaveText("It's enabled!") },
      evidence: () => page.locator('#input-example').ariaSnapshot(),
      fail: () => expect(input).toBeDisabled({ timeout: 150 }),
    })

    await page.goto(publicPages.modal, { waitUntil: 'domcontentloaded' })
    const launch = page.getByRole('button', { name: 'Launch demo modal', exact: true }).first()
    const dialog = page.locator('#exampleModalLive')
    const modalText = 'Woo-hoo, you’re reading this text in a modal!'
    const paragraph = dialog.getByText(modalText, { exact: true })
    await record({
      effect: 'modal', outcomeLocators: 3, timedAssertions: 3, customPredicates: 1,
      setupApi: ["expect(page.locator('#exampleModalLive')).toBeHidden()"],
      timedApi: ["page.getByRole('button',{name:'Launch demo modal',exact:true}).first().waitFor({state:'visible'})", 'launch.click()', 'expect(dialog).toBeVisible()', 'expect(paragraph).toBeVisible()', 'paragraph.evaluate(elementFromPoint centre containment)', 'expect(clear).toBe(true)'],
      evidenceApi: ['dialog.ariaSnapshot()'],
      setup: () => expect(dialog).toBeHidden(),
      run: async () => {
        await launch.waitFor({ state: 'visible' }); await launch.click(); await expect(dialog).toBeVisible(); await expect(paragraph).toBeVisible()
        const clear = await paragraph.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return !!hit && (hit === element || element.contains(hit) || hit.contains(element))
        })
        expect(clear).toBe(true)
      },
      evidence: () => dialog.ariaSnapshot(),
      fail: () => expect(dialog).toBeHidden({ timeout: 150 }),
    })

    await page.goto(publicPages.delayed, { waitUntil: 'domcontentloaded' })
    const start = page.getByRole('button', { name: 'Start' })
    const finish = page.locator('#finish')
    await record({
      effect: 'delayed', outcomeLocators: 2, timedAssertions: 2,
      setupApi: ["expect(page.locator('#finish')).toBeHidden()"],
      timedApi: ["page.getByRole('button',{name:'Start'}).waitFor({state:'visible'})", 'start.click()', "expect(page.locator('#finish')).toBeVisible({timeout:10000})", "expect(page.locator('#finish')).toHaveText('Hello World!')"],
      evidenceApi: ["page.locator('#finish').ariaSnapshot()"],
      setup: () => expect(finish).toBeHidden(),
      run: async () => { await start.waitFor({ state: 'visible' }); await start.click(); await expect(finish).toBeVisible({ timeout: 10_000 }); await expect(finish).toHaveText('Hello World!') },
      evidence: () => finish.ariaSnapshot(),
      fail: () => expect(finish).toBeHidden({ timeout: 150 }),
    })
    const body = page.locator('body')
    let before = ''
    let after = ''
    await record({
      effect: 'no-op', outcomeLocators: 1, preconditionAssertions: 0,
      targetLookupCalls: 0, timedAssertions: 1,
      setupApi: ["before=await page.locator('body').ariaSnapshot()"],
      timedApi: ['wait 300ms', "after=await page.locator('body').ariaSnapshot()", 'expect(after).toBe(before)'],
      evidenceApi: ['serialize {before,after}'],
      setup: async () => { before = await body.ariaSnapshot() },
      run: async () => { await delay(300); after = await body.ariaSnapshot(); expect(after).toBe(before) },
      evidence: async () => JSON.stringify({ before, after }),
      fail: () => expect(body).toContainText('__intentional_missing_text__', { timeout: 150 }),
    })
    return { browserVersion: browser.version(), results }
  } finally {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}

const hmac = (token, value) => createHmac('sha256', token).update(value).digest('hex')
const safeEqual = (actual, expected) => {
  const a = Buffer.from(String(actual || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

async function snapdomArm() {
  const port = await freePort()
  const token = randomBytes(32).toString('hex')
  const logDir = join(tmp, 'snapdom-logs')
  const tokenFile = join(tmp, 'snapdom.token')
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  const daemonEnv = {
    ...process.env,
    SNAPDOM_AGENT_PORT: String(port), SNAPDOM_AGENT_LOGDIR: logDir,
    SNAPDOM_AGENT_TOKEN: token, SNAPDOM_AGENT_TOKEN_FILE: tokenFile,
  }
  // A caller may run the direct arm from a different Playwright browser store.
  // The product arm must retain its own pinned runtime and empty transient profile.
  delete daemonEnv.PLAYWRIGHT_BROWSERS_PATH
  const daemon = spawn(process.execPath, [join(ROOT, 'tools', 'browse.mjs'), 'serve'], {
    cwd: ROOT, env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let daemonOutput = ''
  daemon.stdout.on('data', (chunk) => { daemonOutput += chunk })
  daemon.stderr.on('data', (chunk) => { daemonOutput += chunk })
  const post = async (cmd, commandArgs = [], extra = {}) => {
    const body = JSON.stringify({ cmd, args: commandArgs, envelope: true, ...extra })
    const nonce = randomBytes(16).toString('hex')
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-snapdom-nonce': nonce, 'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`) },
      body,
    })
    const text = await response.text()
    if (!safeEqual(response.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${text}`))) throw new Error('unauthenticated SnapDOM response')
    return { value: JSON.parse(text), text, bytes: byteLength(text) }
  }
  const findButton = async (name) => {
    const result = await post('find', [name])
    const match = result.value.meta.matches.find((entry) => entry.role === 'button' && entry.name === name)
    if (!match) throw new Error(`SnapDOM button not found: ${name}`)
    return match.id
  }
  const requireMatch = async (query, predicate, expected, label) => {
    const found = await post('find', [query])
    const matched = (found.value.meta.matches || []).some(predicate)
    if (matched !== expected) throw new Error(`SnapDOM precondition failed: ${label}`)
  }
  const requireOutline = async (pattern, label) => {
    const outlined = await post('outline')
    if (!pattern.test(String(outlined.value.meta.outline || ''))) throw new Error(`SnapDOM precondition failed: ${label}`)
  }
  const assertEffect = async ({
    effect, button, spec, timedChecks, setupApi, timedApi,
    preconditionChecks = 1, setup = async () => {}, delayBefore = 0,
  }) => {
    const setupStarted = performance.now()
    await setup()
    const setupMs = elapsed(setupStarted)
    const started = performance.now()
    const id = button ? await findButton(button) : null
    if (id) {
      const acted = await post('click', [id])
      if (!acted.value.ok) throw new Error(acted.value.error || acted.value.text)
    }
    if (delayBefore) await delay(delayBefore)
    const verdict = await post('assert', [JSON.stringify(spec)])
    const latencyMs = elapsed(started)
    const failed = await post('assert', [JSON.stringify({ exists: '__intentional_missing_text__', keepBaseline: true })])
    if (failed.value.meta?.assert?.pass !== false) throw new Error(`controlled SnapDOM failure probe unexpectedly passed for ${effect}`)
    return {
      effect, verdict: verdict.value.meta.assert.pass ? 'pass' : 'fail', setupApi, timedApi,
      preconditionChecks, targetLookupCalls: button ? 1 : 0, assertCalls: 1,
      timedChecks, setupMs, latencyMs,
      fullEnvelopeBytes: verdict.bytes, structuredAssertBytes: byteLength(verdict.value.meta.assert),
      failureEnvelopeBytes: failed.bytes, attempts: verdict.value.meta.assert.attempts,
      actualChecks: verdict.value.meta.assert.checks,
    }
  }
  const results = []
  try {
    const deadline = Date.now() + 30_000
    for (;;) {
      try { const status = await post('status', [], { internal: true }); if (status.value.ok) break } catch { /* starting */ }
      if (daemon.exitCode !== null) throw new Error(`SnapDOM daemon exited\n${daemonOutput}`)
      if (Date.now() > deadline) throw new Error(`SnapDOM daemon timeout\n${daemonOutput}`)
      await delay(100)
    }
    let opened = await post('open', [publicPages.controls])
    if (!opened.value.ok) throw new Error(opened.value.error || opened.value.text)
    results.push(await assertEffect({
      effect: 'remove', button: 'Remove', timedChecks: 3,
      setupApi: ['find checkbox by exact role; require a match (outside timer)'],
      timedApi: ['find Remove', 'click returned id', 'assert changed + removed checkbox + exists "It\'s gone!"'],
      setup: () => requireMatch('checkbox', (entry) => entry.role === 'checkbox', true, 'checkbox initially present'),
      spec: { changed: true, mustInclude: [{ kind: 'removed', role: 'checkbox' }], exists: "It's gone!", retry: { budgetMs: 6500, intervalMs: 100 } },
    }))
    results.push(await assertEffect({
      effect: 'add', button: 'Add', timedChecks: 3,
      setupApi: ['find checkbox by exact role; require no match (outside timer)'],
      timedApi: ['find Add', 'click returned id', 'assert changed + added checkbox + exists "It\'s back!"'],
      setup: () => requireMatch('checkbox', (entry) => entry.role === 'checkbox', false, 'checkbox initially absent'),
      spec: { changed: true, mustInclude: [{ kind: 'added', role: 'checkbox' }], exists: "It's back!", retry: { budgetMs: 6500, intervalMs: 100 } },
    }))
    results.push(await assertEffect({
      effect: 'state-enable', button: 'Enable', timedChecks: 3,
      setupApi: ['outline; require input[textbox] state {disabled} (outside timer)'],
      timedApi: ['find Enable', 'click returned id', 'assert changed + textbox state to disabled:false + exists "It\'s enabled!"'],
      setup: () => requireOutline(/input\[textbox\].*\{[^}]*disabled[^}]*\}/, 'textbox initially disabled'),
      spec: { changed: true, mustInclude: [{ kind: 'state', role: 'textbox', to: { disabled: false } }], exists: "It's enabled!", retry: { budgetMs: 6500, intervalMs: 100 } },
    }))
    opened = await post('open', [publicPages.modal])
    if (!opened.value.ok) throw new Error(opened.value.error || opened.value.text)
    const modalText = 'Woo-hoo, you’re reading this text in a modal!'
    results.push(await assertEffect({
      effect: 'modal', button: 'Launch demo modal', timedChecks: 4,
      setupApi: ['find dialog; require no rendered dialog match (outside timer)'],
      timedApi: ['find Launch demo modal', 'click returned id', 'assert changed + added dialog + exists modal text + notCovered modal text'],
      setup: () => requireMatch('dialog', (entry) => entry.role === 'dialog', false, 'live dialog initially hidden'),
      spec: { changed: true, mustInclude: [{ kind: 'added', role: 'dialog' }], exists: modalText, notCovered: modalText, retry: { budgetMs: 5000, intervalMs: 100 } },
    }))
    opened = await post('open', [publicPages.delayed])
    if (!opened.value.ok) throw new Error(opened.value.error || opened.value.text)
    results.push(await assertEffect({
      effect: 'delayed', button: 'Start', timedChecks: 3,
      setupApi: ['find Hello World!; require no rendered match (outside timer)'],
      timedApi: ['find Start', 'click returned id', 'assert changed + added Hello World! + exists Hello World!'],
      setup: () => requireMatch('Hello World!', () => true, false, 'delayed result initially absent'),
      spec: { changed: true, mustInclude: [{ kind: 'added', name: 'Hello World!' }], exists: 'Hello World!', retry: { budgetMs: 10_000, intervalMs: 100 } },
    }))
    results.push(await assertEffect({
      effect: 'no-op', timedChecks: 1, preconditionChecks: 0,
      setupApi: ['reuse the settled baseline consumed after delayed assertion'],
      timedApi: ['wait 300ms', 'assert changed:false'],
      delayBefore: 300, spec: { changed: false },
    }))
    return { portPolicy: 'OS-assigned and not 8377', results }
  } finally {
    try { await post('stop') } catch { /* daemon already gone */ }
    const exited = await Promise.race([new Promise((resolveExit) => daemon.once('exit', () => resolveExit(true))), delay(5000).then(() => false)])
    if (!exited && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      const terminated = await Promise.race([new Promise((resolveExit) => daemon.once('exit', () => resolveExit(true))), delay(3000).then(() => false)])
      if (!terminated && daemon.exitCode === null) daemon.kill('SIGKILL')
    }
  }
}

let result
try {
  tmp = await mkdtemp(join(tmpdir(), 'snapdom-value-focal-'))
  const started = new Date().toISOString()
  const playwright = await directPlaywrightArm()
  const snapdom = await snapdomArm()
  result = {
    schemaVersion: 2, mode: 'network', started, finished: new Date().toISOString(),
    runClassification: 'single-run focal observation', publicPages, methodology, cases,
    versions: {
      node: process.version,
      directPlaywright: directPlaywrightVersion,
      directChromium: playwright.browserVersion,
      snapdomAgent: packageVersion,
      snapdomInternalPlaywright: snapdomPlaywrightVersion,
      snapdomExpectedChromium: snapdomChromium ? `${snapdomChromium.browserVersion} (revision ${snapdomChromium.revision}, from pinned browsers.json)` : 'unknown',
    },
    isolation: { directArm: 'chromium.launch + fresh browser.newContext; no userDataDir', snapdomArm: 'product daemon chromium.launch + fresh contexts; no userDataDir', temporaryRoot: 'mkdtemp (path omitted from result)', daemonPort: 'OS-assigned and explicitly not 8377', cleanup: 'finally closes contexts/processes and removes temporary root' },
    arms: { playwrightTestDirect: playwright.results, snapdomAuthenticatedDaemon: snapdom },
  }
  if (result.arms.playwrightTestDirect.some((row) => row.verdict !== 'pass') || result.arms.snapdomAuthenticatedDaemon.results.some((row) => row.verdict !== 'pass')) process.exitCode = 1
  const serialized = JSON.stringify(result, null, 2) + '\n'
  if (outputPath) await writeFile(resolve(outputPath), serialized)
  process.stdout.write(serialized)
} finally {
  if (tmp) await rm(tmp, { recursive: true, force: true })
}
