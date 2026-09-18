import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { setTimeout, clearTimeout } from 'node:timers'

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = (server) => new Promise((resolve) => server.close(resolve))
const hmac = (token, text) => createHmac('sha256', token).update(text).digest('hex')
const wall = "<h1>You've been blocked by network security.</h1><p>To continue, log in to your Reddit account or use your developer token.</p><a href='/ticket'>File a ticket</a>"
const style = '<style>body{margin:0;font:16px sans-serif}button{font:inherit}#result{position:fixed;top:0;right:0}</style>'
const pages = {
  '/horizontal': `${style}<div style="width:180px;overflow-x:auto;margin-top:70px"><div style="width:1000px"><button style="margin-left:750px" onclick="result.textContent='Horizontal reached'">Horizontal target</button></div></div><p id="result">Idle</p>`,
  '/tall': `${style}<div role="button" aria-label="Tall target" tabindex="0" style="margin-top:100px;width:220px;height:1700px;background:#eee" onclick="result.textContent='Tall reached'">Tall target</div><p id="result">Idle</p>`,
  '/partial': `${style}<div style="position:relative;top:70px;width:180px;height:60px;overflow:clip"><button style="position:absolute;left:150px;width:300px;height:50px" onclick="result.textContent='Partial reached'">Partial target</button></div><p id="result">Idle</p>`,
  '/slotted': `${style}<slot-action><span style="display:block;width:180px;height:80px;background:#ddd">Slotted target</span></slot-action><p id="result">Idle</p><script>customElements.define('slot-action',class extends HTMLElement{connectedCallback(){const shadow=this.attachShadow({mode:'open'});shadow.innerHTML='<button aria-label="Slotted target" style="padding:0;border:0"><slot></slot></button>';shadow.querySelector('button').onclick=()=>document.querySelector('#result').textContent='Slotted reached'}})</script>`,
  '/clipped': `${style}<div style="position:relative;top:70px;width:180px;height:60px;overflow:clip"><button style="position:absolute;left:220px;width:140px;height:50px" onclick="result.textContent='Wrong click'">Clipped target</button></div><p id="result">Idle</p>`,
  '/fixed': `${style}<button style="position:fixed;left:750px;top:70px" onclick="result.textContent='Wrong click'">Fixed target</button><p id="result">Idle</p>`,
  '/covered': `${style}<button style="position:absolute;left:20px;top:70px" onclick="result.textContent='Wrong click'">Covered target</button><div style="position:fixed;inset:0;background:#ddd;z-index:9">Covering overlay</div><p id="result">Idle</p>`,
  '/wall': `<title>Reddit</title>${wall}`,
  '/article': `<title>Understanding access errors</title><article><h1>Understanding website access</h1><p>The following is an example of an error message, discussed in this article.</p><blockquote>${wall}</blockquote><p>Read the support documentation for an explanation.</p></article>`,
  '/links': '<main><h1>Many links</h1>' + Array.from({ length: 43 }, (_, i) => `<a href="/docs/${i}?edition=public#part">Document ${i}</a>`).join(' ') + '</main>',
  '/data': '<a download="sample.png" href="data:image/png;base64,' + 'A'.repeat(12000) + '">Download sample</a>',
}

