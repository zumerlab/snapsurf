#!/usr/bin/env node
/**
 * Hermetic MCP-to-MCP value probe.
 *
 * This is intentionally narrower than an agent benchmark: there is no model. It asks
 * which frozen postconditions the current MCP surfaces can express directly, through
 * their automatic snapshots, or only through arbitrary page JavaScript. Every browser
 * is headless and isolated; the fixture and frozen truth manifest are local; no persistent
 * browser profile, extension, CDP endpoint, storage state, or personal browser is used.
 *
 * Usage:
 *   node experiment/mcp-value.mjs --dry
 *   MCP_VALUE_OUTPUT=experiment/results/mcp-value.json \
 *     node experiment/mcp-value.mjs --run
 *   MCP_VALUE_OUTPUT=experiment/results/mcp-value.json \
 *     node experiment/mcp-value.mjs --report-existing
 *
 * Optional:
 *   MCP_VALUE_REPETITIONS=3
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL, URLSearchParams } from 'node:url'
import { performance } from 'node:perf_hooks'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.79'
const PLAYWRIGHT_MCP_SERVER_VERSION = '1.63.0-alpha-2026-08-05'
const FIXTURE_VERSION = 1
const VARIANTS = ['correct', 'near-miss']
const CASES = Object.freeze([
  {
    id: 'checkbox-target',
    postcondition: 'Target todo is checked and Neighbor todo remains unchecked.',
    nearMiss: 'Neighbor todo is checked instead of Target todo.',
  },
  {
    id: 'add-exact-item',
    postcondition: 'Requested alpha is visible and Distractor beta is absent.',
    nearMiss: 'Distractor beta is added instead of Requested alpha.',
  },
  {
    id: 'modal-actionable',
    postcondition: 'Verification modal is visible and Close modal is not covered.',
    nearMiss: 'The dialog is visible, but an overlay intercepts Close modal.',
  },
  {
    id: 'semantic-no-op',
    postcondition: 'The action produces no observable semantic UI change.',
    nearMiss: 'An unrelated status text changes.',
  },
])

const PROTOCOL = Object.freeze({
  classification: 'local deterministic MCP capability and protocol-cost probe; no model',
  unit: 'one fresh fixture navigation, one action, and one verifier verdict',
  variants: 'each case runs once as the intended effect and once as a deterministic near miss per repetition',
  truth: 'a frozen server-side expected-truth manifest: the page sends only an action ping; the server computes the expected state from runId/case/variant outside either MCP connection and does not observe the DOM',
  verdicts: ['PASS', 'FAIL', 'UNKNOWN'],
  equalIntent: 'the same frozen postcondition is evaluated in every arm; a failed conjunct may short-circuit',
  routes: {
    playwrightOutOfBox: 'testing verify tools, a non-mutating built-in actionability probe, or mechanical comparison of the automatic action snapshot; route is recorded per case',
    playwrightCustom: 'browser_evaluate page JavaScript; an explicit custom escape hatch, never credited as a direct verifier',
    snapdomDirect: 'one browser_assert request over the before/after baseline',
  },
  metrics: 'exact UTF-8 JSON-RPC request and matching response bytes, linked snapshot-artifact bytes reported separately and in an effective total, MCP rounds, and wall time; no byte-to-token estimate',
  timing: 'verification-only timing excludes navigation, setup, action, npm install/startup, and expected-truth polling; full-flow timing includes setup, action, verification, and linked-artifact reads but still excludes install/startup and truth polling',
  safety: 'local HTTP only; headless isolated Chromium; temporary install/output/log/token state; OS-assigned ports excluding 8377; no personal Chrome state',
})

const args = new Set(process.argv.slice(2))
const modes = ['--dry', '--run', '--report-existing'].filter((mode) => args.has(mode))
if (args.size !== 1 || modes.length !== 1) {
  throw new Error('choose exactly one mode: --dry, --run, or --report-existing')
}
const repetitions = Number(process.env.MCP_VALUE_REPETITIONS || 3)
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error('MCP_VALUE_REPETITIONS must be an integer from 1 to 20')
}

const fixtureSourceFingerprint = createHash('sha256')
  .update(String(FIXTURE_VERSION))
  .update(JSON.stringify(CASES))
  .update(fixtureMarkup.toString())
  .digest('hex')

const dry = {
  schemaVersion: 1,
  mode: 'dry',
  protocol: PROTOCOL,
  pinned: {
    playwrightMcpPackage: PLAYWRIGHT_MCP_PACKAGE,
    expectedServerVersion: PLAYWRIGHT_MCP_SERVER_VERSION,
    snapdomPackage: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
  },
  fixture: { version: FIXTURE_VERSION, sha256: fixtureSourceFingerprint, cases: CASES },
  repetitions,
}
if (args.has('--dry')) {
  process.stdout.write(`${JSON.stringify(dry, null, 2)}\n`)
  process.exit(0)
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const bytes = (wire) => Buffer.byteLength(wire)
const roundedMs = (value) => Math.round(value * 10) / 10
const sha256Files = async (paths) => {
  const hash = createHash('sha256')
  for (const path of paths) hash.update(await readFile(path))
  return hash.digest('hex')
}

function fixtureMarkup(testCase, variant, runId) {
  const config = JSON.stringify({ testCase, variant, runId })
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MCP value fixture</title>
  <style>
    body { font: 16px/1.4 system-ui, sans-serif; margin: 32px; color: #161616; }
    button, input { font: inherit; }
    #run { margin-bottom: 20px; }
    #dialog[hidden], #cover[hidden] { display: none; }
    #dialog { position: fixed; z-index: 10; left: 120px; top: 120px; width: 360px;
      min-height: 180px; padding: 24px; background: white; border: 2px solid #222; }
    #close { position: absolute; right: 24px; bottom: 20px; }
    #cover { position: fixed; z-index: 30; background: rgba(180, 20, 20, .22); pointer-events: auto; }
  </style>
</head>
<body>
  <main>
    <h1>Deterministic MCP fixture</h1>
    <button id="run" type="button">Run requested action</button>
    <section id="checkbox-case" hidden>
      <label><input id="target" type="checkbox"> Target todo</label>
      <label><input id="neighbor" type="checkbox"> Neighbor todo</label>
    </section>
    <section id="add-case" hidden>
      <ul id="items" aria-label="Items"></ul>
    </section>
    <section id="modal-case" hidden>
      <p>Modal launcher ready</p>
    </section>
    <section id="noop-case" hidden>
      <p id="status">Idle</p>
    </section>
  </main>
  <div id="dialog" role="dialog" aria-label="Verification modal" hidden>
    <h2>Verification modal</h2>
    <p>The modal is open.</p>
    <button id="close" type="button" aria-label="Close modal">Close modal</button>
  </div>
  <div id="cover" aria-label="Blocking overlay" hidden></div>
  <script>
    const config = ${config}
    const byId = id => document.getElementById(id)
    const sections = {
      'checkbox-target': 'checkbox-case',
      'add-exact-item': 'add-case',
      'modal-actionable': 'modal-case',
      'semantic-no-op': 'noop-case',
    }
    byId(sections[config.testCase]).hidden = false
    async function reportAction() {
      await fetch('/oracle/' + encodeURIComponent(config.runId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    }
    byId('run').addEventListener('click', async () => {
      if (config.testCase === 'checkbox-target') {
        byId(config.variant === 'correct' ? 'target' : 'neighbor').checked = true
      } else if (config.testCase === 'add-exact-item') {
        const text = config.variant === 'correct' ? 'Requested alpha' : 'Distractor beta'
        const item = document.createElement('li')
        item.textContent = text
        byId('items').appendChild(item)
      } else if (config.testCase === 'modal-actionable') {
        byId('dialog').hidden = false
        if (config.variant === 'near-miss') {
          const rect = byId('close').getBoundingClientRect()
          const cover = byId('cover')
          cover.style.left = (rect.left - 4) + 'px'
          cover.style.top = (rect.top - 4) + 'px'
          cover.style.width = (rect.width + 8) + 'px'
          cover.style.height = (rect.height + 8) + 'px'
          cover.hidden = false
        }
      } else if (config.testCase === 'semantic-no-op' && config.variant === 'near-miss') {
        byId('status').textContent = 'Unexpected mutation'
      }
      await reportAction()
    })
    if (config.testCase === 'semantic-no-op') queueMicrotask(() => byId('run').focus())
  </script>
</body>
</html>`
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not publish a TCP port')
  if (address.port === 8377) throw new Error('OS assigned forbidden shared port 8377; rerun')
  return address.port
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

async function reservePort() {
  const server = createServer()
  const port = await listen(server)
  await closeServer(server)
  return port
}

async function isPortClosed(port) {
  return await new Promise((resolveClosed) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); resolveClosed(false) }, 500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveClosed(false) })
    socket.once('error', () => { clearTimeout(timer); resolveClosed(true) })
  })
}

function createFixture() {
  const oracle = new Map()
  const manifest = new Map()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/fixture') {
      const testCase = url.searchParams.get('case')
      const variant = url.searchParams.get('variant')
      const runId = url.searchParams.get('run')
      if (!CASES.some((entry) => entry.id === testCase) || !VARIANTS.includes(variant) || !runId) {
        response.writeHead(400).end('invalid fixture request')
        return
      }
      manifest.set(runId, { testCase, variant })
      oracle.set(runId, frozenOracleState(testCase, variant, 0))
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(fixtureMarkup(testCase, variant, runId))
      return
    }
    const match = url.pathname.match(/^\/oracle\/([A-Za-z0-9_-]+)$/)
    if (request.method === 'POST' && match) {
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) body += chunk
      if (bytes(body) > 16_384) {
        response.writeHead(413).end('too large')
        return
      }
      try {
        JSON.parse(body)
        const frozen = manifest.get(match[1])
        if (!frozen) throw new Error('unknown run')
        oracle.set(match[1], frozenOracleState(frozen.testCase, frozen.variant, 1))
        response.setHeader('content-type', 'application/json')
        response.end('{"ok":true}')
      } catch {
        response.writeHead(400).end('invalid json')
      }
      return
    }
    response.writeHead(404).end('not found')
  })
  return { server, oracle }
}

function frozenOracleState(testCase, variant, actionCount) {
  const acted = actionCount === 1
  return {
    testCase,
    variant,
    actionCount,
    targetChecked: acted && testCase === 'checkbox-target' && variant === 'correct',
    neighborChecked: acted && testCase === 'checkbox-target' && variant === 'near-miss',
    items: acted && testCase === 'add-exact-item'
      ? [variant === 'correct' ? 'Requested alpha' : 'Distractor beta']
      : [],
    dialogVisible: acted && testCase === 'modal-actionable',
    closeCovered: acted && testCase === 'modal-actionable' && variant === 'near-miss',
    status: acted && testCase === 'semantic-no-op' && variant === 'near-miss' ? 'Unexpected mutation' : 'Idle',
    mutationCount: acted && testCase === 'semantic-no-op' && variant === 'near-miss' ? 1 : 0,
  }
}

async function waitForOracle(oracle, runId) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = oracle.get(runId)
    if (value?.actionCount === 1) return value
    await delay(20)
  }
  return null
}

function oracleVerdict(testCase, state) {
  if (!state) return 'UNKNOWN'
  if (testCase === 'checkbox-target') return state.targetChecked === true && state.neighborChecked === false ? 'PASS' : 'FAIL'
  if (testCase === 'add-exact-item') return state.items.includes('Requested alpha') && !state.items.includes('Distractor beta') ? 'PASS' : 'FAIL'
  if (testCase === 'modal-actionable') return state.dialogVisible === true && state.closeCovered === false ? 'PASS' : 'FAIL'
  if (testCase === 'semantic-no-op') return state.status === 'Idle' && state.mutationCount === 0 ? 'PASS' : 'FAIL'
  return 'UNKNOWN'
}

class McpClient {
  constructor({ name, command, commandArgs, cwd, env }) {
    this.name = name
    this.cwd = cwd
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.stderr = ''
    this.closed = false
    this.child = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.child.once('error', (error) => this.rejectAll(error))
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal }
      if (!this.closed) this.rejectAll(new Error(`${this.name} exited early (${code ?? signal})\n${this.stderr}`))
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.onLine(line))
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  onLine(line) {
    const responseWire = `${line}\n`
    let message
    try { message = JSON.parse(line) } catch {
      this.notifications.push({ invalidJson: line, responseBytes: bytes(responseWire) })
      return
    }
    if (message.id === undefined || !this.pending.has(message.id)) {
      this.notifications.push({ message, responseBytes: bytes(responseWire) })
      return
    }
    const entry = this.pending.get(message.id)
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve({
      method: entry.method,
      phase: entry.phase,
      requestWire: entry.requestWire,
      responseWire,
      requestBytes: bytes(entry.requestWire),
      responseBytes: bytes(responseWire),
      elapsedMs: roundedMs(performance.now() - entry.started),
      message,
    })
  }

  request(method, params = {}, phase = 'setup', timeoutMs = 20_000) {
    const id = this.nextId++
    const requestWire = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    const started = performance.now()
    const promise = new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} timeout waiting for ${method}; stderr=${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method, phase, requestWire, started })
    })
    this.child.stdin.write(requestWire)
    return promise
  }

  notify(method, params = {}) {
    const wire = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
    this.child.stdin.write(wire)
    return { method, wire, bytes: bytes(wire) }
  }

  async initialize() {
    const initialize = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'snapdom-mcp-value-probe', version: '1.0.0' },
    }, 'schema')
    const initialized = this.notify('notifications/initialized')
    const tools = await this.request('tools/list', {}, 'schema')
    this.handshake = { initialize, initialized, tools }
    return this.handshake
  }

  async callTool(name, toolArguments = {}, phase = 'verification', timeoutMs = 20_000) {
    const operation = await this.request('tools/call', { name, arguments: toolArguments }, phase, timeoutMs)
    operation.tool = name
    operation.toolArguments = toolArguments
    operation.result = operation.message.result
    operation.isError = !!operation.message.error || operation.message.result?.isError === true
    if (this.playwrightArtifactRoot) await attachPlaywrightSnapshotArtifact(operation, this)
    return operation
  }

  async close({ closeBrowser = false } = {}) {
    if (this.closed) return this.exit
    if (closeBrowser) {
      try { await this.callTool('browser_close', {}, 'cleanup', 5_000) } catch { /* stdin shutdown remains authoritative */ }
    }
    this.closed = true
    this.child.stdin.end()
    const exited = await Promise.race([
      new Promise((resolveExit) => this.child.once('exit', () => resolveExit(true))),
      delay(3_000).then(() => false),
    ])
    if (!exited && this.child.exitCode === null) {
      this.child.kill('SIGTERM')
      const terminated = await Promise.race([
        new Promise((resolveExit) => this.child.once('exit', () => resolveExit(true))),
        delay(2_000).then(() => false),
      ])
      if (!terminated && this.child.exitCode === null) this.child.kill('SIGKILL')
    }
    if (!this.exit) await new Promise((resolveExit) => this.child.once('exit', resolveExit))
    return this.exit
  }
}

