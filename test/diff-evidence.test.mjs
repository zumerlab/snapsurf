import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { setTimeout as delayTimer } from 'node:timers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const delay = (ms) => new Promise((done) => delayTimer(done, ms))
const hmac = (token, message) => createHmac('sha256', token).update(message).digest('hex')
const dataUrl = (html) => `data:text/html,${encodeURIComponent(html)}`

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()))
  return port
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((done, reject) => {
    const timer = delayTimer(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMs)
    timer.unref()
    child.once('exit', done)
  })
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
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  return {
    call: (method, params = {}) => new Promise((resolveCall, reject) => {
      const id = ++nextId
      const timer = delayTimer(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out`))
      }, 10_000)
      timer.unref()
      pending.set(id, { resolve: resolveCall, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }),
    close: () => lines.close(),
  }
}

const EDITOR = `<!doctype html><meta charset="utf-8"><title>Diff evidence fixture</title>
  <style>button { margin: 8px; min-width: 120px; height: 36px } p { height: 24px }</style>
  <button onclick="document.querySelector('#status').textContent='Saved once';const n=document.createElement('p');n.id='notification';n.textContent='Saved notification';document.body.append(n)">Save change</button>
  <button onclick="document.querySelector('#status').id='renamed-status';document.querySelector('#renamed-status').textContent='Cleared later';document.querySelector('#notification').remove()">Clear later</button>
  <button onclick="document.querySelector('#pending').textContent='Pending mutation happened'">Make pending change</button>
  <p id="status" data-testid="status">Not saved yet</p><p id="pending" data-testid="pending">Pending idle</p>`

test('immutable diff evidence through the real browser daemon and MCP', { timeout: 150_000 }, async (t) => {
  const port = await freePort()
  assert.notEqual(port, 8377, 'never borrow the shared development daemon')
  const logDir = await mkdtemp(join(tmpdir(), 'snapdom-diff-evidence-'))
  const token = randomBytes(32).toString('hex')
  const env = {
    ...process.env,
    SNAPDOM_AGENT_PORT: String(port),
    SNAPDOM_AGENT_LOGDIR: logDir,
    SNAPDOM_AGENT_TOKEN: token,
    SNAPDOM_AGENT_TOKEN_FILE: join(logDir, 'daemon.token'),
  }
  let daemon
  let mcp
  let client
  const output = []
  const post = async (cmd, args = [], sessionId) => {
    const body = JSON.stringify({ cmd, args, sessionId, envelope: true })
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
    assert.equal(response.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${text}`))
    return { status: response.status, ...JSON.parse(text) }
  }
  const checked = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result))
    return result
  }
  const click = async (name, sessionId) => {
    const found = checked(await post('find', [name], sessionId))
    const button = found.meta.matches.find((entry) => entry.role === 'button' && entry.name === name)
    assert.ok(button, `missing button ${name}: ${JSON.stringify(found.meta.matches)}`)
    return checked(await post('click', [button.id], sessionId))
  }
  const verdict = async (spec, sessionId) => {
    const response = checked(await post('assert', [JSON.stringify(spec)], sessionId))
    assert.ok(response.meta.assert, JSON.stringify(response))
    return { response, result: response.meta.assert }
  }
  const unavailable = async (diffId, sessionId) => {
    const { response, result } = await verdict({ diffId, changed: false }, sessionId)
    assert.equal(result.pass, false)
    assert.equal(result.error?.code, 'DIFF_UNAVAILABLE', JSON.stringify(result))
    assert.equal(result.baselineAdvanced, false)
    return response
  }

  try {
    daemon = spawn(process.execPath, [join(ROOT, 'tools/browse.mjs'), 'serve'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout.on('data', (chunk) => output.push(String(chunk)))
    daemon.stderr.on('data', (chunk) => output.push(String(chunk)))
    const deadline = Date.now() + 30_000
    let ready = false
    while (!ready && Date.now() < deadline) {
      if (daemon.exitCode !== null) break
      try { ready = (await post('status')).ok === true } catch { /* daemon starting */ }
      if (!ready) await delay(100)
    }
    assert.equal(ready, true, `daemon did not start\n${output.join('')}`)

    await t.test('keeps the exact saved change after later observations, renames and notification removal', async () => {
      const opened = checked(await post('open', [dataUrl(EDITOR)]))
      assert.equal(typeof opened.meta.observationId, 'string')
      await click('Save change')
      const saved = checked(await post('look'))
      assert.equal(saved.meta.changed, true)
      assert.equal(typeof saved.meta.diffId, 'string')
      assert.equal(saved.meta.beforeObservationId, opened.meta.observationId)
      assert.equal(saved.meta.afterObservationId, saved.meta.observationId)
      assert.notEqual(saved.meta.observationId, opened.meta.observationId)
      assert.equal(saved.meta.baselineAdvanced, true)

      checked(await post('find', ['Saved notification']))
      checked(await post('map'))
      await click('Clear later')
      const cleared = checked(await post('look'))
      assert.notEqual(cleared.meta.diffId, saved.meta.diffId)
      assert.equal(cleared.meta.beforeObservationId, saved.meta.observationId)
      assert.equal((await post('find', ['Saved notification'])).meta.matches.length, 0)

      const spec = {
        diffId: saved.meta.diffId,
        changed: true,
        mustInclude: [
          { kind: 'content', selector: '#status', nameExact: 'Saved once' },
          { kind: 'added', selector: '#notification', nameExact: 'Saved notification' },
        ],
        mustNotInclude: [{ nameExact: 'Cleared later' }],
      }
      const original = await verdict(spec)
      assert.equal(original.result.pass, true, JSON.stringify(original.result))
      assert.equal(JSON.stringify(original.result).includes('%3C!doctype'), false,
        'opaque data URL payloads must not leak through stored baselineUrl')
      assert.equal(original.response.epoch, cleared.epoch, 'historical assert must not mint a new epoch')
      for (const key of ['diffId', 'beforeObservationId', 'afterObservationId', 'observationId']) {
        assert.equal(original.result[key], saved.meta[key], `historical ${key} changed`)
      }
      assert.equal(original.result.baselineAdvanced, false)
      const idle = checked(await post('look'))
      assert.equal(idle.meta.changed, false, 'historical assert must not restore an old baseline')
      assert.equal(idle.meta.beforeObservationId, cleared.meta.observationId)

      await click('Make pending change')
      const repeated = await verdict(spec)
      assert.equal(repeated.result.pass, true, JSON.stringify(repeated.result))
      assert.equal(repeated.response.epoch, idle.epoch, 'historical assert must not read the pending DOM')
      const pending = checked(await post('look'))
      assert.equal(pending.meta.changed, true, 'historical assert must not consume a pending mutation')
      assert.equal(pending.meta.beforeObservationId, idle.meta.observationId)
      assert.ok(pending.meta.changes.some((entry) => entry.name === 'Pending mutation happened'))

      checked(await post('open', [dataUrl('<p>A different document</p>')]))
      assert.equal((await verdict(spec)).result.pass, true, 'evidence is historical across navigation')
    })

    await t.test('preserves actionability deltas after their DOM conditions reverse', async () => {
      const html = `<!doctype html><style>
        button { position:absolute;width:180px;height:36px;left:20px }
        #reveal { top:20px } #hide { top:70px } #target { top:130px }
        #covered { top:190px } #cover { display:none;position:absolute;left:16px;top:186px;width:188px;height:44px;background:white;z-index:10 }
      </style>
      <button id="reveal" onclick="target.style.display='block';cover.style.display='block'">Reveal and cover</button>
      <button id="hide" onclick="target.style.display='none';cover.style.display='none'">Reverse conditions</button>
      <button id="target" style="display:none">Newly visible action</button>
      <button id="covered">Covered action</button><div id="cover" aria-hidden="true"></div>`
      checked(await post('open', [dataUrl(html)]))
      await click('Reveal and cover')
      const reveal = checked(await post('look'))
      await click('Reverse conditions')
      const reverse = checked(await post('look'))
      const { response, result } = await verdict({
        diffId: reveal.meta.diffId,
        becameVisible: 'Newly visible action',
        becameCovered: 'Covered action',
      })
      assert.equal(result.pass, true, JSON.stringify(result))
      assert.equal(response.epoch, reverse.epoch)
    })

    await t.test('rejects mixed historical/current options and invalid ids without observing', async () => {
      checked(await post('open', [dataUrl(EDITOR)]))
      const baseline = checked(await post('look'))
      const incompatible = {
        exists: 'Pending idle', notCovered: 'Save change', url: 'data:', urlIncludes: 'data:',
        ignore: [], settleMs: 0, retry: { budgetMs: 0 }, keepBaseline: false,
      }
      for (const [key, value] of Object.entries(incompatible)) {
        const { response, result } = await verdict({ diffId: baseline.meta.diffId, changed: false, [key]: value })
        assert.equal(result.pass, false, `${key} must not mix current and saved evidence`)
        assert.ok(result.checks.some((entry) => entry.type === 'spec' && !entry.pass), JSON.stringify(result))
        assert.equal(response.epoch, baseline.epoch, `${key} validation must not observe`)
      }
      for (const diffId of ['', '   ', 7, null, [], {}]) {
        const { response, result } = await verdict({ diffId, changed: false })
        assert.equal(result.pass, false, `invalid id must fail: ${JSON.stringify(diffId)}`)
        assert.equal(response.epoch, baseline.epoch)
      }
      const empty = await verdict({ diffId: baseline.meta.diffId })
      assert.equal(empty.result.pass, false, 'diffId itself is not an assertion check')
      const absent = await unavailable('d_not_saved')
      assert.equal(absent.epoch, baseline.epoch, 'missing evidence must not fall back to a live comparison')
      assert.equal((await verdict({ diffId: baseline.meta.diffId, changed: false, maxChanges: 0 })).result.pass, true)
    })

    await t.test('checks changes beyond both the response preview and the former 2000-entry cap', async () => {
      const html = `<!doctype html><style>main { display:grid;grid-template-columns:repeat(12,1fr) } p { margin:0;height:20px }</style>
        <button onclick="document.querySelectorAll('main p').forEach((p,i)=>p.textContent=i===2104?'Forbidden tail mutation':'After item '+i)">Change all rows</button>
        <main></main><script>for(let i=0;i<2105;i++){const p=document.createElement('p');p.id='row-'+i;p.dataset.testid='row-'+i;p.textContent='Before item '+i;document.querySelector('main').append(p)}</script>`
      checked(await post('open', [dataUrl(html)]))
      await click('Change all rows')
      const live = await verdict({
        mustNotInclude: [{ kind: 'content', selector: '#row-2104', nameExact: 'Forbidden tail mutation' }],
        maxChanges: 2000,
        keepBaseline: true,
      })
      assert.equal(live.result.pass, false)
      for (const type of ['mustNotInclude', 'maxChanges']) {
        assert.equal(live.result.checks.find((entry) => entry.type === type).pass, false,
          `${type} must also inspect the full diff in live mode`)
      }
      const many = checked(await post('look'))
      assert.ok(many.meta.changesTotal > 2000, JSON.stringify(many.meta))
      assert.ok(many.meta.changes.length < many.meta.changesTotal, 'fixture must exceed the response preview')
      assert.equal(many.meta.changes.some((entry) => entry.name === 'Forbidden tail mutation'), false,
        'the forbidden change must lie outside the preview for this regression to be meaningful')
      const positive = await verdict({
        diffId: many.meta.diffId,
        mustInclude: [{ kind: 'content', selector: '#row-2104', nameExact: 'Forbidden tail mutation' }],
      })
      assert.equal(positive.result.pass, true, JSON.stringify(positive.result))
      const negative = await verdict({
        diffId: many.meta.diffId,
        mustNotInclude: [{ kind: 'content', selector: '#row-2104', nameExact: 'Forbidden tail mutation' }],
        maxChanges: 2000,
        only: [{ kind: 'content', name: 'After item' }, { kind: 'moved' }, { kind: 'resized' }],
      })
      assert.equal(negative.result.pass, false)
      for (const type of ['mustNotInclude', 'maxChanges', 'only']) {
        assert.equal(negative.result.checks.find((entry) => entry.type === type).pass, false, `${type} must use the complete evidence`)
      }
      assert.equal(negative.result.checks.find((entry) => entry.type === 'maxChanges').actual, many.meta.changesTotal)
    })

    await t.test('declares oversized evidence without storing a partial diff or discarding an older usable record', async () => {
      checked(await post('open', [dataUrl('<p>Small usable evidence</p>')]))
      const small = checked(await post('look'))
      const html = `<!doctype html><button onclick="document.querySelectorAll('p').forEach((p,i)=>p.setAttribute('aria-label','After '+i+' '+('Long authored name ').repeat(24000)))">Create oversized evidence</button>
        <script>for(let i=0;i<12;i++){const p=document.createElement('p');p.dataset.testid='large-'+i;p.textContent='Item '+i;p.setAttribute('aria-label','Before '+i);document.body.append(p)}</script>`
      checked(await post('open', [dataUrl(html)]))
      await click('Create oversized evidence')
      const oversized = checked(await post('look'))
      assert.equal(oversized.meta.changed, true)
      assert.equal(oversized.meta.diffAvailable, false, 'the complete record must exceed 8 MiB')
      assert.equal(oversized.meta.diffError?.code, 'DIFF_TOO_LARGE')
      assert.equal(oversized.meta.diffId, undefined, 'a partial record must not receive a usable id')
      assert.equal(typeof oversized.meta.beforeObservationId, 'string')
      assert.equal(oversized.meta.afterObservationId, oversized.meta.observationId)
      assert.equal(oversized.meta.baselineAdvanced, true, 'the live observation still completes')
      assert.equal((await verdict({ diffId: small.meta.diffId, changed: false })).result.pass, true)
      checked(await post('open', [dataUrl('<p>Oversize fixture finished</p>')]))
    })

    await t.test('retains uncertainty instead of turning incomplete evidence into a negative green', async () => {
      const html = '<!doctype html>' + Array.from({ length: 45 }, (_, i) =>
        `<input aria-label="Password ${i}" type="password" value="hidden">`).join('')
      checked(await post('open', [dataUrl(html)]))
      const uncertain = checked(await post('look'))
      assert.equal(uncertain.meta.changed, false)
      assert.equal(uncertain.meta.unobservable, 45)
      assert.ok(uncertain.meta.unobservableDetails.length > 0 &&
        uncertain.meta.unobservableDetails.length < uncertain.meta.unobservable,
      'fixture must exceed the uncertainty details preview')
      const live = await verdict({ changed: false, keepBaseline: true })
      assert.equal(live.result.pass, false)
      assert.equal(live.result.unobservable, uncertain.meta.unobservable,
        'live assertions must report the full uncertainty count')
      const clean = checked(await post('open', [dataUrl('<p>No uncertain controls here</p>')]))
      const { response, result } = await verdict({
        diffId: uncertain.meta.diffId,
        changed: false,
        mustNotInclude: [{ kind: 'state' }],
        only: [{ kind: 'content' }],
        maxChanges: 0,
      })
      assert.equal(result.pass, false)
      assert.equal(result.unobservable, uncertain.meta.unobservable,
        'historical assertions must retain the full uncertainty count')
      assert.deepEqual(result.unobservableDetails, uncertain.meta.unobservableDetails)
      for (const type of ['changed', 'mustNotInclude', 'only', 'maxChanges']) {
        const check = result.checks.find((entry) => entry.type === type)
        assert.equal(check.pass, false, `${type} must preserve original observation uncertainty`)
        assert.match(check.actual, /unknown: 45 unobservable/)
      }
      assert.equal(response.epoch, clean.epoch)
    })

    await t.test('isolates sessions, invalidates changed privacy policies and evicts old evidence', async () => {
      const session = checked(await post('session', ['open'])).meta.sessionId
      checked(await post('open', [dataUrl(EDITOR)], session))
      await click('Save change', session)
      const saved = checked(await post('look', [], session))
      const currentDefault = checked(await post('look'))
      assert.equal((await unavailable(saved.meta.diffId)).epoch, currentDefault.epoch)
      assert.equal((await unavailable(currentDefault.meta.diffId, session)).epoch, saved.epoch)
      assert.equal((await verdict({ diffId: saved.meta.diffId, changed: true }, session)).result.pass, true)

      checked(await post('redact', ['Saved notification'], session))
      const invalidated = await unavailable(saved.meta.diffId, session)
      assert.equal(invalidated.epoch, saved.epoch, 'privacy invalidation must not re-observe an old id')
      assert.equal(JSON.stringify(invalidated).includes('Saved notification'), false, 'invalid evidence cannot leak old policy data')
      assert.equal((await verdict({ diffId: currentDefault.meta.diffId, changed: false })).result.pass, true,
        'another session privacy change cannot discard this session evidence')
      checked(await post('redact', ['off'], session))
      await unavailable(saved.meta.diffId, session)

      checked(await post('open', [dataUrl('<p>Eviction fixture</p>')], session))
      const oldest = checked(await post('look', [], session))
      let newest
      for (let i = 0; i < 33; i++) newest = checked(await post('look', [], session))
      assert.equal((await unavailable(oldest.meta.diffId, session)).epoch, newest.epoch)
      assert.equal((await verdict({ diffId: newest.meta.diffId, changed: false }, session)).result.pass, true)
      checked(await post('session', ['close', session]))
      const fresh = checked(await post('session', ['open'])).meta.sessionId
      await unavailable(newest.meta.diffId, fresh)
      checked(await post('session', ['close', fresh]))
    })

    await t.test('publishes the saved evidence schema and faithful MCP pass/isError results', async () => {
      const sessionId = checked(await post('session', ['open'])).meta.sessionId
      checked(await post('open', [dataUrl(EDITOR)], sessionId))
      mcp = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
      mcp.stderr.on('data', (chunk) => output.push(String(chunk)))
      client = mcpClient(mcp)
      await client.call('initialize', { protocolVersion: '2024-11-05' })
      const listed = await client.call('tools/list')
      const schema = listed.tools.find((entry) => entry.name === 'browser_assert').inputSchema
      assert.equal(schema.properties.diffId.type, 'string')
      for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(key in schema, false, 'portable schemas stay flat')
      const call = (name, args) => client.call('tools/call', { name, arguments: { sessionId, ...args } })
      const found = await call('browser_find', { text: 'Save change' })
      assert.equal(found.isError, false, JSON.stringify(found))
      const button = found.structuredContent.matches.find((entry) => entry.role === 'button' && entry.name === 'Save change')
      assert.ok(button, JSON.stringify(found))
      assert.equal((await call('browser_act', { action: 'click', target: button.id })).isError, false)
      const verified = await call('browser_verify', {})
      assert.equal(verified.isError, false)
      const { diffId, observationId, beforeObservationId } = verified.structuredContent
      assert.equal(typeof diffId, 'string')
      assert.equal(typeof observationId, 'string')
      await call('browser_verify', {})
      const saved = await call('browser_assert', { diffId, changed: true, mustInclude: [{ selector: '#status' }] })
      assert.equal(saved.isError, false, JSON.stringify(saved))
      assert.equal(saved.structuredContent.pass, true)
      assert.equal(saved.structuredContent.sessionId, sessionId)
      assert.equal(saved.structuredContent.diffId, diffId)
      assert.equal(saved.structuredContent.observationId, observationId)
      assert.equal(saved.structuredContent.beforeObservationId, beforeObservationId)
      assert.equal(saved.structuredContent.afterObservationId, observationId)
      assert.equal(saved.structuredContent.baselineAdvanced, false)
      const failed = await call('browser_assert', { diffId, changed: false })
      assert.equal(failed.isError, true)
      assert.equal(failed.structuredContent.pass, false)
      const absent = await call('browser_assert', { diffId: 'd_missing', changed: false })
      assert.equal(absent.isError, true)
      assert.equal(absent.structuredContent.pass, false)
      assert.equal(absent.structuredContent.error?.code, 'DIFF_UNAVAILABLE')
      const mixed = await call('browser_assert', { diffId, changed: true, keepBaseline: false })
      assert.equal(mixed.isError, true)
      assert.equal(mixed.structuredContent.pass, false)
      checked(await post('session', ['close', sessionId]))
    })
  } finally {
    client?.close()
    if (mcp) {
      mcp.stdin.end()
      try { await waitForExit(mcp) } catch { mcp.kill('SIGKILL') }
    }
    if (daemon) {
      try { await post('stop') } catch { /* daemon may have exited */ }
      try { await waitForExit(daemon, 5000) } catch { daemon.kill('SIGKILL') }
    }
    await rm(logDir, { recursive: true, force: true })
  }
})
