import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { setTimeout as delayTimer, clearTimeout } from 'node:timers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const delay = (ms) => new Promise((done) => delayTimer(done, ms))
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

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

function mcpClient(child) {
  const pending = new Map()
  let nextId = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  return {
    call: (method, params = {}) => new Promise((resolveCall, reject) => {
      const id = ++nextId
      const timer = delayTimer(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out`))
      }, 40_000)
      timer.unref()
      pending.set(id, { resolve: resolveCall, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }),
    close: () => {
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      lines.close()
    },
  }
}

test('find preserves native select labels instead of substituting option text', { timeout: 60_000 }, async (t) => {
  const port = await freePort()
  assert.notEqual(port, 8377, 'never attach to the developer daemon')
  const temp = await mkdtemp(join(tmpdir(), 'snapsurf-select-names-'))
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_LOGDIR: temp, SNAPSURF_TOKEN: '', SNAPDOM_AGENT_TOKEN: '', SNAPSURF_TOKEN_FILE: join(temp, 'daemon.token') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const client = mcpClient(child)
  const call = (name, args = {}) => client.call('tools/call', { name, arguments: args })
  const ok = (result) => {
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.structuredContent
  }
  const find = async (text) => ok(await call('browser_find', { text })).matches
  const longLabel = 'Choose the billing plan for the entire design and engineering team in the current workspace — Renewal tier'
  const headline = 'This deliberately long article headline keeps its full rendered text available beyond the snapshot cap — Final detail'
  const fixture = `<!doctype html><style>select { display:block; width:280px; height:32px; margin:12px }</style>
    <label for="plan">Visible plan label</label><select id="plan" aria-label="Plan"><option>Choose plan</option><option selected>Basic</option><option>Professional plan</option><option>Team plan</option></select>
    <label for="region">Deployment region</label><select id="region"><option>North America</option><option>Europe</option><option>South America</option></select>
    <span id="billing-label">Billing cadence</span><select id="billing" aria-labelledby="billing-label"><option>Monthly payment</option><option>Annual payment</option></select>
    <label>Visible wrapper<select aria-label="Wrapped plan"><option>Starter package</option><option>Enterprise package</option></select></label>
    <select aria-label="${longLabel}"><option>Exclusive option text</option><option>Another exclusive option</option></select>
    <a href="#article">${headline}</a>`

  try {
    const initialized = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'select-names-test', version: '1' } })
    assert.ok(initialized.serverInfo, stderr)
    const opened = ok(await call('browser_open', { url: dataUrl(fixture) }))

    await t.test('ARIA labels, associated labels and labelledby stay consistent with the digest', async () => {
      for (const label of ['Plan', 'Deployment region', 'Billing cadence', 'Wrapped plan']) {
        const matches = await find(label)
        const select = matches.find((entry) => entry.role === 'combobox' && entry.name === label)
        assert.ok(select, JSON.stringify({ label, matches }))
        assert.equal(select.text, label)
        assert.notEqual(select.truncated, true)
        assert.ok(opened.digest.top.some((entry) => entry.id === select.id && entry.n === label), label)
      }
    })

    await t.test('role lookup keeps control labels and never substitutes the available choices', async () => {
      const matches = (await find('combobox')).filter((entry) => entry.role === 'combobox')
      assert.equal(matches.length, 5, JSON.stringify(matches))
      assert.deepEqual(new Set(matches.map((entry) => entry.name)), new Set(['Plan', 'Deployment region', 'Billing cadence', 'Wrapped plan', longLabel]))
      assert.equal(matches.some((entry) => /Professional plan|Exclusive option text/.test(entry.name)), false)
    })

    await t.test('long accessible labels remain searchable without matching unrelated option text', async () => {
      const matches = await find('Renewal tier')
      const select = matches.find((entry) => entry.role === 'combobox')
      assert.ok(select, JSON.stringify(matches))
      assert.equal(select.name, longLabel)
      assert.equal(select.text, longLabel)
      const optionMatches = await find('Exclusive option text')
      assert.equal(optionMatches.some((entry) => entry.role === 'combobox'), false, JSON.stringify(optionMatches))
    })

    await t.test('content-derived article names still recover text beyond the snapshot cap', async () => {
      const matches = await find('Final detail')
      const link = matches.find((entry) => entry.role === 'link')
      assert.ok(link, JSON.stringify(matches))
      assert.equal(link.name, headline)
      assert.equal(link.text, headline)
      assert.notEqual(link.truncated, true)
      const unchanged = ok(await call('browser_verify'))
      assert.equal(unchanged.changed, false, 'reading names must not mutate the page')
    })
  } finally {
    client.close()
    child.stdin.end()
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(temp, { recursive: true, force: true })
  }
})