function sanitizedEnvironment(overrides = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_') || key === 'PW_TEST_CONNECT_WS_ENDPOINT') delete env[key]
  }
  return { ...env, ...overrides }
}

function textResult(operation) {
  return (operation.result?.content || [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n')
}

function playwrightResultSection(operation) {
  const match = textResult(operation).match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)
  return match ? match[1] : null
}

async function attachPlaywrightSnapshotArtifact(operation, client) {
  const match = textResult(operation).match(/### Snapshot\s*\n- \[Snapshot\]\(([^)\r\n]+)\)/)
  if (!match) return
  const started = performance.now()
  const link = match[1]
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || isAbsolute(link)) {
    throw new Error(`Playwright snapshot link is not a workspace-relative artifact: ${link}`)
  }
  const root = await realpath(client.playwrightArtifactRoot)
  const candidate = await realpath(resolve(client.cwd, link))
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Playwright snapshot escaped its temporary artifact root: ${link}`)
  }
  const info = await stat(candidate)
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error(`Playwright snapshot artifact is not a bounded regular file: ${link}`)
  }
  const content = await readFile(candidate, 'utf8')
  operation.artifacts = [{
    kind: 'playwright-aria-snapshot',
    relativePath: join('.playwright-mcp', rel),
    bytes: bytes(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  }]
  operation.artifactReadMs = roundedMs(performance.now() - started)
}

function rawPlaywrightSnapshot(operation) {
  const artifact = operation.artifacts?.find((entry) => entry.kind === 'playwright-aria-snapshot')
  if (artifact) return artifact.content
  const text = textResult(operation)
  const matches = [...text.matchAll(/### (?:Page )?Snapshot:\s*```yaml\s*([\s\S]*?)\s*```/g)]
  return matches.length ? matches.at(-1)[1] : null
}

function extractPlaywrightSnapshot(operation) {
  const snapshot = rawPlaywrightSnapshot(operation)
  if (snapshot === null) return null
  return snapshot
    .replace(/\[ref=[^\]]+\]/g, '[ref]')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

function playwrightRef(operation, { role, name }) {
  const original = rawPlaywrightSnapshot(operation)
  if (original === null) throw new Error(`Playwright response has no readable snapshot for ${role} ${name}\n${textResult(operation).slice(0, 5000)}`)
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*- ${role} "${escapedName}"(?:[^\\n]*)\\[ref=([^\\]]+)\\]`, 'm')
  const match = original.match(pattern)
  if (!match) throw new Error(`Playwright snapshot ref not found for ${role} ${name}\n${original.slice(0, 2000)}`)
  return match[1]
}

