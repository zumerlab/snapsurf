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
const dataUrl = (html) => `data:text/html,${encodeURIComponent(html)}`
const LONG_ROUTE_TEXT = 'Route evidence paragraph. '.repeat(90)

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
    close: () => lines.close(),
  }
}

test('bounded, observation-pinned text reading through real MCP and browser', { timeout: 180_000 }, async (t) => {
  const port = await freePort()
  assert.notEqual(port, 8377)
  const temp = await mkdtemp(join(tmpdir(), 'snapsurf-long-reading-'))
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
  const open = async (html, args = {}) => ok(await call('browser_open', { url: dataUrl(html), ...args }))
  const find = async (text, args = {}) => ok(await call('browser_find', { text, ...args }))
  const read = async (id, args = {}) => ok(await call('browser_text', { id, ...args }))
  const sectionText = ['Research chapter. ' + 'First paragraph evidence. '.repeat(140), 'Second paragraph details. '.repeat(130), 'Reference link'].join(' ').replace(/\s+/g, ' ').trim()
  const section = `<!doctype html><main aria-label="Research chapter"><p>${'Research chapter. ' + 'First paragraph evidence. '.repeat(140)}</p><p>${'Second paragraph details. '.repeat(130)}</p><a href="https://example.com/reference">Reference link</a></main>`

  try {
    const initialized = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'long-reading-test', version: '1' } })
    assert.ok(initialized.serverInfo, stderr)

    await t.test('reads a multi-paragraph section completely through direct continuations', async () => {
      const sessionId = ok(await call('browser_session_open')).sessionId
      const opened = await open(section, { sessionId })
      const id = opened.digest.marks.find((m) => m.r === 'main').id
      const compactResult = await call('browser_text', { id, sessionId })
      const compact = ok(compactResult)
      assert.match(compactResult.content[0].text, /continue with browser_text/)
      assert.doesNotMatch(compactResult.content[0].text, /continue: text|--session/)
      assert.equal(compact.text.length, 600)
      assert.equal(compact.truncated, true)
      assert.equal(compact.offset, 0)
      assert.equal(compact.totalChars, sectionText.length)
      assert.equal(compact.observationId, opened.observationId)
      assert.equal(compact.continuation.sessionId, sessionId)
      let chunk = await read(id, { sessionId, maxChars: 3000 })
      const capturedAt = chunk.capturedAt
      let full = chunk.text
      while (chunk.continuation) {
        chunk = ok(await call('browser_text', chunk.continuation))
        assert.equal(chunk.capturedAt, capturedAt)
        assert.equal(chunk.observationId, opened.observationId)
        full += chunk.text
      }
      assert.equal(full, sectionText)
      assert.equal(chunk.truncated, false)
      assert.equal(chunk.nextOffset, null)
      const end = await read(id, { sessionId, offset: sectionText.length, observationId: opened.observationId })
      assert.equal(end.text, '')
      assert.equal(end.totalChars, sectionText.length)
      assert.equal(end.truncated, false)
      const unchanged = ok(await call('browser_verify', { sessionId }))
      assert.equal(unchanged.changed, false, 'reads must not consume the observation baseline')
      assert.equal((await call('browser_text', compact.continuation)).isError, true, 'new observation expires continuation')
      ok(await call('browser_session_close', { sessionId }))
    })

    await t.test('find context has one total budget and directly continues its final match', async () => {
      await open(section)
      const compact = await find('First paragraph evidence')
      assert.ok(compact.matches.length)
      assert.equal(compact.matches[0].context, undefined)
      const foundResult = await call('browser_find', { text: 'First   paragraph evidence', contextChars: 3000 })
      const result = ok(foundResult)
      assert.match(foundResult.content[0].text, /continue with browser_text/)
      assert.doesNotMatch(foundResult.content[0].text, /continue: text|--session/)
      const contexts = result.matches.filter((m) => m.context).map((m) => m.context)
      assert.equal(result.contextCharsReturned, 3000)
      assert.equal(contexts.reduce((sum, c) => sum + c.text.length, 0), 3000)
      assert.equal(result.contextMatchesOmitted, result.matches.length - contexts.length)
      const first = contexts[0]
      assert.equal(first.truncated, true)
      const rest = ok(await call('browser_text', first.continuation))
      assert.equal(rest.offset, 3000)
      assert.equal(rest.capturedAt, first.capturedAt)
      assert.ok((first.text + rest.text).includes('First paragraph evidence.'))
    })

    await t.test('background mutations cannot splice a frozen text read', async () => {
      const opened = await open(`<!doctype html><main><p id="article"></p></main><script>
        let version = 0;
        function update() { article.textContent = ('Background version ' + (++version) + '. ').repeat(180) }
        update(); setInterval(update, 400);
      </script>`)
      const id = opened.digest.marks.find((m) => m.r === 'main').id
      const first = await read(id, { maxChars: 600 })
      const version = first.text.match(/Background version (\d+)/)[1]
      await delay(900)
      const rest = ok(await call('browser_text', { ...first.continuation, maxChars: 12000 }))
      assert.equal(first.text + rest.text, (`Background version ${version}. `).repeat(180).trim())
      assert.equal(rest.capturedAt, first.capturedAt)
      ok(await call('browser_verify'))
      assert.equal((await call('browser_text', first.continuation)).isError, true)
    })

    await t.test('rejects unsafe ranges, wrong observations, other sessions and navigation', async () => {
      const opened = await open(section)
      const id = opened.digest.marks.find((m) => m.r === 'main').id
      const first = await read(id)
      for (const extra of [{ maxChars: 0 }, { maxChars: 12001 }, { maxChars: 3.5 }, { offset: -1 }, { offset: 2 }, { offset: 2, observationId: 'o_wrong' }, { offset: sectionText.length + 1, observationId: first.observationId }]) {
        assert.equal((await call('browser_text', { id, ...extra })).isError, true, JSON.stringify(extra))
      }
      const otherSession = ok(await call('browser_session_open')).sessionId
      await open(section, { sessionId: otherSession })
      assert.equal((await call('browser_text', { ...first.continuation, sessionId: otherSession })).isError, true)
      ok(await call('browser_session_close', { sessionId: otherSession }))
      await open('<p>Another document</p>')
      assert.equal((await call('browser_text', first.continuation)).isError, true)
      assert.equal((await call('browser_find', { text: 'Another', contextChars: 12001 })).isError, true)
    })

    await t.test('same-document route changes expire global and scoped text snapshots', async () => {
      for (const method of ['pushState', 'replaceState']) {
        await open(`<!doctype html><main><a href="#source">${LONG_ROUTE_TEXT}</a></main><button onclick="setTimeout(() => history.${method}({}, '', '#another-route'), 2500)">Schedule route change</button>`)
        const button = (await find('Schedule route change')).matches.find((m) => m.role === 'button')
        ok(await call('browser_act', { action: 'click', target: button.id }))
        const verified = ok(await call('browser_verify'))
        const mainId = verified.digest.marks.find((m) => m.r === 'main').id
        const first = await read(mainId)
        const scoped = ok(await call('browser_page', { view: 'zoom', id: mainId }))
        const scopedId = scoped.map.find((m) => m.r === 'link')?.id
        assert.ok(scopedId)
        const scopedRead = await read(scopedId)
        await delay(2700)
        const expired = await call('browser_text', first.continuation)
        assert.equal(expired.isError, true)
        assert.match(JSON.stringify(expired), /observation URL changed/)
        assert.equal((await call('browser_text', scopedRead.continuation)).isError, true)
        ok(await call('browser_verify'))
      }
    })

    await t.test('privacy changes cannot resurrect cached unredacted text', async () => {
      const opened = await open(section)
      const id = opened.digest.marks.find((m) => m.r === 'main').id
      const first = await read(id)
      const redacted = await open(section, { redact: ['evidence'] })
      assert.equal((await call('browser_text', first.continuation)).isError, true)
      const safe = await read(redacted.digest.marks.find((m) => m.r === 'main').id, { maxChars: 12000 })
      assert.equal(JSON.stringify(safe).includes('evidence'), false)
      assert.equal(safe.text, '[redacted]')
      await open('<p>Privacy cleared</p>', { redact: [] })
    })

    await t.test('declares cache capacity instead of silently shortening a huge section', async () => {
      const opened = await open(`<main>${'A'.repeat(1_000_001)}</main>`)
      const id = opened.digest.marks.find((m) => m.r === 'main').id
      const refused = await call('browser_text', { id, maxChars: 3000 })
      assert.equal(refused.isError, true)
      assert.match(JSON.stringify(refused), /text snapshot budget exhausted/)
    })
  } finally {
    client.close()
    child.stdin.end()
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(temp, { recursive: true, force: true })
  }
})
