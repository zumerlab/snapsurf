import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function deadline(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// npm may have a shell and the MCP below it. Reap the whole test-owned group on
// failure, so a failed assertion cannot leave an MCP server waiting on stdin.
function killLaunch(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* already exited */ }
}

test('plugin starts from a checkout with the same npm package name and version', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapsurf-plugin-launch-'))
  const checkout = join(directory, 'checkout')
  const packageRoot = join(directory, 'package')
  const daemonMarker = join(directory, 'daemon-started')
  const npmrc = join(directory, 'empty.npmrc')
  const globalNpmrc = join(directory, 'global.npmrc')
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(join(ROOT, 'plugins', 'snapsurf', '.mcp.json'), 'utf8')).snapsurf
  const packageJson = {
    name: manifest.name,
    version: manifest.version,
    type: 'module',
    bin: { 'snapsurf-mcp': './mcp/server.mjs' },
  }
  const requests = []
  let server
  let child
  try {
    await mkdir(checkout)
    await mkdir(join(packageRoot, 'mcp'), { recursive: true })
    await mkdir(join(packageRoot, 'tools'))
    await writeFile(npmrc, '')
    await writeFile(globalNpmrc, '')
    // The checkout deliberately has no self-bin in node_modules/.bin: npm's bare
    // --package matches this root package but does not create its executable link.
    await writeFile(join(checkout, 'package.json'), JSON.stringify(packageJson))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(packageJson))
    await writeFile(join(packageRoot, 'mcp', 'server.mjs'), await readFile(join(ROOT, 'mcp', 'server.mjs')), { mode: 0o755 })
    await writeFile(join(packageRoot, 'tools', 'browse.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(daemonMarker)}, 'unexpected daemon startup')`,
      'process.exit(99)',
    ].join('\n'))
    const archivePath = join(directory, 'snapsurf.tgz')
    execFileSync('tar', ['-czf', archivePath, '-C', directory, 'package'])
    const archive = await readFile(archivePath)
    let registryUrl
    server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      requests.push(pathname)
      if (pathname === '/' + manifest.name) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...packageJson,
              dist: {
                tarball: registryUrl + '/snapsurf.tgz',
                integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
              },
            },
          },
        }))
      } else if (pathname === '/snapsurf.tgz') {
        response.setHeader('content-type', 'application/octet-stream')
        response.end(archive)
      } else {
        response.writeHead(404)
        response.end('unexpected request')
      }
    })
    await new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    const port = server.address().port
    assert.notEqual(port, 8377, 'the launch test must never address the live daemon')
    registryUrl = `http://127.0.0.1:${port}`
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^npm_config_/i.test(key)) delete env[key]
    }
    Object.assign(env, {
      npm_config_registry: registryUrl,
      npm_config_cache: join(directory, 'npm-cache'),
      npm_config_userconfig: npmrc,
      npm_config_globalconfig: globalNpmrc,
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_fetch_retries: '0',
      SNAPSURF_PORT: String(port),
      SNAPSURF_TOKEN: 'isolated-plugin-launch-test',
      SNAPSURF_TOKEN_FILE: join(directory, 'daemon.token'),
      SNAPSURF_LOGDIR: join(directory, 'daemon-logs'),
    })
    child = spawn(plugin.command, plugin.args, {
      cwd: checkout,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stdin.on('error', () => {})
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]()
    const rpc = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      const line = await deadline(lines.next(), 20_000, `plugin did not reply to ${method}: ${stderr}`)
      assert.equal(line.done, false, `plugin closed before ${method}: ${stderr}`)
      const message = JSON.parse(line.value)
      assert.equal(message.jsonrpc, '2.0')
      assert.equal(message.id, id)
      assert.equal(message.error, undefined)
      return message.result
    }
    const initialized = await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'plugin-launch-regression', version: '1' },
    })
    assert.equal(initialized.protocolVersion, '2025-06-18')
    assert.equal(initialized.serverInfo.name, 'snapsurf')
    assert.equal(initialized.serverInfo.version, manifest.version)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listed = await rpc(2, 'tools/list', {})
    assert.ok(listed.tools.some((tool) => tool.name === 'browser_open'))
    assert.ok(listed.tools.some((tool) => tool.name === 'browser_text'))
    child.stdin.end()
    assert.deepEqual(await deadline(exited, 5000, 'plugin did not exit after EOF'), { code: 0, signal: null })
    child = null
    assert.equal(stdout.trim().split('\n').length, 2, 'stdout must contain only the two MCP replies')
    assert.match(stderr, /ready \(stdio\)/)
    assert.doesNotMatch(stderr, /spawning daemon|Chromium/)
    await assert.rejects(stat(daemonMarker), { code: 'ENOENT' })
    assert.ok(requests.includes('/snapsurf.tgz'), 'the fixture must exercise npm installation and bin creation')
    assert.ok(requests.every((path) => path === '/' + manifest.name || path === '/snapsurf.tgz'),
      `initialize and tools/list must not contact a daemon: ${requests.join(', ')}`)
  } finally {
    killLaunch(child)
    if (server) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
    await rm(directory, { recursive: true, force: true })
  }
})