function operationTotals(operations) {
  return operations.reduce((total, operation) => ({
    rounds: total.rounds + 1,
    requestBytes: total.requestBytes + operation.requestBytes,
    responseBytes: total.responseBytes + operation.responseBytes,
    artifactBytes: total.artifactBytes + (operation.artifacts || []).reduce((sum, artifact) => sum + artifact.bytes, 0),
    wallMs: roundedMs(total.wallMs + operation.elapsedMs + (operation.artifactReadMs || 0)),
  }), { rounds: 0, requestBytes: 0, responseBytes: 0, artifactBytes: 0, wallMs: 0 })
}

function correctness(verdict, truth) {
  return verdict !== 'UNKNOWN' && verdict === truth
}

function expectedTruth(variant) {
  return variant === 'correct' ? 'PASS' : 'FAIL'
}

function trialRecord({ repetition, arm, route, testCase, variant, oracleState, verdict, setup, action, verification, localVerificationMs = 0, notes }) {
  const setupTotals = operationTotals(setup)
  const actionTotals = operationTotals(action)
  const verificationTotals = operationTotals(verification)
  verificationTotals.wallMs = roundedMs(verificationTotals.wallMs + localVerificationMs)
  const oracle = oracleVerdict(testCase.id, oracleState)
  return {
    repetition, arm, route, case: testCase.id, variant,
    postcondition: testCase.postcondition,
    expectedTruth: expectedTruth(variant),
    oracle, oracleState,
    verdict,
    correct: correctness(verdict, oracle),
    falseGreen: verdict === 'PASS' && oracle === 'FAIL',
    falseNegative: verdict === 'FAIL' && oracle === 'PASS',
    unknown: verdict === 'UNKNOWN',
    rounds: {
      setup: setupTotals.rounds,
      action: actionTotals.rounds,
      verification: verificationTotals.rounds,
      actionPlusVerification: actionTotals.rounds + verificationTotals.rounds,
      fullFlow: setupTotals.rounds + actionTotals.rounds + verificationTotals.rounds,
    },
    bytes: {
      setupRequest: setupTotals.requestBytes,
      setupResponse: setupTotals.responseBytes,
      setupArtifacts: setupTotals.artifactBytes,
      actionRequest: actionTotals.requestBytes,
      actionResponse: actionTotals.responseBytes,
      actionArtifacts: actionTotals.artifactBytes,
      verificationRequest: verificationTotals.requestBytes,
      verificationResponse: verificationTotals.responseBytes,
      verificationArtifacts: verificationTotals.artifactBytes,
      actionPlusVerification: actionTotals.requestBytes + actionTotals.responseBytes + verificationTotals.requestBytes + verificationTotals.responseBytes,
      actionPlusVerificationArtifacts: actionTotals.artifactBytes + verificationTotals.artifactBytes,
      effectiveActionPlusVerification: actionTotals.requestBytes + actionTotals.responseBytes + actionTotals.artifactBytes + verificationTotals.requestBytes + verificationTotals.responseBytes + verificationTotals.artifactBytes,
      fullFlowWire: setupTotals.requestBytes + setupTotals.responseBytes + actionTotals.requestBytes + actionTotals.responseBytes + verificationTotals.requestBytes + verificationTotals.responseBytes,
      fullFlowArtifacts: setupTotals.artifactBytes + actionTotals.artifactBytes + verificationTotals.artifactBytes,
      effectiveFullFlow: setupTotals.requestBytes + setupTotals.responseBytes + setupTotals.artifactBytes + actionTotals.requestBytes + actionTotals.responseBytes + actionTotals.artifactBytes + verificationTotals.requestBytes + verificationTotals.responseBytes + verificationTotals.artifactBytes,
    },
    timingMs: {
      action: actionTotals.wallMs,
      verification: verificationTotals.wallMs,
      actionPlusVerification: roundedMs(actionTotals.wallMs + verificationTotals.wallMs),
      fullFlow: roundedMs(setupTotals.wallMs + actionTotals.wallMs + verificationTotals.wallMs),
      localVerification: roundedMs(localVerificationMs),
    },
    notes,
    operations: { setup, action, verification },
  }
}

