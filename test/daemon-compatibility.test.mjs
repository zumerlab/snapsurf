import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import process from 'node:process'
import { engineSourceHash, runtimeIdentity, runtimeMismatch, sha256 } from '../tools/runtime-identity.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hmac = (token, value) => createHmac('sha256', token).update(value).digest('hex')

async function fixturePackage(directory) {
  const root = join(directory, 'package')
  for (const path of ['tools', 'mcp', 'src', 'vendor/snapdom/dist', 'vendor/snapdom/plugins']) {
    await mkdir(join(root, path), { recursive: true })
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.1.2' }))
  await writeFile(join(root, 'tools/browse.mjs'), '// Fixture daemon: the authenticated HTTP listener is test-owned.\n')
  await writeFile(join(root, 'tools/sdk-bundle.mjs'), '// fixture SDK builder\n')
  await writeFile(join(root, 'src/plugin.js'), 'export const fixture = true\n')
  await writeFile(join(root, 'vendor/snapdom/manifest.json'), '{}')
  await writeFile(join(root, 'vendor/snapdom/dist/snapdom.mjs'), '// fixture renderer\n')
  for (const path of ['tools/runtime-identity.mjs', 'mcp/server.mjs']) {
    await writeFile(join(root, path), await readFile(join(ROOT, path)))
  }
  return root
}

function rpcClient(child) {
  let id = 0
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.done(message.result)
  })
  return {
    call: (name, args = {}) => new Promise((done, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP compatibility request timed out')) }, 10_000)
      pending.set(requestId, { done, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    }),
    close: () => {
      lines.close()
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
    },
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.stdin?.end()
  const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exited
  clearTimeout(kill)
}

test('runtime identity survives a standalone install and detects same-version source changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapsurf-runtime-build-'))
  try {
    const root = await fixturePackage(directory)
    const browse = join(root, 'tools/browse.mjs')
    const source = await runtimeIdentity(browse)
    const installed = join(directory, 'installed')
    await mkdir(installed)
    const sdk = '// bundled fixture SDK'
    await writeFile(join(installed, 'browse.mjs'), await readFile(browse))
    await writeFile(join(installed, 'sdk.js'), sdk)
    await writeFile(join(installed, 'paths.json'), JSON.stringify({ version: source.version, engineSourceHash: await engineSourceHash(root), sdkHash: sha256(sdk) }))
    assert.deepEqual(await runtimeIdentity(join(installed, 'browse.mjs')), source)
    await writeFile(join(root, 'src/plugin.js'), 'export const fixture = false\n')
    const changed = await runtimeIdentity(browse)
    assert.equal(changed.version, source.version)
    assert.notEqual(changed.build, source.build)
    assert.match(runtimeMismatch(changed, source), /build/)
    await writeFile(join(installed, 'sdk.js'), '// modified without reinstall')
    await assert.rejects(runtimeIdentity(join(installed, 'browse.mjs')), /SDK changed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('MCP rejects incompatible authenticated daemons without touching their sessions', { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapsurf-daemon-compatibility-'))
  const root = await fixturePackage(directory)
  const expected = await runtimeIdentity(join(root, 'tools/browse.mjs'))
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(directory, 'daemon.token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  let advertised = expected
  const commands = []
  const server = createServer(async (request, response) => {
    if (request.url === '/owner') {
      // An unauthenticated owner card claiming compatibility must not override the
      // signed status below, including when adopting a different token.
      response.end(JSON.stringify({ v: 1, daemon: 'snapsurf', pid: 424242, startedAt: '2026-09-06T00:00:00Z', runtime: expected }))
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url === '/auth') {
      response.setHeader('x-snapdom-auth', hmac(token, `auth-v1\n${JSON.parse(body).nonce}`))
      response.end('ok')
      return
    }
    const nonce = request.headers['x-snapdom-nonce']
    if (request.headers['x-snapdom-auth'] !== hmac(token, `request-v1\n${nonce}\n${body}`)) {
      response.statusCode = 401
      response.end('unauthorized')
      return
    }
    const command = JSON.parse(body)
    commands.push(command.cmd)
    const meta = command.cmd === 'status'
      ? { ...(advertised ? { runtime: advertised } : {}), daemonPid: 424242, sessionCount: 3 }
      : { sessions: [{ sessionId: 's_existing', url: 'about:blank' }] }
    const wire = JSON.stringify({ v: 1, ok: true, sessionId: 's_default', epoch: 0, url: 'about:blank', meta, text: 'fixture daemon retained its sessions' })
    response.setHeader('x-snapdom-auth', hmac(token, `response-v1\n${nonce}\n${wire}`))
    response.end(wire)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  assert.notEqual(port, 8377)
  const launch = (initialToken = token) => {
    const child = spawn(process.execPath, [join(root, 'mcp/server.mjs')], {
      cwd: root,
      env: { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_TOKEN: initialToken, SNAPSURF_TOKEN_FILE: tokenFile, SNAPSURF_LOGDIR: join(directory, 'logs') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    return { child, client: rpcClient(child), stderr: () => stderr }
  }
  try {
    for (const [name, runtime, initialToken, reason] of [
      ['legacy daemon', null, token, /pre-upgrade/],
      ['different runtime protocol', { ...expected, protocolVersion: 2 }, token, /protocol/],
      ['older version', { ...expected, version: '0.1.1' }, token, /version/],
      ['same version, stale build', { ...expected, build: 'a'.repeat(64) }, token, /build/],
      ['missing capabilities', { ...expected, capabilities: [] }, token, /capabilities/],
      ['token adoption with stale build', { ...expected, build: 'b'.repeat(64) }, 'previous-client-token', /build/],
    ]) {
      await t.test(name, async () => {
        advertised = runtime
        commands.length = 0
        const mcp = launch(initialToken)
        try {
          const result = await mcp.client.call('browser_session_list')
          assert.equal(result.isError, true)
          assert.equal(result.structuredContent?.error?.code, 'SNAPSURF_DAEMON_INCOMPATIBLE')
          assert.equal(result.structuredContent.error.sessionsPreserved, true)
          assert.equal(result.structuredContent.error.sessionCount, 3)
          assert.match(result.content[0].text, reason)
          assert.match(result.content[0].text, /separate SNAPSURF_PORT/)
          assert.deepEqual(commands, ['status'], 'do not dispatch the requested tool, stop sessions, or restart the daemon')
          assert.doesNotMatch(mcp.stderr(), /spawning daemon/)
        } finally { mcp.client.close(); await stopChild(mcp.child) }
        assert.equal((await globalThis.fetch(`http://127.0.0.1:${port}/owner`)).ok, true, 'MCP exit must leave the existing daemon alive')
      })
    }
    await t.test('compatible token adoption and subsequent build mismatch', async () => {
      advertised = expected
      commands.length = 0
      const mcp = launch('previous-client-token')
      try {
        const result = await mcp.client.call('browser_session_list')
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.deepEqual(commands, ['status', 'status', 'session'])
        assert.equal(result.structuredContent.sessions[0].sessionId, 's_existing')
        advertised = { ...expected, build: 'c'.repeat(64) }
        commands.length = 0
        const refused = await mcp.client.call('browser_session_list')
        assert.equal(refused.structuredContent?.error?.code, 'SNAPSURF_DAEMON_INCOMPATIBLE')
        assert.deepEqual(commands, ['status'], 'revalidate before each tool, not only initial adoption')
      } finally { mcp.client.close(); await stopChild(mcp.child) }
    })
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await rm(directory, { recursive: true, force: true })
  }
})

test('real daemon preserves authenticated process identity under page privacy while MCP remains usable', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapsurf-runtime-owner-'))
  const listener = createServer()
  await new Promise((done) => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise((done) => listener.close(done))
  assert.notEqual(port, 8377)
  const token = randomBytes(32).toString('hex')
  const env = { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_TOKEN: token, SNAPSURF_TOKEN_FILE: join(directory, 'daemon.token'), SNAPSURF_LOGDIR: directory }
  const daemon = spawn(process.execPath, [join(ROOT, 'tools/browse.mjs'), 'serve'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let mcp, client
  daemon.stdout.on('data', (chunk) => { output += chunk })
  daemon.stderr.on('data', (chunk) => { output += chunk })
  const post = async (cmd, args = [], internal = false) => {
    const nonce = randomBytes(16).toString('hex')
    const body = JSON.stringify({ cmd, args, envelope: true, internal })
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-snapdom-nonce': nonce, 'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`) }, body })
    const wire = await response.text()
    assert.equal(response.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${wire}`))
    const result = JSON.parse(wire)
    assert.equal(result.ok, true, wire)
    return result
  }
  try {
    let owner
    const deadline = Date.now() + 30_000
    while (!owner && Date.now() < deadline && daemon.exitCode === null) {
      try { owner = await (await globalThis.fetch(`http://127.0.0.1:${port}/owner`)).json() } catch { await delay(50) }
    }
    assert.ok(owner?.runtime, output)
    assert.match(owner.runtime.build, /^[a-f0-9]{64}$/)
    assert.ok(owner.runtime.capabilities.includes('runtime.identity.v1'))
    const status = await post('status', [], true)
    assert.deepEqual(status.meta.runtime, owner.runtime)
    assert.equal(status.meta.daemonPid, daemon.pid)
    assert.equal(status.meta.sessionCount, 1)

    // Collide with capability text, version, build and start time. These same
    // strings remain private when they come from the document rather than status.
    const rules = ['evidence', 'runtime', owner.runtime.version, owner.runtime.build, owner.startedAt, 'secret-page-note']
    const html = `<main><h1>Private evidence runtime ${owner.runtime.version} ${owner.runtime.build} ${owner.startedAt}</h1><p>{"runtime":"secret-page-note"}</p><p>Public summary</p></main>`
    await post('open', ['data:text/html,' + encodeURIComponent(html)])
    await post('redact', [rules.join(',')])
    const observed = await post('look')
    const outline = await post('outline')
    assert.equal(observed.meta.privacy.applied, true)
    assert.match(outline.meta.outline, /\[redacted\]/)
    for (const term of rules) assert.equal(JSON.stringify(outline).includes(term), false, `page text must still redact ${term}`)

    const protectedStatus = await post('status')
    assert.deepEqual(protectedStatus.meta.runtime, owner.runtime)
    assert.equal(protectedStatus.meta.daemonPid, daemon.pid)
    assert.equal(protectedStatus.meta.daemonStartedAt, owner.startedAt)
    assert.equal(protectedStatus.meta.sessionCount, 1)
    assert.equal(protectedStatus.meta.privacy.applied, true)
    assert.equal(runtimeMismatch(owner.runtime, protectedStatus.meta.runtime), null)

    mcp = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    client = rpcClient(mcp)
    const throughMcp = await client.call('browser_page', { view: 'outline' })
    assert.equal(throughMcp.isError, false, JSON.stringify(throughMcp))
    assert.match(throughMcp.structuredContent.outline, /\[redacted\]/)
    assert.equal(throughMcp.structuredContent.privacy.applied, true)
    assert.equal(JSON.stringify(throughMcp).includes('secret-page-note'), false)
    const sessions = await client.call('browser_session_list')
    assert.equal(sessions.isError, false, JSON.stringify(sessions))

    await delay(50)
    const logs = (await readFile(join(directory, owner.logSession + '.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const statusLog = logs.filter((entry) => entry.cmd === 'status').at(-1)
    assert.deepEqual(statusLog.runtime, owner.runtime, 'the audit record preserves trusted process identity too')
    assert.equal(JSON.stringify(logs.filter((entry) => entry.cmd !== 'status')).includes('secret-page-note'), false)
  } finally {
    client?.close()
    await stopChild(mcp)
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await stopChild(daemon)
    }
    await rm(directory, { recursive: true, force: true })
  }
})