test('field feedback contracts: navigation, sessions, maps and reachable clicks', { timeout: 90_000 }, async (t) => {
  const reserve = createServer()
  const port = await listen(reserve)
  await close(reserve)
  assert.notEqual(port, 8377)
  const runtime = await mkdtemp(join(tmpdir(), 'snapsurf-feedback-contract-'))
  const token = randomBytes(32).toString('hex')
  const site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8">' + (pages[req.url] || '<h1>Fixture home</h1>'))
  })
  const base = `http://127.0.0.1:${await listen(site)}`
  const env = { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_TOKEN: token, SNAPSURF_TOKEN_FILE: join(runtime, 'token'), SNAPSURF_LOGDIR: runtime, SNAPSURF_OPEN_WATCH_MS: '0' }
  const daemon = spawn(process.execPath, ['tools/browse.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  daemon.stdout.on('data', (chunk) => { logs += chunk })
  daemon.stderr.on('data', (chunk) => { logs += chunk })
  const post = async (cmd, args = [], sessionId) => {
    const body = JSON.stringify({ cmd, args, envelope: true, sessionId })
    const nonce = randomBytes(16).toString('hex')
    const reply = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, { method: 'POST', body, headers: {
      'content-type': 'application/json', 'x-snapdom-nonce': nonce, 'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`),
    } })
    const wire = await reply.text()
    assert.equal(reply.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${wire}`))
    return JSON.parse(wire)
  }
  let mcp, lines
  try {
    let ready = false
    for (let i = 0; i < 200; i++) {
      try { if ((await post('status')).ok) { ready = true; break } } catch { /* starting */ }
      await delay(100)
    }
    assert.equal(ready, true, logs)
    await t.test('new session reports its own blank page and counter', async () => {
      const opened = await post('open', [base + '/links'])
      assert.equal(opened.ok, true)
      const created = await post('session', ['open'])
      assert.equal(created.sessionId, created.meta.sessionId)
      assert.notEqual(created.sessionId, opened.sessionId)
      assert.equal(created.epoch, 0)
      assert.equal(created.url, 'about:blank')
      assert.equal(created.meta.epoch, 0)
      assert.equal(created.meta.url, 'about:blank')
      assert.equal(typeof opened.meta.runtime.version, 'string')
      assert.equal(typeof created.meta.runtime.build, 'string')
      await post('session', ['close', created.sessionId])
    })
    await t.test('map supplies complete structured hrefs and explicit pagination including exhausted pages', async () => {
      const opened = await post('open', [base + '/links'])
      const first = await post('map')
      assert.equal(first.meta.observationId, opened.meta.observationId)
      assert.equal(first.meta.total, 43)
      assert.equal(first.meta.returned, 40)
      assert.equal(first.meta.nextOffset, 40)
      assert.equal(first.meta.map[0].href, base + '/docs/0?edition=public#part')
      const last = await post('map', ['40'])
      assert.equal(last.meta.returned, 3)
      assert.equal(last.meta.nextOffset, null)
      assert.equal(last.meta.map[2].href, base + '/docs/42?edition=public#part')
      const end = await post('map', ['99'])
      assert.deepEqual(end.meta.map, [])
      assert.equal(end.meta.offset, 99)
      assert.equal(end.meta.total, 43)
      assert.equal(end.meta.nextOffset, null)
      await post('open', [base + '/empty'])
      assert.equal((await post('map')).meta.total, 0)
    })
    await t.test('map uses bounded data URL summaries with recovery metadata', async () => {
      await post('open', [base + '/data'])
      const map = await post('map')
      assert.equal(map.ok, true, map.error)
      assert.equal(map.meta.map[0].href, null)
      assert.equal(map.meta.map[0].resource.payloadOmitted, true)
      assert.equal(map.meta.map[0].resource.recovery.source, 'href')
      assert.ok(JSON.stringify(map).length < 6000)
    })
    await t.test('TLS failure cannot claim a prior final destination or success', async () => {
      const prior = await post('open', [base + '/links'])
      const failed = await post('open', [base.replace('http:', 'https:') + '/tls'])
      assert.equal(failed.ok, false)
      assert.equal(failed.meta.failure.layer, 'tls')
      assert.equal(failed.meta.failure.code, 'ERR_SSL_PROTOCOL_ERROR')
      assert.equal(failed.meta.navigationCompleted, false)
      assert.equal(failed.meta.finalUrl, null)
      assert.equal(failed.meta.redirectChainAvailable, false)
      assert.equal(failed.meta.baselineAdvanced, false)
      assert.equal(failed.epoch, prior.epoch)
      assert.equal(failed.meta.retainedUrl, base + '/links')
    })
    await t.test('HTTP 200 network-security wall is blocked; quoted article remains readable', async () => {
      const blocked = await post('open', [base + '/wall'])
      assert.equal(blocked.meta.blocked, true)
      assert.equal(blocked.meta.challenge.status, 200)
      assert.equal(blocked.meta.challenge.vendor, 'unknown')
      assert.equal(blocked.meta.challenge.reason, 'network_security_wall')
      const article = await post('open', [base + '/article'])
      assert.equal(article.ok, true)
      assert.equal(article.meta.blocked, undefined)
    })
    const mobile = (await post('session', ['open', '--json', JSON.stringify({ viewport: { width: 390, height: 844 } })])).sessionId
    for (const [route, name, result] of [['horizontal', 'Horizontal target', 'Horizontal reached'], ['tall', 'Tall target', 'Tall reached'], ['partial', 'Partial target', 'Partial reached'], ['slotted', 'Slotted target', 'Slotted reached']]) {
      await t.test(`click ${route} chooses a reachable point inside the viewport`, async () => {
        assert.equal((await post('open', [base + '/' + route], mobile)).ok, true)
        const found = await post('find', [name], mobile)
        const target = found.meta.matches.find((match) => match.role === 'button' && match.name === name)
        assert.ok(target, JSON.stringify(found))
        const clicked = await post('click', [target.id], mobile)
        assert.equal(clicked.ok, true, JSON.stringify(clicked))
        assert.ok(clicked.meta.resolved.x >= 0 && clicked.meta.resolved.x < 390)
        assert.ok(clicked.meta.resolved.y >= 0 && clicked.meta.resolved.y < 844)
        const verified = await post('look', [], mobile)
        assert.equal(verified.meta.changed, true)
        const observed = await post('assert', [JSON.stringify({ exists: result })], mobile)
        assert.equal(observed.meta.assert.pass, true, JSON.stringify(observed))
      })
    }
    for (const [route, name, denied] of [['clipped', 'Clipped target', 'offscreen'], ['fixed', 'Fixed target', 'offscreen'], ['covered', 'Covered target', 'covered']]) {
      await t.test(`click ${route} fails loudly without hitting another element`, async () => {
        await post('open', [base + '/' + route], mobile)
        const found = await post('find', [name], mobile)
        const target = found.meta.matches.find((match) => match.role === 'button' && match.name === name)
        assert.ok(target, JSON.stringify(found))
        const clicked = await post('click', [target.id], mobile)
        assert.equal(clicked.ok, false, JSON.stringify(clicked))
        assert.equal(clicked.meta.denied, denied)
        const verified = await post('look', [], mobile)
        assert.equal(verified.meta.changed, false, JSON.stringify(verified))
      })
    }
    await post('session', ['close', mobile])
    await t.test('MCP preserves typed navigation failure and coherent session/runtime metadata', async () => {
      mcp = spawn(process.execPath, ['mcp/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      mcp.stderr.on('data', (chunk) => { logs += chunk })
      const pending = new Map()
      let seq = 0
      lines = createInterface({ input: mcp.stdout })
      lines.on('line', (line) => {
        let message
        try { message = JSON.parse(line) } catch { return }
        const waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        clearTimeout(waiter.timeout)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      })
      const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + logs)) }, 15000)
        pending.set(id, { resolve, reject, timeout })
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'feedback-contract-test', version: '1' } })
      const tool = (name, args = {}) => call('tools/call', { name, arguments: args })
      const created = await tool('browser_session_open')
      assert.equal(created.isError, false, JSON.stringify(created))
      assert.equal(created.structuredContent.epoch, 0)
      assert.equal(created.structuredContent.url, 'about:blank')
      assert.equal(typeof created.structuredContent.runtime.build, 'string')
      const sessionId = created.structuredContent.sessionId
      const opened = await tool('browser_open', { sessionId, url: base + '/links' })
      assert.equal(typeof opened.structuredContent.runtime.version, 'string')
      const failed = await tool('browser_open', { sessionId, url: base.replace('http:', 'https:') + '/tls' })
      assert.equal(failed.isError, true)
      assert.equal(failed.structuredContent.ok, false)
      assert.equal(failed.structuredContent.failure.layer, 'tls')
      assert.equal(failed.structuredContent.finalUrl, null)
      assert.equal(failed.structuredContent.retainedUrl, base + '/links')
      await tool('browser_session_close', { sessionId })
    })
  } finally {
    lines?.close()
    if (mcp) { mcp.stdin.end(); for (let i = 0; i < 20 && mcp.exitCode === null; i++) await delay(50); if (mcp.exitCode === null) mcp.kill('SIGTERM') }
    try { await post('stop') } catch { /* already stopped */ }
    for (let i = 0; i < 50 && daemon.exitCode === null; i++) await delay(100)
    if (daemon.exitCode === null) daemon.kill('SIGTERM')
    await close(site)
    await rm(runtime, { recursive: true, force: true })
  }
})