function fixtureUrl(baseUrl, testCase, variant, runId) {
  const params = new URLSearchParams({ case: testCase.id, variant, run: runId })
  return `${baseUrl}/fixture?${params}`
}

async function playwrightAction(client, url) {
  const navigate = await client.callTool('browser_navigate', { url }, 'setup')
  const runRef = playwrightRef(navigate, { role: 'button', name: 'Run requested action' })
  const click = await client.callTool('browser_click', {
    element: 'Run requested action button', target: runRef,
  }, 'action')
  return { navigate, click }
}

async function runPlaywrightOutOfBoxTrial({ client, baseUrl, oracle, repetition, testCase, variant }) {
  const runId = `pw-direct-${repetition}-${testCase.id}-${variant}-${randomBytes(4).toString('hex')}`
  const url = fixtureUrl(baseUrl, testCase, variant, runId)
  const { navigate, click } = await playwrightAction(client, url)
  const oracleState = await waitForOracle(oracle, runId)
  const setup = [navigate]
  const action = [click]
  const verification = []
  let verdict = click.isError ? 'UNKNOWN' : 'PASS'
  let route = 'direct-testing-tools'
  let notes = null
  let localVerificationMs = 0

  if (!click.isError && testCase.id === 'checkbox-target') {
    const targetRef = playwrightRef(click, { role: 'checkbox', name: 'Target todo' })
    const neighborRef = playwrightRef(click, { role: 'checkbox', name: 'Neighbor todo' })
    const target = await client.callTool('browser_verify_value', {
      type: 'checkbox', element: 'Target todo checkbox', target: targetRef, value: 'true',
    })
    verification.push(target)
    if (target.isError) verdict = 'FAIL'
    else {
      const neighbor = await client.callTool('browser_verify_value', {
        type: 'checkbox', element: 'Neighbor todo checkbox', target: neighborRef, value: 'false',
      })
      verification.push(neighbor)
      verdict = neighbor.isError ? 'FAIL' : 'PASS'
    }
  } else if (!click.isError && testCase.id === 'add-exact-item') {
    const requested = await client.callTool('browser_verify_text_visible', { text: 'Requested alpha' })
    verification.push(requested)
    if (requested.isError) verdict = 'FAIL'
    else {
      const distractorAbsent = await client.callTool('browser_wait_for', { textGone: 'Distractor beta' })
      verification.push(distractorAbsent)
      verdict = distractorAbsent.isError ? 'FAIL' : 'PASS'
    }
    route = 'direct-testing-plus-wait-tool'
  } else if (!click.isError && testCase.id === 'modal-actionable') {
    const dialog = await client.callTool('browser_verify_element_visible', {
      role: 'dialog', accessibleName: 'Verification modal',
    })
    verification.push(dialog)
    if (dialog.isError) verdict = 'FAIL'
    else {
      const closeRef = playwrightRef(click, { role: 'button', name: 'Close modal' })
      const hover = await client.callTool('browser_hover', {
        element: 'Close modal button used as a non-mutating actionability probe', target: closeRef,
      }, 'verification', 5_000)
      verification.push(hover)
      verdict = hover.isError ? 'FAIL' : 'PASS'
    }
    route = 'direct-testing-plus-built-in-hover-actionability-probe'
    notes = 'browser_hover is a built-in non-mutating actionability probe, not a testing-cap assertion'
  } else if (!click.isError && testCase.id === 'semantic-no-op') {
    const started = performance.now()
    const before = extractPlaywrightSnapshot(navigate)
    const after = extractPlaywrightSnapshot(click)
    if (before === null || after === null) verdict = 'UNKNOWN'
    else verdict = before === after ? 'PASS' : 'FAIL'
    localVerificationMs = performance.now() - started
    route = 'mechanical-automatic-action-snapshot-comparison'
    notes = 'No post-action MCP round: the client compares normalized YAML snapshots already returned by navigate and click; generated refs are ignored'
  }

  return trialRecord({ repetition, arm: 'playwright-out-of-box', route, testCase, variant, oracleState, verdict, setup, action, verification, localVerificationMs, notes })
}

