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
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('field feedback: useful search context and bounded embedded destinations', { timeout: 120_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'snapsurf-feedback-search-'))
  let html = ''
  const fixture = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html) })
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${fixture.address().port}/`
  const reserve = createServer()
  await new Promise((done) => reserve.listen(0, '127.0.0.1', done))
  const port = reserve.address().port
  await new Promise((done) => reserve.close(done))
  assert.notEqual(port, 8377)
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_LOGDIR: temp, SNAPSURF_TOKEN: '', SNAPDOM_AGENT_TOKEN: '', SNAPSURF_TOKEN_FILE: join(temp, 'daemon.token') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)))
    else handler.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++nextId
    pending.set(id, { resolve: resolveCall, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const tool = (name, args = {}) => call('tools/call', { name, arguments: args })
  const ok = (result) => {
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.structuredContent
  }
  const open = async (body, args = {}) => {
    html = '<!doctype html><meta charset="utf-8">' + body
    return ok(await tool('browser_open', { url, ...args }))
  }
  const find = async (text, args = {}) => ok(await tool('browser_find', { text, ...args }))
  try {
    assert.ok((await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'feedback-search-test', version: '1' } })).serverInfo, stderr)

    await t.test('whole words and phrases outrank accidental actionable substrings', async () => {
      await open('<main><button>Copy results as markdown</button><h1>Run on your own hardware</h1><p>This owns no external data.</p><button>Remove</button><button>Remove</button></main>')
      const found = await find('own')
      const heading = found.matches.findIndex((m) => m.role === 'heading')
      const accidental = found.matches.findIndex((m) => m.name === 'Copy results as markdown')
      assert.ok(heading >= 0 && accidental > heading, JSON.stringify(found.matches))
      assert.equal((await find('Remove')).matches.filter((m) => m.role === 'button').length, 2)
      await open('<main><button>Export local projectsarchive</button><h2>About LOCAL   PROJECTS</h2></main>')
      assert.equal((await find('local projects')).matches[0].role, 'heading')
    })

    await t.test('the local section receives context before main without ancestor duplication', async () => {
      await open('<main><p>Introductory general documentation of other events and permissions. This opening text is unrelated background.</p><section><h2>Availability for star</h2><p>Stars can be observed by the supported event subscriptions. ' + 'Relevant details. '.repeat(35) + '</p></section><p>' + 'Other event instructions. '.repeat(100) + '</p></main>')
      const found = await find('Availability for star', { contextChars: 800 })
      const local = found.matches.find((m) => m.role === 'generic' && m.context)
      assert.ok(local, JSON.stringify(found))
      assert.match(local.context.text, /Stars can be observed/)
      assert.equal(local.context.truncated, false)
      const main = found.matches.find((m) => m.role === 'main')
      assert.equal(main.context, undefined)
      assert.equal(main.contextOmittedReason, 'overlap')
      assert.equal(main.contextCoveredBy, local.id)
      const heading = found.matches.find((m) => m.role === 'heading')
      assert.equal(heading.contextCoveredBy, local.id)
      const contexts = found.matches.filter((m) => m.context)
      assert.equal(found.contextCharsReturned, contexts.reduce((sum, m) => sum + m.context.returnedChars, 0))
      assert.equal(found.contextMatchesOmitted, found.matches.length - contexts.length)
      assert.ok(found.contextCharsReturned <= 800)
    })

    await t.test('display:contents wrappers remain readable after unchanged observations', async () => {
      await open('<main><div style="display:contents"><p>DS718+ supported device.</p><p>Additional inner support notes.</p></div><p>Outer tail content.</p></main>')
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = await find('DS718+', { contextChars: 2400 })
        assert.equal(found.matches.some((m) => m.contextError), false, JSON.stringify(found))
        const wrapper = found.matches.find((m) => m.role === 'generic' && m.name.includes('Additional inner'))
        assert.ok(wrapper)
        const text = ok(await tool('browser_text', { id: wrapper.id }))
        assert.equal(text.text, 'DS718+ supported device. Additional inner support notes.')
        assert.equal(ok(await tool('browser_verify')).changed, false)
      }
    })

    await t.test('shared truncated name prefixes do not erase the useful local section', async () => {
      await open('<main><section><h2>Availability for star</h2><p>' + 'Relevant details. '.repeat(35) + '</p></section><p>' + 'Other event instructions. '.repeat(100) + '</p></main>')
      const found = await find('Availability for star', { contextChars: 800 })
      const local = found.matches.find((m) => m.role === 'generic' && m.context)
      assert.ok(local, JSON.stringify(found))
      assert.equal(local.context.truncated, false)
      assert.equal(found.matches.find((m) => m.role === 'main').context, undefined)
    })

    await t.test('context allocation retains query relevance with a tiny budget', async () => {
      await open('<nav><a href="#">PostgreSQL</a></nav><section><h2>SQL</h2><p>' + 'SQL explanation. '.repeat(20) + '</p></section>')
      const found = await find('SQL', { contextChars: 10 })
      assert.equal(found.matches.find((m) => m.name === 'PostgreSQL').context, undefined)
      const context = found.matches.find((m) => m.context)?.context
      assert.ok(context)
      assert.equal(context.text, 'SQL explan')
      for (const match of found.matches.filter((m) => m.contextCoveredBy)) {
        assert.ok(found.matches.find((m) => m.id === match.contextCoveredBy)?.context)
      }
    })

    await t.test('late article matches receive nearby frozen context and honest offsets', async () => {
      const article = 'Unrelated introduction. '.repeat(180) + 'cancel() Cancels the animation and restores the original styles. ' + 'Further notes. '.repeat(80)
      await open('<main><article><p>' + article + '</p></article></main>')
      const found = await find('cancel()', { contextChars: 230 })
      const match = found.matches.find((m) => m.context)
      assert.ok(match, JSON.stringify(found))
      const context = match.context
      assert.match(context.text, /cancel\(\) Cancels the animation and restores the original styles/)
      assert.ok(context.offset > 0)
      assert.equal(context.prefixOmittedChars, context.offset)
      assert.equal(context.text, article.trim().slice(context.offset, context.offset + context.returnedChars))
      assert.ok(found.contextCharsReturned <= 230)
      assert.equal(context.truncated, true)
      const next = ok(await tool('browser_text', context.continuation))
      assert.equal(next.offset, context.offset + context.returnedChars)
      assert.equal(next.capturedAt, context.capturedAt)
      assert.equal(next.text, article.trim().slice(next.offset, next.offset + next.returnedChars))
      const beginning = ok(await tool('browser_text', { id: match.id, maxChars: 60 }))
      assert.equal(beginning.offset, 0)
      assert.equal(beginning.text, article.slice(0, 60))
      assert.equal(beginning.capturedAt, context.capturedAt)
    })

    await t.test('data href payloads stay out of observations and have frozen bounded recovery', async () => {
      const href = 'data:image/png;base64,' + 'Q'.repeat(10000)
      const opened = await open(`<main><a id="embedded" href="${href}">Calendar image resource</a><a href="https://example.com/path?full=value#target">Ordinary destination</a><button onclick="embedded.href='data:image/png;base64,changed'">Replace resource</button></main>`)
      const entry = opened.digest.top.find((m) => m.n === 'Calendar image resource')
      assert.equal(entry.href, null)
      assert.equal(entry.resource.mimeType, 'image/png')
      assert.equal(entry.resource.encodedChars, href.length)
      assert.equal(entry.resource.payloadOmitted, true)
      assert.ok(JSON.stringify(opened).length < 15000)
      assert.equal(JSON.stringify(opened).includes('Q'.repeat(100)), false)
      assert.equal(opened.digest.top.find((m) => m.n === 'Ordinary destination').href, 'https://example.com/path?full=value#target')
      const found = await find('Calendar image resource')
      const resource = found.matches.find((m) => m.role === 'link').resource
      const first = ok(await tool('browser_text', { ...resource.recovery, maxChars: 64 }))
      assert.equal(first.text, href.slice(0, 64))
      assert.equal(first.returnedChars, 64)
      assert.equal(first.continuation.source, 'href')
      assert.equal(first.observationId, opened.observationId)
      let full = first.text
      let chunk = first
      while (chunk.continuation) {
        chunk = ok(await tool('browser_text', { ...chunk.continuation, maxChars: 3000 }))
        assert.equal(chunk.capturedAt, first.capturedAt)
        full += chunk.text
      }
      assert.equal(full, href)
      const verified = ok(await tool('browser_verify'))
      assert.equal(verified.changed, false)
      assert.equal(JSON.stringify(verified).includes('Q'.repeat(100)), false)
      assert.equal((await tool('browser_text', first.continuation)).isError, true)
      const replace = (await find('Replace resource')).matches.find((m) => m.role === 'button')
      ok(await tool('browser_act', { action: 'click', target: replace.id }))
      const changed = ok(await tool('browser_verify'))
      assert.equal(JSON.stringify(changed).includes('Q'.repeat(100)), false)
    })

    await t.test('embedded payload recovery cannot bypass an active privacy policy', async () => {
      const secret = 'private account content'
      const encoded = Buffer.from(secret).toString('base64')
      const opened = await open(`<a href="data:text/plain;base64,${encoded}">Encoded resource</a><a href="data:text/plain,private%20account%20content">Plain private resource</a>`, { redact: [secret] })
      const entry = opened.digest.top.find((m) => m.n === 'Encoded resource')
      const denied = await tool('browser_text', entry.resource.recovery)
      assert.equal(denied.isError, true)
      assert.match(JSON.stringify(denied), /privacy rules are active/)
      const redacted = opened.digest.top.find((m) => m.n === 'Plain private resource')
      assert.equal(redacted.href, '[redacted]')
      assert.equal(redacted.resource, undefined)
      assert.equal(JSON.stringify(opened).includes(encoded), false)
      await open('<p>Privacy cleared</p>', { redact: [] })
    })

    await t.test('URL-normalized data schemes cannot bypass payload bounds or privacy', async () => {
      const payload = Buffer.from('private payload '.repeat(1000)).toString('base64')
      const normalized = 'data:text/plain;base64,' + payload
      const variants = [' \n' + normalized, 'd\ta\nt\ra:text/plain;base64,' + payload]
      for (const href of variants) {
        const opened = await open(`<main><a href="${href}">Whitespace resource</a></main>`)
        const entry = opened.digest.top.find((m) => m.n === 'Whitespace resource')
        assert.equal(entry.href, null)
        assert.equal(entry.resource.mimeType, 'text/plain')
        assert.equal(entry.resource.encodedChars, normalized.length)
        assert.equal(JSON.stringify(opened).includes(payload.slice(0, 100)), false)
        const found = await find('Whitespace resource')
        const match = found.matches.find((m) => m.role === 'link')
        assert.equal(match.href, null)
        assert.equal(JSON.stringify(found).includes(payload.slice(0, 100)), false)
        const chunk = ok(await tool('browser_text', { ...match.resource.recovery, maxChars: 64 }))
        assert.equal(chunk.text, normalized.slice(0, 64))
        const protectedPage = await open(`<main><a href="${href}">Whitespace resource</a></main>`, { redact: ['private payload'] })
        const protectedLink = protectedPage.digest.top.find((m) => m.n === 'Whitespace resource')
        assert.equal(protectedLink.href, null)
        const denied = await tool('browser_text', protectedLink.resource.recovery)
        assert.equal(denied.isError, true)
        assert.match(JSON.stringify(denied), /privacy rules are active/)
        await open('<p>Privacy cleared</p>', { redact: [] })
      }
    })
  } finally {
    lines.close()
    child.stdin.end()
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise((done) => fixture.close(done))
    await rm(temp, { recursive: true, force: true })
  }
})
