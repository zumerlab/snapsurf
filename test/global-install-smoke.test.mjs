import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import process from 'node:process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = process.env.SNAPDOM_AGENT_INSTALLER || join(ROOT, 'tools', 'install-global.mjs')
const hmac = (token, message) => createHmac('sha256', token).update(message).digest('hex')
const signedPost = async (port, token, payload) => {
  const body = JSON.stringify(payload)
  const nonce = randomBytes(16).toString('hex')
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-snapdom-nonce': nonce,
      'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`),
    },
    body,
  })
  const text = await response.text()
  const actual = Buffer.from(String(response.headers.get('x-snapdom-auth') || ''))
  const expected = Buffer.from(hmac(token, `response-v1\n${nonce}\n${text}`))
  assert.equal(actual.length === expected.length && timingSafeEqual(actual, expected), true)
  return response
}

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function nextRpc(iterator) {
  const line = await withTimeout(iterator.next(), 25_000, 'installed MCP did not reply')
  if (line.done) throw new Error('installed MCP closed stdout before replying')
  return JSON.parse(line.value)
}

async function playwrightBrowserRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  const { chromium } = await import('playwright')
  let cursor = dirname(chromium.executablePath())
  while (dirname(cursor) !== cursor) {
    if (/^chromium(?:_headless_shell)?-\d+$/.test(basename(cursor))) return dirname(cursor)
    cursor = dirname(cursor)
  }
  throw new Error('could not locate the installed Playwright browser cache')
}

test('global installer creates a self-contained runnable copy', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'snapdom-agent-install-'))
  const port = await freePort()
  const authToken = randomBytes(32).toString('hex')
  assert.notEqual(port, 8377)
  const env = {
    ...process.env,
    SNAPDOM_AGENT_INSTALL_HOME: home,
    SNAPDOM_AGENT_PORT: String(port),
    SNAPDOM_AGENT_LOGDIR: join(home, 'logs'),
    SNAPDOM_AGENT_TOKEN: authToken,
    SNAPDOM_AGENT_TOKEN_FILE: join(home, 'daemon.token'),
  }
  let daemon
  let mcp
  try {
    execFileSync(process.execPath, [INSTALLER], {
      cwd: ROOT,
      env,
      stdio: 'pipe',
    })
    const installed = join(home, '.claude', 'snapdom-agent')
    const paths = JSON.parse(await readFile(join(installed, 'paths.json'), 'utf8'))
    assert.equal(paths.agent, installed)
    for (const file of [
      'browse.mjs', 'server.mjs', 'sdk.js',
      'LICENSE', 'SNAPDOM-LICENSE', 'companion/LICENSE', 'companion/SNAPDOM-LICENSE',
      'node_modules/playwright/index.mjs', 'node_modules/playwright-core/package.json',
      'companion/manifest.json', 'companion/worker.js', 'companion/content.bundle.js',
      'companion/PROMPT-extension.md',
    ]) await readFile(join(installed, file))
    for (const prefix of ['', 'companion/']) {
      assert.equal(await readFile(join(installed, prefix + 'LICENSE'), 'utf8'),
        await readFile(join(ROOT, 'LICENSE'), 'utf8'))
      assert.equal(await readFile(join(installed, prefix + 'SNAPDOM-LICENSE'), 'utf8'),
        await readFile(join(ROOT, 'vendor', 'snapdom', 'LICENSE'), 'utf8'))
    }
    const installedSkill = await readFile(join(home, '.claude', 'skills', 'agent-browse', 'SKILL.md'), 'utf8')
    assert.equal(installedSkill.includes('/ABS/PATH'), false)
    assert.equal(installedSkill.includes('/Users/martin/.claude/snapdom-agent/browse.mjs'), false)
    assert.equal(installedSkill.includes(join(installed, 'browse.mjs')), true)
    assert.equal(installedSkill.includes(join(installed, 'companion', 'PROMPT-extension.md')), true)
    assert.match(installedSkill, /Each session has its own BrowserContext, cookies,/)

    daemon = spawn(process.execPath, [join(installed, 'browse.mjs'), 'serve'], {
      cwd: home,
      env,
      stdio: 'ignore',
    })
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      if (daemon.exitCode !== null) break
      try {
        const response = await signedPost(port, authToken, { cmd: 'status', envelope: true, internal: true })
        ready = response.ok
      } catch { await delay(50) }
    }
    assert.equal(ready, true, 'installed daemon did not start')
    const cliEnv = { ...env }
    delete cliEnv.SNAPDOM_AGENT_TOKEN
    const statusText = execFileSync(process.execPath, [join(installed, 'browse.mjs'), 'status'], {
      cwd: home,
      env: cliEnv,
      encoding: 'utf8',
    })
    assert.match(statusText, /daemon ok/)
    // Subscribe before requesting shutdown so a fast exit cannot be missed while
    // the HTTP response is being consumed. Clear the deadline after a normal exit.
    const daemonExit = new Promise((done) => daemon.once('exit', done))
    const stopped = await signedPost(port, authToken, { cmd: 'stop' })
    assert.equal(stopped.ok, true)
    await withTimeout(daemonExit, 5000, 'installed daemon did not stop')
    daemon = null

    // Start the installed MCP with a HOME that cannot contain a fallback global copy.
    // A real tool call (unlike initialize) forces it to find the adjacent browse.mjs,
    // spawn that daemon, authenticate it, and return a valid envelope.
    const mcpHome = join(home, 'mcp-home')
    await mkdir(mcpHome)
    mcp = spawn(process.execPath, [join(installed, 'server.mjs')], {
      cwd: home,
      env: {
        ...env,
        HOME: mcpHome,
        PLAYWRIGHT_BROWSERS_PATH: await playwrightBrowserRoot(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: mcp.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]()
    mcp.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
    }) + '\n')
    const initialized = await nextRpc(lines)
    assert.equal(initialized.id, 1)
    assert.equal(initialized.result?.serverInfo?.name, 'snapsurf')

    mcp.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'browser_session_list', arguments: {} },
    }) + '\n')
    const called = await nextRpc(lines)
    assert.equal(called.id, 2)
    assert.equal(called.result?.isError, false)
    assert.equal(called.result?.structuredContent?.ok, true)

    const mcpExit = new Promise((done) => mcp.once('exit', (code, signal) => done({ code, signal })))
    mcp.stdin.end()
    assert.deepEqual(
      await withTimeout(mcpExit, 5000, 'installed MCP did not exit after stdin closed'),
      { code: 0, signal: null },
    )
    mcp = null
  } finally {
    if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL')
    if (mcp && mcp.exitCode === null) mcp.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})