function customFunction(testCase) {
  if (testCase.id === 'checkbox-target') return `() => {
    const target = document.querySelector('#target')?.checked === true
    const neighbor = document.querySelector('#neighbor')?.checked === true
    return (target && !neighbor ? 'MCP_VALUE_PASS ' : 'MCP_VALUE_FAIL ') + JSON.stringify({ target, neighbor })
  }`
  if (testCase.id === 'add-exact-item') return `() => {
    const text = [...document.querySelectorAll('#items li')].map(element => element.textContent.trim())
    const pass = text.includes('Requested alpha') && !text.includes('Distractor beta')
    return (pass ? 'MCP_VALUE_PASS ' : 'MCP_VALUE_FAIL ') + JSON.stringify({ text })
  }`
  if (testCase.id === 'modal-actionable') return `() => {
    const dialog = document.querySelector('#dialog')
    const close = document.querySelector('#close')
    const visible = !!dialog && !dialog.hidden && getComputedStyle(dialog).visibility !== 'hidden'
    let clear = false
    let hit = null
    if (visible && close) {
      const rect = close.getBoundingClientRect()
      const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      hit = node?.id || node?.getAttribute?.('aria-label') || node?.tagName || null
      clear = !!node && (node === close || close.contains(node))
    }
    const pass = visible && clear
    return (pass ? 'MCP_VALUE_PASS ' : 'MCP_VALUE_FAIL ') + JSON.stringify({ visible, clear, hit })
  }`
  return `() => {
    const current = JSON.stringify({
      text: document.body.innerText.replace(/\\s+/g, ' ').trim(),
      controls: [...document.querySelectorAll('input,button,select,textarea')].map(element => ({
        tag: element.tagName, id: element.id, checked: element.checked, disabled: element.disabled,
        value: element.type === 'password' ? '<redacted>' : element.value,
      })),
    })
    const pass = current === window.__mcpValueBaseline
    return (pass ? 'MCP_VALUE_PASS ' : 'MCP_VALUE_FAIL ') + JSON.stringify({ baselineEqual: pass })
  }`
}

const customBaselineFunction = `() => {
  window.__mcpValueBaseline = JSON.stringify({
    text: document.body.innerText.replace(/\\s+/g, ' ').trim(),
    controls: [...document.querySelectorAll('input,button,select,textarea')].map(element => ({
      tag: element.tagName, id: element.id, checked: element.checked, disabled: element.disabled,
      value: element.type === 'password' ? '<redacted>' : element.value,
    })),
  })
  return 'MCP_VALUE_BASELINE_SAVED'
}`

async function runPlaywrightCustomTrial({ client, baseUrl, oracle, repetition, testCase, variant }) {
  const runId = `pw-custom-${repetition}-${testCase.id}-${variant}-${randomBytes(4).toString('hex')}`
  const url = fixtureUrl(baseUrl, testCase, variant, runId)
  const navigate = await client.callTool('browser_navigate', { url }, 'setup')
  const setup = [navigate]
  if (testCase.id === 'semantic-no-op') {
    setup.push(await client.callTool('browser_evaluate', { function: customBaselineFunction }, 'setup'))
  }
  const runRef = playwrightRef(navigate, { role: 'button', name: 'Run requested action' })
  const click = await client.callTool('browser_click', {
    element: 'Run requested action button', target: runRef,
  }, 'action')
  const oracleState = await waitForOracle(oracle, runId)
  const verification = []
  let verdict = 'UNKNOWN'
  if (!click.isError) {
    const evaluated = await client.callTool('browser_evaluate', { function: customFunction(testCase) })
    verification.push(evaluated)
    const resultSection = playwrightResultSection(evaluated)
    if (!evaluated.isError && resultSection?.includes('MCP_VALUE_PASS')) verdict = 'PASS'
    else if (!evaluated.isError && resultSection?.includes('MCP_VALUE_FAIL')) verdict = 'FAIL'
  }
  return trialRecord({
    repetition, arm: 'playwright-custom-evaluate', route: 'custom-browser-evaluate',
    testCase, variant, oracleState, verdict, setup, action: [click], verification,
    notes: 'Arbitrary page JavaScript escape hatch; code length and baseline setup are visible in the raw requests',
  })
}

function snapdomSpec(testCase) {
  if (testCase.id === 'checkbox-target') return {
    changed: true,
    mustInclude: [{ kind: 'state', role: 'checkbox', nameExact: 'Target todo', to: { checked: true } }],
    mustNotInclude: [{ kind: 'state', role: 'checkbox', name: 'Neighbor todo' }],
  }
  if (testCase.id === 'add-exact-item') return {
    changed: true,
    mustInclude: [{ kind: 'added', nameExact: 'Requested alpha' }],
    exists: 'Requested alpha',
    mustNotInclude: [{ kind: 'added', name: 'Distractor beta' }],
  }
  if (testCase.id === 'modal-actionable') return {
    changed: true,
    mustInclude: [{ kind: 'added', role: 'dialog', nameExact: 'Verification modal' }],
    exists: 'Verification modal',
    notCovered: 'Close modal',
  }
  return { changed: false }
}

async function runSnapdomTrial({ client, baseUrl, oracle, repetition, testCase, variant }) {
  const runId = `snapdom-${repetition}-${testCase.id}-${variant}-${randomBytes(4).toString('hex')}`
  const url = fixtureUrl(baseUrl, testCase, variant, runId)
  const opened = await client.callTool('browser_open', { url }, 'setup', 30_000)
  const top = opened.result?.structuredContent?.digest?.top || []
  const button = top.find((entry) => (entry.r || entry.role) === 'button' && (entry.n || entry.name) === 'Run requested action')
  const setup = [opened]
  const action = []
  const verification = []
  let verdict = 'UNKNOWN'
  if (button && !opened.isError) {
    const clicked = await client.callTool('browser_act', { action: 'click', target: button.id }, 'action')
    action.push(clicked)
    if (!clicked.isError) {
      const asserted = await client.callTool('browser_assert', snapdomSpec(testCase), 'verification', 20_000)
      verification.push(asserted)
      const pass = asserted.result?.structuredContent?.pass
      if (pass === true) verdict = 'PASS'
      else if (pass === false) verdict = 'FAIL'
    }
  }
  const oracleState = await waitForOracle(oracle, runId)
  return trialRecord({
    repetition, arm: 'snapdom-direct', route: 'direct-browser-assert',
    testCase, variant, oracleState, verdict, setup, action, verification,
    notes: 'One post-action assertion request; structured checks and typed diff evidence are retained in the raw response',
  })
}

function schemaMeasurement(client) {
  const { initialize, initialized, tools } = client.handshake
  const requestResponseBytes = initialize.requestBytes + initialize.responseBytes + tools.requestBytes + tools.responseBytes
  return {
    serverInfo: initialize.message.result?.serverInfo,
    toolCount: tools.message.result?.tools?.length,
    toolNames: tools.message.result?.tools?.map((tool) => tool.name),
    initializeRequestBytes: initialize.requestBytes,
    initializeResponseBytes: initialize.responseBytes,
    initializedNotificationBytes: initialized.bytes,
    toolsListRequestBytes: tools.requestBytes,
    toolsListResponseBytes: tools.responseBytes,
    requestResponseBytes,
    totalProtocolBytesIncludingInitializedNotification: requestResponseBytes + initialized.bytes,
    raw: { initialize, initialized, tools },
  }
}

