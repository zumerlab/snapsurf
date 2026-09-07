import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const hmac = (token, value) => createHmac('sha256', token).update(value).digest('hex')
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = (server) => new Promise((resolve) => server.close(resolve))

test('complete navigation links, observed redirects and PDF handoff through the daemon', { timeout: 90_000 }, async (t) => {
  const reserve = createServer()
  const port = await listen(reserve)
  await close(reserve)
  assert.notEqual(port, 8377)
  const runtime = await mkdtemp(join(tmpdir(), 'snapsurf-navigation-'))
  const token = randomBytes(32).toString('hex')
  const longPath = '/reports/' + 'intangible-transfer-'.repeat(12) + 'report.pdf?download=complete#page=3'
  const page = `<!doctype html><title>Document source</title><main><h1>Research documents</h1>
    <a href="${longPath}" type="application/pdf">The complete intangible technology transfer report</a>
    <a href="/download?edition=public" type="application/pdf">Public research report download</a>
    <a href="/private/alice%40corp.test?edition=public#chapter">Restricted research report</a>
    <a href="mailto:research@example.org?subject=Publication">Contact the research office</a></main>`
  const site = createServer((req, res) => {
    if (req.url.startsWith('/start')) { res.writeHead(302, { location: '/middle' }); res.end(); return }
    if (req.url === '/middle') { res.writeHead(307, { location: '/source' }); res.end(); return }
    if (req.url === '/popup-source') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>Popup before PDF response</title><a href="/slow-pdf" type="application/pdf">Delayed report download</a><script>setTimeout(() => window.open("/popup"), 3500)</script>')
      return
    }
    if (req.url === '/slow-pdf') {
      void delay(3000).then(() => {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' })
        res.end('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF')
      })
      return
    }
    if (req.url.startsWith('/download')) {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' })
      res.end('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF'); return
    }
    if (req.url === '/blocked.pdf') {
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' })
      res.end('<title>Just a moment</title><p>cf_chl_captcha</p>'); return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page)
  })
  const base = `http://127.0.0.1:${await listen(site)}`
  const daemon = spawn(process.execPath, ['tools/browse.mjs', 'serve'], {
    env: { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_TOKEN: token, SNAPSURF_TOKEN_FILE: join(runtime, 'token'), SNAPSURF_LOGDIR: runtime, SNAPSURF_OPEN_WATCH_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  daemon.stdout.on('data', (chunk) => { output += String(chunk) })
  daemon.stderr.on('data', (chunk) => { output += String(chunk) })
  const post = async (cmd, args = []) => {
    const body = JSON.stringify({ cmd, args, envelope: true })
    const nonce = randomBytes(16).toString('hex')
    const reply = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-snapdom-nonce': nonce, 'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`) },
    })
    const text = await reply.text()
    assert.equal(reply.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${text}`))
    const result = JSON.parse(text)
    assert.equal(result.ok, true, text)
    return result
  }
  try {
    let ready = false
    const until = Date.now() + 30_000
    while (Date.now() < until && daemon.exitCode === null) {
      try { ready = (await post('status')).ok; if (ready) break } catch { /* startup */ }
      await delay(100)
    }
    assert.equal(ready, true, output)
    await t.test('structured digest and find retain complete navigable URLs', async () => {
      const opened = await post('open', [base + '/source'])
      const link = opened.meta.digest.top.find((entry) => entry.n === 'The complete intangible technology transfer report')
      assert.equal(link.href, base + longPath)
      assert.equal(link.document.url, link.href)
      assert.equal(link.document.title, link.n)
      assert.equal(link.document.reader, 'external-pdf-reader')
      assert.deepEqual(link.document.source, { observationId: opened.meta.observationId, id: link.id })
      assert.equal(opened.text.includes(base + longPath), false, 'prose remains compact')
      const found = await post('find', ['intangible technology'])
      assert.equal(found.meta.matches.find((entry) => entry.role === 'link').href, base + longPath)
      const contact = await post('find', ['Contact the research office'])
      assert.equal(contact.meta.matches.find((entry) => entry.role === 'link').href, 'mailto:research@example.org?subject=Publication')
    })
    await t.test('the HTTP redirect chain preserves observed order and statuses without navigation query secrets', async () => {
      const opened = await post('open', [base + '/start?token=hidden-navigation-value'])
      assert.equal(opened.meta.finalUrl, base + '/source')
      assert.equal(opened.meta.navigationUrlsSanitized, true)
      assert.equal(opened.meta.requestedUrl.startsWith(base + '/start?«'), true)
      assert.equal(JSON.stringify(opened).includes('hidden-navigation-value'), false)
      assert.deepEqual(opened.meta.redirectChain.map((entry) => entry.status), [302, 307, 200])
      assert.equal(opened.meta.redirectChain[1].url, base + '/middle')
      assert.equal(opened.meta.redirectChain[2].url, base + '/source')
      assert.equal(opened.meta.redirectChainTotal, 3)
      assert.equal(opened.meta.redirectChainTruncated, false)
      assert.equal(opened.meta.redirectChainScope, 'http')
    })
    await t.test('PDF downloads return an explicit handoff with the prior source reference', async () => {
      const opened = await post('open', [base + '/source'])
      const source = opened.meta.digest.top.find((entry) => entry.n === 'Public research report download')
      const pdf = await post('open', [source.href])
      assert.equal(pdf.meta.document.type, 'pdf')
      assert.equal(pdf.meta.document.mediaType, 'application/pdf')
      assert.equal(pdf.meta.document.textExtracted, false)
      assert.equal(pdf.meta.document.title, source.n)
      assert.equal(pdf.meta.document.source.observationId, opened.meta.observationId)
      assert.equal(pdf.meta.document.source.id, source.id)
      assert.equal(pdf.meta.document.source.href, source.href)
      assert.equal(pdf.meta.document.source.url, base + '/source')
      assert.equal(pdf.meta.baselineAdvanced, false)
      assert.equal(pdf.meta.digest, undefined)
      assert.equal(pdf.meta.observationId, undefined, 'a PDF handoff must not invent an observation')
      assert.match(pdf.text, /has not extracted its text/)
    })
    await t.test('a PDF-looking URL behind a bot wall stays blocked', async () => {
      const blocked = await post('open', [base + '/blocked.pdf'])
      assert.equal(blocked.meta.blocked, true)
      assert.equal(blocked.meta.document, undefined)
    })
    await t.test('PDF response stays attached to its navigated page when a popup becomes active', async () => {
      const opened = await post('open', [base + '/popup-source'])
      const source = opened.meta.digest.top.find((entry) => entry.n === 'Delayed report download')
      const pdf = await post('open', [source.href])
      assert.equal(pdf.meta.document.type, 'pdf')
      assert.equal(pdf.meta.document.source.observationId, opened.meta.observationId)
      assert.equal(pdf.meta.document.source.url, base + '/popup-source')
      assert.equal(pdf.meta.finalUrl, base + '/slow-pdf')
      assert.equal(pdf.url, base + '/popup', 'the active page must actually have switched during navigation')
    })
    await t.test('full link destinations still obey encoded privacy rules', async () => {
      const opened = await post('open', [base + '/source', '--redact-json', '["alice@corp.test"]'])
      const link = opened.meta.digest.top.find((entry) => entry.n === 'Restricted research report')
      assert.equal(link.href, '[redacted]')
      const found = await post('find', ['Restricted research report'])
      assert.equal(found.meta.matches.find((entry) => entry.role === 'link').href, '[redacted]')
      assert.equal(JSON.stringify([opened, found]).includes('alice%40corp.test'), false)
    })
  } finally {
    try { await post('stop') } catch { /* already stopped */ }
    for (let count = 0; count < 30 && daemon.exitCode === null; count++) await delay(100)
    if (daemon.exitCode === null) daemon.kill('SIGTERM')
    await close(site)
    await rm(runtime, { recursive: true, force: true })
  }
})