async function startPlaywrightClient({ tempRoot, fixturePort, label }) {
  const installCache = join(tempRoot, 'npm-cache')
  const browserStore = join(tempRoot, 'playwright-browsers')
  await mkdir(installCache, { recursive: true })
  const client = new McpClient({
    name: `playwright-${label}`,
    command: 'npx',
    commandArgs: [
      '--yes', PLAYWRIGHT_MCP_PACKAGE,
      '--browser=chromium', '--headless', '--isolated', '--caps=testing', '--snapshot-mode=full',
      '--timeout-action=1200', '--timeout-settle=50',
      '--allowed-origins', `http://127.0.0.1:${fixturePort}`,
    ],
    cwd: tempRoot,
    env: sanitizedEnvironment({ npm_config_cache: installCache, PLAYWRIGHT_BROWSERS_PATH: browserStore }),
  })
  client.playwrightArtifactRoot = join(tempRoot, '.playwright-mcp')
  await client.initialize()
  const actual = client.handshake.initialize.message.result?.serverInfo?.version
  if (actual !== PLAYWRIGHT_MCP_SERVER_VERSION) {
    await client.close()
    throw new Error(`Playwright MCP server version drift: expected ${PLAYWRIGHT_MCP_SERVER_VERSION}, got ${actual}`)
  }
  return client
}

async function startSnapdomClient({ tempRoot, label }) {
  const daemonPort = await reservePort()
  const token = randomBytes(32).toString('hex')
  const logDir = join(tempRoot, `snapdom-logs-${label}`)
  const tokenFile = join(tempRoot, `snapdom-token-${label}`)
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  const client = new McpClient({
    name: `snapdom-${label}`,
    command: process.execPath,
    commandArgs: [join(ROOT, 'mcp', 'server.mjs')],
    cwd: ROOT,
    env: sanitizedEnvironment({
      SNAPDOM_AGENT_PORT: String(daemonPort),
      SNAPDOM_AGENT_TOKEN: token,
      SNAPDOM_AGENT_TOKEN_FILE: tokenFile,
      SNAPDOM_AGENT_LOGDIR: logDir,
    }),
  })
  await client.initialize()
  client.daemonPort = daemonPort
  return client
}

async function runLane({ lane, repetition, tempRoot, fixturePort, baseUrl, oracle }) {
  const label = `${lane}-${repetition}`
  let client
  let cleanExit = false
  let daemonPortClosed = null
  const trials = []
  try {
    if (lane === 'snapdom-direct') client = await startSnapdomClient({ tempRoot, label })
    else client = await startPlaywrightClient({ tempRoot, fixturePort, label })
    for (const testCase of CASES) {
      for (const variant of VARIANTS) {
        if (lane === 'snapdom-direct') trials.push(await runSnapdomTrial({ client, baseUrl, oracle, repetition, testCase, variant }))
        else if (lane === 'playwright-out-of-box') trials.push(await runPlaywrightOutOfBoxTrial({ client, baseUrl, oracle, repetition, testCase, variant }))
        else trials.push(await runPlaywrightCustomTrial({ client, baseUrl, oracle, repetition, testCase, variant }))
      }
    }
    return { trials, schema: schemaMeasurement(client), get cleanup() { return { lane, cleanExit, daemonPortClosed } } }
  } finally {
    if (client) {
      const exit = await client.close({ closeBrowser: lane !== 'snapdom-direct' })
      cleanExit = exit?.code === 0
      if (client.daemonPort) {
        for (let i = 0; i < 10; i++) {
          daemonPortClosed = await isPortClosed(client.daemonPort)
          if (daemonPortClosed) break
          await delay(100)
        }
      }
    }
  }
}

async function installPinnedPlaywrightBrowser(tempRoot) {
  const browserStore = join(tempRoot, 'playwright-browsers')
  const installCache = join(tempRoot, 'npm-cache')
  await mkdir(browserStore, { recursive: true })
  await mkdir(installCache, { recursive: true })
  const child = spawn('npx', ['--yes', PLAYWRIGHT_MCP_PACKAGE, 'install-browser', 'chrome-for-testing'], {
    cwd: tempRoot,
    env: sanitizedEnvironment({ PLAYWRIGHT_BROWSERS_PATH: browserStore, npm_config_cache: installCache }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  if (exit.code !== 0) throw new Error(`pinned Playwright browser install failed (${exit.code ?? exit.signal})\n${stderr}`)
  return { browserStore, stdout, stderr, exit }
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : roundedMs((sorted[middle - 1] + sorted[middle]) / 2)
}

function aggregate(trials) {
  const groups = new Map()
  for (const trial of trials) {
    const key = `${trial.arm}\0${trial.route}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(trial)
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [arm, route] = key.split('\0')
    return summarize(entries, { arm, route })
  })
}

function summarize(entries, dimensions) {
  return {
    ...dimensions,
    trials: entries.length,
    correct: entries.filter((entry) => entry.correct).length,
    falseGreens: entries.filter((entry) => entry.falseGreen).length,
    falseNegatives: entries.filter((entry) => entry.falseNegative).length,
    unknowns: entries.filter((entry) => entry.unknown).length,
    medianVerificationRounds: median(entries.map((entry) => entry.rounds.verification)),
    medianActionPlusVerificationRounds: median(entries.map((entry) => entry.rounds.actionPlusVerification)),
    medianFullFlowRounds: median(entries.map((entry) => entry.rounds.fullFlow)),
    medianVerificationBytes: median(entries.map((entry) => entry.bytes.verificationRequest + entry.bytes.verificationResponse)),
    medianVerificationArtifactBytes: median(entries.map((entry) => entry.bytes.verificationArtifacts)),
    medianEffectiveVerificationBytes: median(entries.map((entry) => entry.bytes.verificationRequest + entry.bytes.verificationResponse + entry.bytes.verificationArtifacts)),
    medianActionPlusVerificationBytes: median(entries.map((entry) => entry.bytes.actionPlusVerification)),
    medianActionPlusVerificationArtifactBytes: median(entries.map((entry) => entry.bytes.actionPlusVerificationArtifacts)),
    medianEffectiveActionPlusVerificationBytes: median(entries.map((entry) => entry.bytes.effectiveActionPlusVerification)),
    medianFullFlowWireBytes: median(entries.map((entry) => entry.bytes.fullFlowWire)),
    medianFullFlowArtifactBytes: median(entries.map((entry) => entry.bytes.fullFlowArtifacts)),
    medianEffectiveFullFlowBytes: median(entries.map((entry) => entry.bytes.effectiveFullFlow)),
    medianVerificationMs: median(entries.map((entry) => entry.timingMs.verification)),
    medianFullFlowMs: median(entries.map((entry) => entry.timingMs.fullFlow)),
  }
}

function armAggregates(trials) {
  return [...new Set(trials.map((entry) => entry.arm))].map((arm) =>
    summarize(trials.filter((entry) => entry.arm === arm), { arm }))
}

function caseAggregates(trials) {
  const groups = new Map()
  for (const trial of trials) {
    const key = `${trial.case}\0${trial.arm}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(trial)
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [testCase, arm] = key.split('\0')
    const correct = entries.filter((entry) => entry.variant === 'correct')
    const nearMiss = entries.filter((entry) => entry.variant === 'near-miss')
    return {
      ...summarize(entries, { case: testCase, arm, route: [...new Set(entries.map((entry) => entry.route))].join(', ') }),
      medianCorrectVerificationRounds: median(correct.map((entry) => entry.rounds.verification)),
      medianNearMissVerificationRounds: median(nearMiss.map((entry) => entry.rounds.verification)),
      medianCorrectFullFlowRounds: median(correct.map((entry) => entry.rounds.fullFlow)),
      medianNearMissFullFlowRounds: median(nearMiss.map((entry) => entry.rounds.fullFlow)),
    }
  })
}

function markdown(result) {
  const totalCorrect = result.trials.filter((trial) => trial.correct).length
  const totalFalseGreens = result.trials.filter((trial) => trial.falseGreen).length
  const totalFalseNegatives = result.trials.filter((trial) => trial.falseNegative).length
  const totalUnknown = result.trials.filter((trial) => trial.unknown).length
  const lines = [
    '# Local MCP value probe', '',
    `Status: empirical local observation, not a general product claim  `,
    `Run: ${result.started} to ${result.finished}  `,
    `Repetitions: ${result.repetitions}; trials: ${result.trials.length}`, '',
    `All three routes matched the frozen expected-truth manifest in ${totalCorrect}/${result.trials.length} trials: ${totalFalseGreens} false greens, ${totalFalseNegatives} false negatives, and ${totalUnknown} UNKNOWN verdicts. This is equal correctness on four authored local cases, not evidence of general accuracy.`, '',
    '## Outcome', '',
    '| Arm (same 24-trial set) | Correct | False green | False negative | Unknown | Median verify rounds | Median action+verify rounds | Median full-flow rounds | Median verify effective B | Median action+verify effective B | Median full-flow effective B | Median verify ms | Median full-flow ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const row of result.armAggregates) {
    lines.push(`| ${row.arm} | ${row.correct}/${row.trials} | ${row.falseGreens} | ${row.falseNegatives} | ${row.unknowns} | ${row.medianVerificationRounds} | ${row.medianActionPlusVerificationRounds} | ${row.medianFullFlowRounds} | ${row.medianEffectiveVerificationBytes} | ${row.medianEffectiveActionPlusVerificationBytes} | ${row.medianEffectiveFullFlowBytes} | ${row.medianVerificationMs} | ${row.medianFullFlowMs} |`)
  }
  lines.push('', '## Case breakdown', '',
    'Rounds are shown as `correct / near-miss`; this exposes short-circuit behavior instead of pooling it away.', '',
    '| Case | Arm / route | Correct | Verify rounds (correct / near) | Full-flow rounds (correct / near) | Median verify effective B | Median full-flow effective B | Median verify ms | Median full-flow ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const row of result.caseAggregates) {
    lines.push(`| ${row.case} | ${row.arm} / ${row.route} | ${row.correct}/${row.trials} | ${row.medianCorrectVerificationRounds} / ${row.medianNearMissVerificationRounds} | ${row.medianCorrectFullFlowRounds} / ${row.medianNearMissFullFlowRounds} | ${row.medianEffectiveVerificationBytes} | ${row.medianEffectiveFullFlowBytes} | ${row.medianVerificationMs} | ${row.medianFullFlowMs} |`)
  }
  lines.push('', '## Cold schema cost', '',
    '| Server | Tools | initialize + tools/list request/response bytes | Including initialized notification | tools/list response bytes |',
    '|---|---:|---:|---:|---:|')
  for (const [name, measurement] of Object.entries(result.schemas)) {
    lines.push(`| ${name} | ${measurement.toolCount} | ${measurement.requestResponseBytes} | ${measurement.totalProtocolBytesIncludingInitializedNotification} | ${measurement.toolsListResponseBytes} |`)
  }
  lines.push('', '## Interpretation boundary', '',
    'SnapDOM provided one declarative `browser_assert` verification round for every case. Playwright out of the box used zero to two post-action rounds depending on the predicate, and arbitrary `browser_evaluate` used one custom round. The direct Playwright routes were usually smaller; custom evaluation was also smaller here but required case-authored JavaScript. SnapDOM returned the typed before/after checks and diff automatically.', '',
    'Two endpoints show why there is no global winner in this probe. For the covered modal near miss, SnapDOM used one direct assertion at about 20 ms while Playwright\'s built-in hover actionability probe used two rounds at about 1.2 seconds; custom evaluation used one round at about 55 ms. For semantic no-op, Playwright mechanically compared the snapshots already returned by navigation and action with zero additional MCP rounds and about 751–770 effective action-plus-verification bytes, while SnapDOM used one assertion round and about 1,669–1,911 bytes.', '',
    'Full flow starts with navigation or `browser_open` and includes setup, action, verification, and linked-artifact reads. SnapDOM reuses the action target already returned by `browser_open`; Playwright reuses the ref from navigation. The custom no-op baseline evaluation counts as setup. Package/browser installation, MCP startup, and expected-truth polling remain outside this timing.', '',
    'The SnapDOM schema was smaller than the Playwright MCP schema, but SnapDOM is currently an additional layer alongside Playwright; a client loading both schemas pays both costs rather than replacing one with the other.', '',
    'This run compares deterministic MCP surfaces without a model. The “oracle” is a frozen server-side expected-truth manifest activated by an action ping; it does not observe the DOM. The probe can show direct expressibility and exact protocol cost for these pinned fixtures. It cannot establish model task success, token cost, web-wide accuracy, a false-green population rate, or population-level latency.', '',
    'Playwright automatic snapshots were linked `.yml` artifacts in this version. The runner validates every path under its temporary artifact root, hashes and reads it mechanically, and reports artifact bytes separately from JSON-RPC bytes and in an effective total.', '',
    `Isolation and cleanup gates passed: local fixture only, explicit temporary Chromium for Playwright MCP, isolated in-memory profiles, OS-assigned SnapDOM ports excluding 8377, clean MCP exits, closed fixture and daemon ports, and verified temporary-root deletion. No personal Chrome profile, tab, cookie, session, history, password, or extension was accessed.`, '',
    `Fixture SHA-256: \`${result.fixture.sha256}\`. Raw requests, responses, oracle state, and per-trial timings are in the sibling JSON file.`, '')
  return lines.join('\n')
}

if (args.has('--report-existing')) {
  const output = process.env.MCP_VALUE_OUTPUT
  if (!output) throw new Error('MCP_VALUE_OUTPUT is required with --report-existing')
  const outputPath = resolve(ROOT, output)
  const existing = JSON.parse(await readFile(outputPath, 'utf8'))
  existing.armAggregates = armAggregates(existing.trials)
  existing.caseAggregates = caseAggregates(existing.trials)
  existing.aggregates = aggregate(existing.trials)
  await writeFile(outputPath, `${JSON.stringify(existing, null, 2)}\n`)
  await writeFile(outputPath.replace(/\.json$/i, '.md'), markdown(existing))
  process.stdout.write(`${JSON.stringify({ output, trials: existing.trials.length, armAggregates: existing.armAggregates }, null, 2)}\n`)
  process.exit(0)
}

let tempRoot
let fixture
let fixturePort
let fixtureClosed = false
let fixturePortClosed = false
let tempRemoved = false
let completedResult
let browserInstall
const started = new Date().toISOString()
const laneRuns = []
try {
  tempRoot = await mkdtemp(join(tmpdir(), 'snapdom-mcp-value-'))
  fixture = createFixture()
  fixturePort = await listen(fixture.server)
  browserInstall = await installPinnedPlaywrightBrowser(tempRoot)
  const baseUrl = `http://127.0.0.1:${fixturePort}`
  const orders = [
    ['playwright-out-of-box', 'snapdom-direct', 'playwright-custom-evaluate'],
    ['snapdom-direct', 'playwright-custom-evaluate', 'playwright-out-of-box'],
    ['playwright-custom-evaluate', 'playwright-out-of-box', 'snapdom-direct'],
  ]
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const lane of orders[repetition % orders.length]) {
      laneRuns.push(await runLane({ lane, repetition, tempRoot, fixturePort, baseUrl, oracle: fixture.oracle }))
    }
  }
  await closeServer(fixture.server)
  fixtureClosed = true
  fixturePortClosed = await isPortClosed(fixturePort)
  const schemas = {}
  for (const run of laneRuns) {
    const info = run.schema.serverInfo
    const key = info?.name === 'Playwright' ? 'playwrightMcp' : 'snapdomMcp'
    schemas[key] ||= run.schema
  }
  const trials = laneRuns.flatMap((run) => run.trials)
  completedResult = {
    schemaVersion: 1,
    mode: 'run',
    started,
    finished: new Date().toISOString(),
    repetitions,
    protocol: PROTOCOL,
    pinned: {
      node: process.version,
      playwrightMcpPackage: PLAYWRIGHT_MCP_PACKAGE,
      expectedAndObservedPlaywrightServerVersion: PLAYWRIGHT_MCP_SERVER_VERSION,
      snapdomPackage: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
      snapdomImplementationSha256: await sha256Files([join(ROOT, 'mcp', 'server.mjs'), join(ROOT, 'tools', 'browse.mjs'), join(ROOT, 'tools', 'sdk-bundle.mjs')]),
    },
    fixture: { version: FIXTURE_VERSION, sha256: fixtureSourceFingerprint, cases: CASES },
    isolation: {
      fixture: '127.0.0.1 OS-assigned port; no external page or credential',
      playwright: '--browser=chromium --headless --isolated; exact package browser installed into and executed from the temporary root; cwd and default .playwright-mcp artifacts are under the temporary root; in-memory profile; no extension/CDP/storage-state/user-data-dir',
      snapdom: 'headless chromium.launch plus fresh BrowserContext; temporary token/log state; OS-assigned daemon ports excluding 8377',
      personalChromeAccess: false,
    },
    browserInstall: {
      command: `npx --yes ${PLAYWRIGHT_MCP_PACKAGE} install-browser chrome-for-testing`,
      temporaryStore: true,
      exitCode: browserInstall.exit.code,
      stderr: browserInstall.stderr,
    },
    schemas,
    armAggregates: armAggregates(trials),
    caseAggregates: caseAggregates(trials),
    aggregates: aggregate(trials),
    trials,
    cleanup: {
      fixtureClosed,
      fixturePortClosed,
      laneProcesses: laneRuns.map((run) => run.cleanup),
      temporaryRootRemoved: false,
    },
  }
} finally {
  if (fixture && !fixtureClosed) await closeServer(fixture.server).catch(() => {})
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    try { await stat(tempRoot) } catch (error) { tempRemoved = error?.code === 'ENOENT' }
  }
  if (tempRoot && !tempRemoved) process.stderr.write('warning: temporary root cleanup could not be verified\n')
}

completedResult.cleanup.temporaryRootRemoved = tempRemoved
const cleanupFailures = []
if (!completedResult.cleanup.fixtureClosed) cleanupFailures.push('fixture server did not close')
if (!completedResult.cleanup.fixturePortClosed) cleanupFailures.push('fixture port remained open')
if (!completedResult.cleanup.temporaryRootRemoved) cleanupFailures.push('temporary root remained on disk')
for (const [index, lane] of completedResult.cleanup.laneProcesses.entries()) {
  if (!lane.cleanExit) cleanupFailures.push(`lane ${index} MCP process did not exit with code 0`)
  if (lane.lane === 'snapdom-direct' && lane.daemonPortClosed !== true) cleanupFailures.push(`lane ${index} SnapDOM daemon port closure was not verified`)
}
if (cleanupFailures.length) throw new Error(`cleanup gate failed; refusing to publish: ${cleanupFailures.join('; ')}`)
if (process.env.MCP_VALUE_REQUIRE_ALL_CORRECT === '1') {
  const bad = completedResult.trials.filter((trial) => !trial.correct || trial.unknown || trial.falseGreen || trial.falseNegative)
  if (bad.length) {
    throw new Error(`correctness self-test failed; refusing to publish: ${bad.map((trial) => `${trial.arm}/${trial.case}/${trial.variant}=${trial.verdict} oracle=${trial.oracle}`).join('; ')}`)
  }
}
const output = process.env.MCP_VALUE_OUTPUT
if (output) {
  const outputPath = resolve(ROOT, output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(completedResult, null, 2)}\n`)
  await writeFile(outputPath.replace(/\.json$/i, '.md'), markdown(completedResult))
}
process.stdout.write(`${JSON.stringify({
  output: output || null,
  started: completedResult.started,
  finished: completedResult.finished,
  repetitions: completedResult.repetitions,
  trials: completedResult.trials.length,
  armAggregates: completedResult.armAggregates,
  caseAggregates: completedResult.caseAggregates,
  aggregates: completedResult.aggregates,
  schemas: Object.fromEntries(Object.entries(completedResult.schemas).map(([key, value]) => [key, {
    serverInfo: value.serverInfo,
    toolCount: value.toolCount,
    toolsListResponseBytes: value.toolsListResponseBytes,
    requestResponseBytes: value.requestResponseBytes,
    includingInitializedNotification: value.totalProtocolBytesIncludingInitializedNotification,
  }])),
  cleanup: completedResult.cleanup,
}, null, 2)}\n`)
