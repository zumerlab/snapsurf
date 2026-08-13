import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { setTimeout as delayTimer } from 'node:timers'
import { Buffer } from 'node:buffer'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSE = join(ROOT, 'tools', 'browse.mjs')
const MCP = join(ROOT, 'mcp', 'server.mjs')

const delay = (ms) => new Promise((done) => delayTimer(done, ms))
const hmac = (token, message) => createHmac('sha256', token).update(message).digest('hex')
const safeEqual = (actual, expected) => {
  const a = Buffer.from(String(actual || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

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
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    delay(timeoutMs).then(() => { throw new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`) }),
  ])
}

function rawRequest(port, { method = 'POST', path = '/cmd', headers = {}, body = '' } = {}) {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }))
    })
    req.once('error', reject)
    req.end(body)
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
  const call = (method, params = {}) => {
    const id = ++nextId
    return Promise.race([
      new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }),
      delay(10_000).then(() => { throw new Error(`MCP request ${id} (${method}) timed out`) }),
    ])
  }
  return { call, close: () => lines.close() }
}

test('daemon/MCP focused security and session regressions', { timeout: 90_000 }, async (t) => {
  const port = await freePort()
  assert.notEqual(port, 8377, 'the focused test must never use the shared development port')
  const logDir = await mkdtemp(join(tmpdir(), 'snapdom-daemon-audit-'))
  const authToken = randomBytes(32).toString('hex')
  const escapedName = `snapdom-checkpoint-escape-${randomUUID()}`
  const escapedPath = join(dirname(logDir), `${escapedName}.json`)
  const env = {
    ...process.env,
    SNAPDOM_AGENT_PORT: String(port),
    SNAPDOM_AGENT_LOGDIR: logDir,
    SNAPDOM_AGENT_TOKEN: authToken,
    SNAPDOM_AGENT_TOKEN_FILE: join(logDir, 'daemon.token'),
    SNAPDOM_AGENT_MAX_BODY_BYTES: '4096',
  }
  let daemon
  let mcp
  let rpc
  const daemonOutput = []

  const post = async (cmd, args = [], sessionId, extra = {}) => {
    const body = JSON.stringify({ cmd, args, sessionId, envelope: true, ...extra })
    const nonce = randomBytes(16).toString('hex')
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-snapdom-nonce': nonce,
        'x-snapdom-auth': hmac(authToken, `request-v1\n${nonce}\n${body}`),
      },
      body,
    })
    const text = await response.text()
    assert.equal(safeEqual(response.headers.get('x-snapdom-auth'), hmac(authToken, `response-v1\n${nonce}\n${text}`)), true, 'daemon response must be authenticated')
    let value
    try { value = JSON.parse(text) } catch { value = { ok: false, error: text } }
    return { status: response.status, ...value }
  }

  try {
    daemon = spawn(process.execPath, [BROWSE, 'serve'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    daemon.stdout.on('data', (chunk) => daemonOutput.push(String(chunk)))
    daemon.stderr.on('data', (chunk) => daemonOutput.push(String(chunk)))

    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (daemon.exitCode !== null) break
      try {
        const status = await post('status', [], undefined, { internal: true })
        ready = status.ok === true
      } catch { /* daemon still starting */ }
      if (!ready) await delay(100)
    }
    assert.equal(ready, true, `daemon did not start on :${port}\n${daemonOutput.join('')}`)

    await t.test('hardens the loopback HTTP boundary and caps request bodies', async () => {
      assert.equal((await stat(env.SNAPDOM_AGENT_TOKEN_FILE)).mode & 0o777, 0o600)
      const badHost = await rawRequest(port, {
        headers: { host: 'attacker.invalid', 'content-type': 'application/json' },
        body: '{"cmd":"status"}',
      })
      assert.equal(badHost.status, 403)

      const simpleCrossOrigin = await rawRequest(port, {
        headers: { 'content-type': 'text/plain' },
        body: '{"cmd":"status"}',
      })
      assert.equal(simpleCrossOrigin.status, 415)

      const oversized = await rawRequest(port, {
        headers: { 'content-type': 'application/json', 'content-length': '5000' },
        body: 'x'.repeat(5000),
      })
      assert.equal(oversized.status, 413)

      const unsigned = await rawRequest(port, {
        headers: { 'content-type': 'application/json' },
        body: '{"cmd":"status"}',
      })
      assert.equal(unsigned.status, 401)

      const challenge = randomBytes(16).toString('hex')
      const auth = await rawRequest(port, {
        path: '/auth',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: challenge }),
      })
      assert.equal(auth.status, 200)
      assert.equal(safeEqual(auth.headers['x-snapdom-auth'], hmac(authToken, `auth-v1\n${challenge}`)), true)

      const replayBody = '{"cmd":"status"}'
      const replayNonce = randomBytes(16).toString('hex')
      const replayHeaders = {
        'content-type': 'application/json',
        'x-snapdom-nonce': replayNonce,
        'x-snapdom-auth': hmac(authToken, `request-v1\n${replayNonce}\n${replayBody}`),
      }
      assert.equal((await rawRequest(port, { headers: replayHeaders, body: replayBody })).status, 200)
      assert.equal((await rawRequest(port, { headers: replayHeaders, body: replayBody })).status, 401)
    })

    const mutationHtml = `<!doctype html><meta charset="utf-8">
      <button id="go" onclick="first.textContent='After first';second.textContent='After second'">Go</button>
      <div id="first" data-testid="first">Before first</div>
      <div id="second" data-testid="second">Before second</div>`
    const mutationUrl = `data:text/html,${encodeURIComponent(mutationHtml)}`

    await t.test('matches browser_assert selectors exactly', async () => {
      const opened = await post('open', [mutationUrl])
      assert.equal(opened.ok, true, opened.error)
      const found = await post('find', ['Go'])
      const go = found.meta.matches.find((entry) => entry.name === 'Go')
      assert.ok(go, `button not found: ${JSON.stringify(found.meta.matches)}`)
      const clicked = await post('click', [go.id])
      assert.equal(clicked.ok, true, clicked.error)

      const wrong = await post('assert', [JSON.stringify({
        changed: true,
        mustInclude: [{ kind: 'content', selector: '#not-the-element' }],
        keepBaseline: true,
      })])
      assert.equal(wrong.meta.assert.pass, false, 'an unrelated selector must not match a change')
      assert.equal(wrong.meta.assert.checks.find((check) => check.type === 'mustInclude').actual, 'absent')

      const exact = await post('assert', [JSON.stringify({
        changed: true,
        mustInclude: [{ kind: 'content', selector: '#first' }],
        keepBaseline: true,
      })])
      assert.equal(exact.meta.assert.pass, true, JSON.stringify(exact.meta.assert.checks))
      assert.ok(exact.meta.assert.changes.some((change) => change.selector === '#first'))

      const verified = await post('look')
      assert.ok(Array.isArray(verified.meta.actionabilityDelta?.becameVisible))
      assert.ok(Array.isArray(verified.meta.actionabilityDelta?.becameCovered))
      assert.equal((await post('cp', ['save', 'delta-surface'])).ok, true)
      const checkpointDiff = await post('cp', ['diff', 'delta-surface'])
      assert.ok(Array.isArray(checkpointDiff.meta.actionabilityDelta?.becameVisible))
      assert.ok(Array.isArray(checkpointDiff.meta.actionabilityDelta?.becameCovered))
    })

    await t.test('matches implicit false state endpoints without inventing unrelated state', async () => {
      const stateHtml = `<!doctype html><meta charset="utf-8">
        <input id="enable-target" aria-label="Account" disabled>
        <input id="value-target" aria-label="Memo" value="seed">
        <button id="apply" onclick="document.querySelector('#enable-target').disabled=false;document.querySelector('#value-target').value=''">Apply state</button>
        <button id="toggle" aria-expanded="true" onclick="this.removeAttribute('aria-expanded')">Toggle disclosure</button>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(stateHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const apply = (await post('find', ['Apply state'])).meta.matches.find((entry) => entry.role === 'button')
      assert.ok(apply)
      assert.equal((await post('click', [apply.id])).ok, true)

      const exact = await post('assert', [JSON.stringify({
        changed: true,
        mustInclude: [
          { kind: 'state', role: 'textbox', nameExact: 'Account', to: { disabled: false } },
          { kind: 'state', role: 'textbox', nameExact: 'Memo', to: { hasValue: false } },
        ],
        keepBaseline: true,
      })])
      assert.equal(exact.meta.assert.pass, true, JSON.stringify(exact.meta.assert.checks))
      assert.ok(exact.meta.assert.changes.some((change) => change.to?.disabled === false))
      assert.ok(exact.meta.assert.changes.some((change) => change.to?.hasValue === false))

      const consumed = await post('look')
      assert.equal(consumed.ok, true, consumed.error)
      const toggle = (await post('find', ['Toggle disclosure'])).meta.matches.find((entry) => entry.role === 'button')
      assert.ok(toggle)
      assert.equal((await post('click', [toggle.id])).ok, true)
      const nearMiss = await post('assert', [JSON.stringify({
        changed: true,
        mustInclude: [{
          kind: 'state', role: 'button', nameExact: 'Toggle disclosure', to: { disabled: false },
        }],
        keepBaseline: true,
      })])
      assert.equal(nearMiss.meta.assert.pass, false, 'an unrelated ARIA transition must not synthesize disabled:false')
      assert.equal(nearMiss.meta.assert.checks.find((check) => check.type === 'mustInclude').actual, 'absent')
      const expandedChange = nearMiss.meta.assert.changes.find((change) =>
        change.kind === 'state' && change.name === 'Toggle disclosure')
      assert.ok(expandedChange, JSON.stringify(nearMiss.meta.assert.changes))
      assert.equal('expanded' in expandedChange.to, false)
      assert.equal('disabled' in expandedChange.to, false)
    })

    await t.test('keeps an exact actionable badge match ahead of generic ranking noise', async () => {
      const distractors = Array.from({ length: 18 }, (_, index) =>
        `<article>Catalog 1 option ${String(index).padStart(2, '0')} with a sufficiently detailed unique description</article>`).join('')
      const badgeHtml = `<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; font: 16px sans-serif }
        header { height: 56px; padding: 8px; box-sizing: border-box }
        #cart { display: inline-flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; background: #eee }
        #badge { display: inline-block; min-width: 18px; text-align: center }
        #add { position: absolute; left: 72px; top: 10px; width: 120px; height: 36px }
        main { display: grid; grid-template-columns: repeat(3, 310px); gap: 8px; padding: 8px }
        article { width: 300px; height: 48px; padding: 8px; box-sizing: border-box; background: #fafafa }
      </style>
      <header><a id="cart" href="#cart" onclick="route.textContent='Cart reached';return false"></a></header>
      <button id="add" onclick="cart.innerHTML='<span id=badge>1</span>'">Add badge</button>
      <p id="route">Cart idle</p>
      <main>${distractors}</main>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(badgeHtml)}`])
      assert.equal(opened.ok, true, opened.error)

      const add = await post('find', ['Add badge'])
      const addButton = add.meta.matches.find((entry) => entry.role === 'button' && entry.name === 'Add badge')
      assert.ok(addButton, JSON.stringify(add.meta.matches))
      assert.equal((await post('click', [addButton.id])).ok, true)

      const diff = await post('look')
      assert.equal(diff.ok, true, diff.error)
      const badgeChange = diff.meta.changes.find((change) =>
        change.kind === 'added' && change.role === 'generic' && change.name === '1')
      assert.ok(badgeChange, JSON.stringify(diff.meta.changes))

      const map = await post('map')
      assert.equal(map.ok, true, map.error)
      assert.equal(map.text.includes(badgeChange.id), false, 'the generic badge must not pretend to be in agentMap')

      const found = await post('find', ['1'])
      const cartLink = found.meta.matches.find((entry) => entry.role === 'link' && entry.name === '1')
      assert.ok(cartLink, `exact cart link was lost behind ranking noise: ${JSON.stringify(found.meta.matches)}`)
      assert.match(map.text, new RegExp(`\\b${cartLink.id}\\b`), 'the actionable parent must remain in agentMap')
      assert.equal((await post('click', [cartLink.id])).ok, true)
      const routed = await post('look')
      assert.equal(routed.ok, true, routed.error)
      assert.ok((await post('find', ['Cart reached'])).meta.matches.length > 0,
        'clicking the chosen link must trigger its route effect')
    })

    await t.test('keeps unnamed controls discoverable and scopes inside the full epoch', async () => {
      const scopeHtml = `<!doctype html><meta charset="utf-8"><style>
        body { font: 16px sans-serif }
        input, button { width: 150px; height: 36px; margin: 8px; display: block }
        input { width: 24px }
        section { width: 240px; padding: 8px; border: 1px solid #ccc }
      </style>
      <input id="toggle" type="checkbox">
      <section id="card">
        <button id="inside" onclick="this.textContent='Inside done'">Inside scope</button>
        <button id="sibling">Sibling action</button>
      </section>
      <button id="outside" onclick="this.textContent='Outside done'">Outside action</button>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(scopeHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const initialEpoch = opened.epoch

      const digestCheckbox = opened.meta.digest.top.find((entry) => entry.r === 'checkbox')
      assert.ok(digestCheckbox, JSON.stringify(opened.meta.digest.top))
      assert.equal('n' in digestCheckbox, false, 'the digest must not invent an accessible name')

      const roleFind = await post('find', ['checkbox'])
      const checkbox = roleFind.meta.matches.find((entry) => entry.role === 'checkbox')
      assert.ok(checkbox, JSON.stringify(roleFind.meta.matches))
      assert.equal(checkbox.name, undefined, 'role search must not invent a checkbox name')
      const initialMap = await post('map')
      assert.match(initialMap.text, new RegExp(`\\b${checkbox.id}\\s+checkbox\\s+\\[`))

      const insideFind = await post('find', ['Inside scope'])
      const inside = insideFind.meta.matches.find((entry) => entry.role === 'button' && entry.name === 'Inside scope')
      const outsideFind = await post('find', ['Outside action'])
      const outside = outsideFind.meta.matches.find((entry) => entry.role === 'button' && entry.name === 'Outside action')
      assert.ok(inside && outside)

      const zoom = await post('look', [inside.id])
      assert.equal(zoom.ok, true, zoom.error)
      assert.equal(zoom.epoch, initialEpoch, 'zoom must not establish a new full epoch')
      assert.match(zoom.text, /actionables: 1/)
      const scopedInside = zoom.text.match(/\b(n_[A-Za-z0-9_-]+)\s+button "Inside scope"/)?.[1]
      assert.ok(scopedInside, zoom.text)
      assert.notEqual(scopedInside, inside.id, 'a scoped walk should publish its own resolvable id')

      const stillGlobal = await post('find', ['Outside action'])
      assert.ok(stillGlobal.meta.matches.some((entry) => entry.id === outside.id), JSON.stringify(stillGlobal.meta.matches))
      const mapAfterZoom = await post('map')
      assert.match(mapAfterZoom.text, new RegExp(`\\b${outside.id}\\b`))
      assert.equal(mapAfterZoom.text.includes(scopedInside), false, 'global map must not be replaced by the scoped map')
      const scopedText = await post('text', [scopedInside])
      assert.equal(scopedText.meta.text, 'Inside scope')

      assert.equal((await post('click', [scopedInside])).ok, true, 'a freshly published scoped id must resolve')
      assert.equal((await post('click', [outside.id])).ok, true, 'zoom must not expire a full-map id')
      const changed = await post('look')
      assert.equal(changed.meta.changed, true, JSON.stringify(changed.meta.changes))
      assert.equal(changed.epoch, initialEpoch + 1)
      assert.ok((await post('find', ['Inside done'])).meta.matches.length > 0)
      assert.ok((await post('find', ['Outside done'])).meta.matches.length > 0)

      const expiredGlobal = await post('click', [outside.id])
      const expiredScoped = await post('click', [scopedInside])
      assert.equal(expiredGlobal.ok, false, 'the next full observation must expire previous full ids')
      assert.equal(expiredScoped.ok, false, 'the next full observation must expire scoped ids too')

      const currentInside = (await post('find', ['Inside done'])).meta.matches.find((entry) => entry.role === 'button')
      const currentOutside = (await post('find', ['Outside done'])).meta.matches.find((entry) => entry.role === 'button')
      assert.ok(currentInside && currentOutside)
      const parent = await post('parent', [currentInside.id])
      assert.equal(parent.ok, true, parent.error)
      assert.equal(parent.epoch, changed.epoch, 'parent/card must not establish a new full epoch')
      assert.ok((await post('find', ['Outside done'])).meta.matches.some((entry) => entry.id === currentOutside.id),
        'parent/card must not replace the full resolver')

      const unchanged = await post('look')
      assert.equal(unchanged.meta.changed, false,
        `parent/card consumed the full baseline: ${JSON.stringify(unchanged.meta.changes || [])}`)
      assert.equal(unchanged.epoch, changed.epoch + 1)
    })

    await t.test('parent accepts a resolved card as the nearest actionable container', async () => {
      const cardHtml = `<!doctype html><meta charset="utf-8">
        <article id="card">
          <h2>Featured product</h2>
          <span>$ 1.234</span>
          <a href="#detail">View detail</a>
          <button>Buy now</button>
        </article>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(cardHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const price = await post('find', ['1.234'])
      const match = [...price.meta.matches]
        .filter((entry) => entry.text?.includes('1.234'))
        .sort((a, b) => a.text.length - b.text.length)[0]
      assert.ok(match, JSON.stringify(price.meta.matches))

      const parent = await post('parent', [match.id])
      assert.equal(parent.ok, true, parent.error)
      assert.match(parent.text, /View detail/)
      assert.match(parent.text, /Buy now/)
      // The card must travel as FIELDS, not only prose: a structuredContent consumer
      // (Codex parity run) read {parentOf} alone and concluded the card was missing.
      assert.ok(Array.isArray(parent.meta.map) && parent.meta.map.length >= 2,
        'parent must publish the card map in meta')
      assert.ok(parent.meta.map.some((entry) => /Buy now/.test(entry.n || '')),
        'the card map must carry the actionables')

      const zoomed = await post('look', [parent.meta.map[0].id])
      assert.equal(zoomed.ok, true, zoomed.error)
      assert.ok(Array.isArray(zoomed.meta.map), 'zoom must publish its subtree map in meta')
    })

    await t.test('invalidates old-policy resolvers and blocks private find probes', async () => {
      const policyHtml = '<!doctype html><button>Gamma private marker</button><p>Public marker</p>'
      const opened = await post('open', [`data:text/html,${encodeURIComponent(policyHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const before = await post('find', ['Gamma private marker'])
      const privateButton = before.meta.matches.find((entry) => entry.role === 'button')
      assert.ok(privateButton, JSON.stringify(before.meta.matches))

      const changed = await post('redact', ['Gamma private marker'])
      assert.equal(changed.ok, true, changed.error)
      const blocked = await post('find', ['Gamma private marker'])
      assert.equal(blocked.ok, false, 'a privacy matcher must fail closed, not return a count oracle')
      assert.match(blocked.error, /presence oracle/)
      assert.equal(JSON.stringify(blocked).includes('Gamma private marker'), false)
      assert.equal((await post('find', ['Public marker'])).ok, false,
        'old-policy UI must not serve even unrelated reads before re-observation')
      assert.equal((await post('click', [privateButton.id])).ok, false,
        'an id minted under the old policy must be invalid immediately')

      const reobserved = await post('look')
      assert.equal(reobserved.ok, true, reobserved.error)
      const publicFind = await post('find', ['Public marker'])
      assert.equal(publicFind.ok, true, publicFind.error)
      assert.ok(publicFind.meta.matches.length > 0)
      const hiddenAfter = await post('find', ['Gamma private marker'])
      assert.equal(hiddenAfter.ok, false)
      assert.equal(JSON.stringify(hiddenAfter).includes('Gamma private marker'), false)

      const cleared = await post('redact', ['off'])
      assert.equal(cleared.ok, true, cleared.error)
      assert.equal((await post('find', ['Public marker'])).ok, false,
        'clearing privacy must also invalidate the protected-policy resolver')
      assert.equal((await post('look')).ok, true)
      const visibleAgain = await post('find', ['Gamma private marker'])
      assert.equal(visibleAgain.ok, true, visibleAgain.error)
      assert.ok(visibleAgain.meta.matches.some((entry) => entry.role === 'button'))
    })

    await t.test('rejects detached scoped targets instead of clicking 0,0 or reading stale data', async () => {
      const detachedHtml = `<!doctype html><style>button{width:180px;height:36px;margin:8px;display:block}</style>
        <button id="trap" style="position:fixed;left:0;top:0;width:20px;height:20px;margin:0" onclick="trapMarker.textContent='Trap fired'">Trap</button>
        <p id="trapMarker">Trap idle</p>
        <button id="remove" onclick="victim.remove()">Remove victim</button>
        <button id="victim" onclick="document.body.dataset.ghost='clicked'">Scoped victim</button>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(detachedHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const remove = (await post('find', ['Remove victim'])).meta.matches.find((entry) => entry.role === 'button')
      const victim = (await post('find', ['Scoped victim'])).meta.matches.find((entry) => entry.role === 'button')
      assert.ok(remove && victim)
      const zoom = await post('look', [victim.id])
      const scopedVictim = zoom.text.match(/\b(n_[A-Za-z0-9_-]+)\s+button "Scoped victim"/)?.[1]
      assert.ok(scopedVictim, zoom.text)
      assert.equal((await post('click', [remove.id])).ok, true)

      const detachedClick = await post('click', [scopedVictim])
      assert.equal(detachedClick.ok, false)
      assert.match(detachedClick.error, /could not resolve/)
      const detachedText = await post('text', [scopedVictim])
      assert.equal(detachedText.ok, false)
      assert.match(detachedText.error, /detached id/)
      const detachedSnap = await post('snap', [scopedVictim, join(logDir, 'detached.png')])
      assert.equal(detachedSnap.ok, false)
      assert.match(detachedSnap.error, /detached id/)
      const detachedRec = await post('rec', ['0.1', scopedVictim, join(logDir, 'detached.webm')])
      assert.equal(detachedRec.ok, false)
      assert.match(detachedRec.error, /detached id/)
      const detachedZoom = await post('look', [scopedVictim])
      assert.equal(detachedZoom.ok, false)
      assert.match(detachedZoom.error, /detached id/)
      const detachedParent = await post('parent', [scopedVictim])
      assert.equal(detachedParent.ok, false)
      assert.match(detachedParent.error, /detached id/)
      const refreshed = await post('look')
      assert.equal(refreshed.ok, true, refreshed.error)
      assert.equal((await post('find', ['Trap fired'])).meta.matches.length, 0,
        'detached click must not hit an accidental target at 0,0')
      assert.ok((await post('find', ['Trap idle'])).meta.matches.length > 0)
    })

    await t.test('preserves sibling same-name actions while deduping wrapper badge chains', async () => {
      const siblingsHtml = `<!doctype html><style>button,a{width:180px;height:36px;margin:8px;display:block}</style>
        <div id="row-a"><button onclick="this.parentElement.textContent='Removed A'">Remove</button></div>
        <div id="row-b"><button onclick="this.parentElement.textContent='Removed B'">Remove</button></div>
        <a href="#cart" onclick="cartResult.textContent='Cart clicked';return false"><span>1</span></a>
        <p id="cartResult">Cart idle</p>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(siblingsHtml)}`])
      assert.equal(opened.ok, true, opened.error)
      const removes = (await post('find', ['Remove'])).meta.matches.filter((entry) => entry.role === 'button' && entry.name === 'Remove')
      assert.equal(removes.length, 2, JSON.stringify(removes))
      assert.notEqual(removes[0].id, removes[1].id)
      assert.equal((await post('click', [removes[1].id])).ok, true)
      const changed = await post('look')
      assert.equal(changed.meta.changed, true)
      assert.ok((await post('find', ['Removed B'])).meta.matches.length > 0)
      const secondOnly = await post('assert', [JSON.stringify({ exists: 'Remove', keepBaseline: true })])
      assert.equal(secondOnly.meta.assert.pass, true)

      const ones = (await post('find', ['1'])).meta.matches.filter((entry) => entry.name === '1')
      assert.equal(ones.filter((entry) => entry.role === 'link').length, 1, JSON.stringify(ones))
      assert.equal(ones.some((entry) => entry.role === 'generic'), false,
        'wrapper badge must still dedupe to the actionable link')
    })

    await t.test('checks notCovered against rendered prose as well as actionables', async () => {
      const coverageHtml = `<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; min-height: 2400px; font: 16px sans-serif }
        p, button { position: absolute; left: 32px; width: 280px; margin: 0 }
        #clear { top: 24px; height: 32px }
        #duplicate-hidden { top: 80px; height: 32px; visibility: hidden }
        #duplicate-visible { top: 112px; height: 32px }
        #covered { top: 176px; height: 32px }
        #cover { position: absolute; z-index: 10; left: 24px; top: 168px;
          width: 296px; height: 48px; background: white }
        #actionable { top: 240px; height: 36px }
        #offscreen { top: 2100px; height: 32px }
      </style>
      <p id="clear">Visible prose is unobstructed</p>
      <p id="duplicate-hidden">Duplicate prose has a visible winner</p>
      <p id="duplicate-visible">Duplicate prose has a visible winner</p>
      <p id="covered">Covered prose is behind an overlay</p>
      <div id="cover" aria-hidden="true"></div>
      <button id="actionable">Existing actionable remains clear</button>
      <p id="offscreen">Offscreen prose must not pass</p>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(coverageHtml)}`])
      assert.equal(opened.ok, true, opened.error)

      const check = async (query) => {
        const result = await post('assert', [JSON.stringify({ notCovered: query, keepBaseline: true })])
        assert.equal(result.ok, true, result.error)
        return result.meta.assert.checks.find((entry) => entry.type === 'notCovered')
      }
      assert.deepEqual(await check('Visible prose is unobstructed'), {
        type: 'notCovered', expected: 'Visible prose is unobstructed', actual: 'clear', pass: true,
      })
      assert.deepEqual(await check('Covered prose is behind an overlay'), {
        type: 'notCovered', expected: 'Covered prose is behind an overlay', actual: 'covered', pass: false,
      })
      assert.deepEqual(await check('Duplicate prose has a visible winner'), {
        type: 'notCovered', expected: 'Duplicate prose has a visible winner', actual: 'clear', pass: true,
      })
      assert.deepEqual(await check('Existing actionable remains clear'), {
        type: 'notCovered', expected: 'Existing actionable remains clear', actual: 'clear', pass: true,
      })
      assert.deepEqual(await check('Offscreen prose must not pass'), {
        type: 'notCovered', expected: 'Offscreen prose must not pass', actual: 'clear·offscreen', pass: false,
      })
    })

    await t.test('does not return changed:false green when a value change is unobservable', async () => {
      const secretUrl = `data:text/html,${encodeURIComponent('<label for="pw">Password</label><input id="pw" type="password" value="same-length">')}`
      const opened = await post('open', [secretUrl])
      assert.equal(opened.ok, true, opened.error)

      const verdict = await post('assert', [JSON.stringify({ changed: false, keepBaseline: true })])
      assert.equal(verdict.meta.assert.pass, false)
      assert.match(String(verdict.meta.assert.checks.find((check) => check.type === 'changed')?.actual), /unknown: 1 unobservable/)
      assert.equal(verdict.meta.assert.unobservableDetails[0].sourceType, 'sensitive-input-value')

      const negativeClaims = await post('assert', [JSON.stringify({
        mustNotInclude: [{ kind: 'content' }],
        only: [{ kind: 'content' }],
        maxChanges: 0,
        keepBaseline: true,
      })])
      assert.equal(negativeClaims.meta.assert.pass, false)
      for (const type of ['mustNotInclude', 'only', 'maxChanges']) {
        const check = negativeClaims.meta.assert.checks.find((entry) => entry.type === type)
        assert.equal(check.pass, false, `${type} must not pass over an opaque region`)
        assert.match(String(check.actual), /unknown: 1 unobservable/)
      }
    })

    await t.test('does not return a negative diff green when the chunked observation is torn', async () => {
      const tornHtml = `<!doctype html><p>Stable semantic text</p><script>
        document.body.insertAdjacentHTML('beforeend', '<span>x</span>'.repeat(12000))
        setInterval(() => { document.body.dataset.capturePulse = String(performance.now()) }, 0)
      </script>`
      const opened = await post('open', [`data:text/html,${encodeURIComponent(tornHtml)}`])
      assert.equal(opened.ok, true, opened.error)

      const verdict = await post('assert', [JSON.stringify({ changed: false, keepBaseline: true })])
      assert.equal(verdict.meta.assert.pass, false)
      assert.ok(verdict.meta.assert.torn > 0, JSON.stringify(verdict.meta.assert))
      assert.match(String(verdict.meta.assert.checks.find((check) => check.type === 'changed')?.actual), /unknown: .*torn capture/)
    })

    await t.test('blocks privacy URL probes and rejects coercive assertion specs', async () => {
      const hidden = 'private secret'
      const encodedHidden = encodeURIComponent(hidden)
      const privateUrl = `data:text/html,${encodeURIComponent(`<button>${hidden}</button>`)}`
      const opened = await post('open', [privateUrl, '--redact-json', JSON.stringify([hidden])])
      assert.equal(opened.ok, true, opened.error)
      assert.equal(JSON.stringify(opened).includes(hidden), false)
      const unchanged = await post('look')
      assert.equal(unchanged.meta.changed, false, JSON.stringify(unchanged.meta.changes || []))
      assert.equal(JSON.stringify(unchanged).includes(hidden), false)

      for (const query of [hidden, encodedHidden]) {
        const probe = await post('assert', [JSON.stringify({ url: query, keepBaseline: true })])
        assert.equal(probe.ok, true)
        assert.equal(probe.meta.assert.pass, false)
        assert.equal(probe.meta.assert.checks.find((check) => check.type === 'url')?.actual, 'blocked by privacy rule')
        const wire = JSON.stringify(probe).toLowerCase()
        assert.equal(wire.includes(hidden), false)
        assert.equal(wire.includes(encodedHidden.toLowerCase()), false)
      }

      const coveredProbe = await post('assert', [JSON.stringify({ notCovered: hidden, keepBaseline: true })])
      assert.equal(coveredProbe.ok, true)
      assert.equal(coveredProbe.meta.assert.pass, false)
      assert.deepEqual(coveredProbe.meta.assert.checks.find((check) => check.type === 'notCovered'), {
        type: 'notCovered', expected: '[redacted]', actual: 'blocked by privacy rule', pass: false,
      })
      assert.equal(JSON.stringify(coveredProbe).includes(hidden), false)

      const validControl = await post('assert', [JSON.stringify({ url: 'data:', keepBaseline: true })])
      assert.equal(validControl.meta.assert.pass, true, JSON.stringify(validControl.meta.assert.checks))

      const malformed = [
        { maxChanges: '999' },
        { changed: 'true' },
        { url: 42 },
        { changed: false, settleMs: '1' },
        { changed: false, keepBaseline: 'yes' },
        { mustNotInclude: [{ role: 42 }] },
        { mustNotInclude: [{ to: null }] },
        { mustNotInclude: [{ to: { expanded: 1 } }] },
        { changed: true, retry: { budgetMs: 10, intervalMs: '1' } },
        { becameCovered: {} },
        { changed: true, ignore: [''] },
      ]
      for (const spec of malformed) {
        const result = await post('assert', [JSON.stringify(spec)])
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.meta.assert.pass, false, `malformed spec passed: ${JSON.stringify(spec)}`)
        assert.ok(result.meta.assert.checks.some((check) => check.type === 'spec' && check.pass === false), JSON.stringify(result.meta.assert.checks))
      }
    })

    await t.test('publishes coherent hash-route evidence without leaking query or privacy terms', async () => {
      const secret = 'route secret/person'
      const routeUrl = `data:text/html,${encodeURIComponent('<p>hash route fixture</p>')}#/active`
      const opened = await post('open', [routeUrl, '--redact-json', JSON.stringify([secret])])
      assert.equal(opened.ok, true, opened.error)
      const route = await post('assert', [JSON.stringify({ urlIncludes: '#/active', keepBaseline: true })])
      assert.equal(route.meta.assert.pass, true, JSON.stringify(route.meta.assert.checks))
      const routeCheck = route.meta.assert.checks.find((check) => check.type === 'url')
      assert.match(routeCheck.actual, /^data:«\d+ chars»#\/active$/)

      const fixture = createServer((_req, response) => {
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><p>query and hash route fixture</p>')
      })
      await new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', done)
      })
      try {
        const fixturePort = fixture.address().port
        const queried = await post('open', [`http://127.0.0.1:${fixturePort}/clean?owner=public-query#/active`])
        assert.equal(queried.ok, true, queried.error)
        const queryRoute = await post('assert', [JSON.stringify({ urlIncludes: '#/active', keepBaseline: true })])
        const queryCheck = queryRoute.meta.assert.checks.find((check) => check.type === 'url')
        assert.equal(queryRoute.meta.assert.pass, true, JSON.stringify(queryRoute.meta.assert.checks))
        assert.match(queryCheck.actual, /\/clean\?«18 chars»#\/active$/)
        assert.equal(queryCheck.actual.includes('public-query'), false)
      } finally {
        fixture.closeAllConnections?.()
        await new Promise((done) => fixture.close(done))
      }

      const hiddenUrl = `data:text/html,${encodeURIComponent('<p>hidden route fixture</p>')}#/${encodeURIComponent(secret)}`
      const hidden = await post('open', [hiddenUrl, '--redact-json', JSON.stringify([secret])])
      assert.equal(hidden.ok, true, hidden.error)
      const encodedProbe = await post('assert', [JSON.stringify({ urlIncludes: encodeURIComponent(secret), keepBaseline: true })])
      assert.equal(encodedProbe.meta.assert.pass, false)
      assert.equal(encodedProbe.meta.assert.checks.find((check) => check.type === 'url')?.actual, 'blocked by privacy rule')
      assert.equal(JSON.stringify(encodedProbe).includes(secret), false)
      assert.equal(JSON.stringify(encodedProbe).includes(encodeURIComponent(secret)), false)
    })

    await t.test('rejects checkpoint traversal and namespaces persisted checkpoints by session', async () => {
      const valid = await post('cp', ['save', 'safe.one'])
      assert.equal(valid.ok, true, valid.error)
      assert.equal(resolve(valid.meta.file).startsWith(resolve(logDir) + '/'), true)
      assert.equal(JSON.parse(await readFile(valid.meta.file, 'utf8')).sessionId, 's_default')
      assert.equal((await stat(valid.meta.file)).mode & 0o777, 0o600)
      assert.equal((await stat(logDir)).mode & 0o777, 0o700)

      const traversal = await post('cp', ['save', `../../../${escapedName}`])
      assert.equal(traversal.ok, false)
      assert.match(traversal.error, /invalid checkpoint name/)
      await assert.rejects(readFile(escapedPath), { code: 'ENOENT' })
    })

    await t.test('returns ok:false for invalid click targets and failed checkpoint operations', async () => {
      const invalidClick = await post('click', ['definitely-not-a-current-id'])
      assert.equal(invalidClick.ok, false)
      assert.match(invalidClick.error, /could not resolve/)

      const openedSession = await post('session', ['open'])
      const emptySession = openedSession.meta.sessionId
      const noBaseline = await post('cp', ['save', 'too-early'], emptySession)
      assert.equal(noBaseline.ok, false)
      assert.match(noBaseline.error, /no observation yet/)
      const unknown = await post('cp', ['diff', 'does-not-exist'], emptySession)
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /unknown checkpoint/)
      assert.equal((await post('session', ['close', emptySession])).ok, true)
    })

    let sessionA
    let sessionB
    const privacyHtml = '<!doctype html><button>Alpha</button><button>Beta</button><p>Gamma</p>'
    const privacyUrl = `data:text/html,${encodeURIComponent(privacyHtml)}`

    await t.test('keeps privacy rules, revisions and future-navigation sync per session', async () => {
      const openedA = await post('session', ['open'])
      const openedB = await post('session', ['open'])
      sessionA = openedA.meta.sessionId
      sessionB = openedB.meta.sessionId
      assert.notEqual(sessionA, sessionB)

      const [a, b] = await Promise.all([
        post('open', [privacyUrl, '--redact-json', JSON.stringify(['Alpha'])], sessionA),
        post('open', [privacyUrl, '--redact-json', JSON.stringify(['Beta'])], sessionB),
      ])
      const aWire = JSON.stringify(a).toLowerCase()
      const bWire = JSON.stringify(b).toLowerCase()
      assert.equal(aWire.includes('alpha'), false, aWire)
      assert.equal(aWire.includes('beta'), true, aWire)
      assert.equal(bWire.includes('beta'), false, bWire)
      assert.equal(bWire.includes('alpha'), true, bWire)
      assert.deepEqual(a.meta.privacy, { policyRevision: 1, rulesActive: 1, applied: true })
      assert.deepEqual(b.meta.privacy, { policyRevision: 1, rulesActive: 1, applied: true })

      const savedUnderAlpha = await post('cp', ['save', 'policy-v1'], sessionA)
      assert.equal(savedUnderAlpha.ok, true, savedUnderAlpha.error)
      assert.equal(savedUnderAlpha.meta.checkpoint, 'policy-v1')

      const revisedA = await post('redact', ['Gamma'], sessionA)
      assert.deepEqual(revisedA.meta.privacy, { policyRevision: 2, rulesActive: 1, applied: true })
      assert.ok(revisedA.meta.baselinesInvalidated >= 1)
      assert.equal(revisedA.meta.namedCheckpointsStale, 1)
      const staleCheckpoint = await post('cp', ['diff', 'policy-v1'], sessionA)
      assert.equal(staleCheckpoint.ok, false)
      assert.match(staleCheckpoint.error, /privacy policy revision 1/)
      const firstAfterPolicyChange = await post('look', [], sessionA)
      assert.equal(firstAfterPolicyChange.ok, true, firstAfterPolicyChange.error)
      assert.equal('changed' in firstAfterPolicyChange.meta, false, 'policy change must force a fresh baseline instead of a cross-policy diff')
      const [aBeta, bBeta] = await Promise.all([
        post('find', ['Beta'], sessionA),
        post('find', ['Beta'], sessionB),
      ])
      assert.ok(aBeta.meta.matches.length > 0, 'session A must expose Beta after its own policy changes')
      assert.equal(bBeta.meta.matches.length, 0, 'session B must keep redacting Beta')
      assert.equal(aBeta.meta.privacy.policyRevision, 2)
      assert.equal(bBeta.meta.privacy.policyRevision, 1)

      const [aNavigated, bNavigated] = await Promise.all([
        post('open', [privacyUrl], sessionA),
        post('open', [privacyUrl], sessionB),
      ])
      const aNavigatedWire = JSON.stringify(aNavigated).toLowerCase()
      const bNavigatedWire = JSON.stringify(bNavigated).toLowerCase()
      assert.equal(aNavigatedWire.includes('gamma'), false, aNavigatedWire)
      assert.equal(aNavigatedWire.includes('beta'), true, aNavigatedWire)
      assert.equal(bNavigatedWire.includes('beta'), false, bNavigatedWire)
      assert.equal(aNavigated.meta.privacy.policyRevision, 2)
      assert.equal(bNavigated.meta.privacy.policyRevision, 1)
      const [aGamma, bGamma] = await Promise.all([
        post('find', ['Gamma'], sessionA),
        post('find', ['Gamma'], sessionB),
      ])
      assert.equal(aGamma.meta.matches.length, 0, 'session A must keep redacting Gamma after navigation')
      assert.ok(bGamma.meta.matches.length > 0, 'session B must expose Gamma after its independent navigation')
    })

    await t.test('isolates cookies and storage between sessions', async () => {
      const fixture = createServer((req, response) => {
        response.setHeader('content-type', 'text/html')
        if (req.url === '/set') response.setHeader('set-cookie', 'snapdom_session=A; Path=/')
        response.end(`<!doctype html><p>${req.headers.cookie || 'no-cookie'}</p>`)
      })
      await new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', done)
      })
      try {
        const fixturePort = fixture.address().port
        const signedInUnknown = await post('open', [`http://127.0.0.1:${fixturePort}/set`], sessionA)
        assert.equal(signedInUnknown.ok, true)
        assert.equal(signedInUnknown.meta.authState, 'unknown')
        assert.ok(signedInUnknown.meta.cookiesForOrigin >= 1)
        const other = await post('open', [`http://127.0.0.1:${fixturePort}/read`], sessionB)
        assert.equal(other.ok, true, other.error)
        assert.equal(JSON.stringify(other).includes('snapdom_session=A'), false)
        assert.equal(other.meta.cookiesForOrigin, 0)
        assert.equal(other.meta.authState, 'unknown', 'an empty cookie jar cannot prove anonymity')
      } finally {
        await new Promise((done) => fixture.close(done))
      }
    })

    await t.test('closes a session complete with its parent page and popup tree', async () => {
      let pings = 0
      let slowCompleted = false
      let popupSession
      const fixture = createServer((req, response) => {
        if (req.url === '/ping') { pings++; response.end('ok'); return }
        if (req.url === '/slow') {
          delayTimer(() => { slowCompleted = true; response.end('ready') }, 450)
          return
        }
        response.setHeader('content-type', 'text/html')
        if (req.url === '/child') {
          response.end(`<!doctype html><p>Child marker</p><button onclick="window.close()">Close child</button><script>fetch('/slow').then(() => document.body.dataset.ready = 'yes')</script>`)
          return
        }
        response.end(`<!doctype html><p>Parent marker</p><button onclick="window.open('/child')">Open child</button><script>setInterval(()=>fetch('/ping'), 40)</script>`)
      })
      await new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', done)
      })
      try {
        const fixturePort = fixture.address().port
        const openedSession = await post('session', ['open'])
        popupSession = openedSession.meta.sessionId
        assert.equal((await post('open', [`http://127.0.0.1:${fixturePort}/parent`], popupSession)).ok, true)
        const found = await post('find', ['Open child'], popupSession)
        const opener = found.meta.matches.find((entry) => entry.name === 'Open child')
        assert.ok(opener)
        assert.equal((await post('click', [opener.id], popupSession)).ok, true)
        assert.equal(slowCompleted, true, 'popup requests must participate in adaptive settle')
        const observedChild = await post('look', [], popupSession)
        assert.equal(observedChild.ok, true, observedChild.error)
        const child = await post('find', ['Child marker'], popupSession)
        assert.ok(child.meta.matches.some((entry) => entry.name.includes('Child marker')), JSON.stringify(child.meta.matches))
        const close = await post('find', ['Close child'], popupSession)
        const closeButton = close.meta.matches.find((entry) => entry.name === 'Close child')
        assert.ok(closeButton)
        assert.equal((await post('click', [closeButton.id], popupSession)).ok, true)
        const restoredParent = await post('find', ['Parent marker'], popupSession)
        assert.ok(restoredParent.meta.matches.some((entry) => entry.name.includes('Parent marker')), 'closing the active popup must restore its live opener')
        assert.ok(pings > 0)
        assert.equal((await post('session', ['close', popupSession])).ok, true)
        const afterClose = pings
        await delay(250)
        assert.ok(pings - afterClose <= 1, `parent page kept running after session close: ${pings - afterClose} pings`)
      } finally {
        if (popupSession) await post('session', ['close', popupSession]).catch(() => {})
        fixture.closeAllConnections?.()
        await new Promise((done) => fixture.close(done))
      }
    })

    await t.test('rehydrates the opener before reads after a popup closes', async () => {
      let popupSession
      const fixture = createServer((req, response) => {
        response.setHeader('content-type', 'text/html')
        if (req.url === '/child') {
          response.end('<!doctype html><button onclick="window.close()">Close child</button>')
          return
        }
        response.end(`<!doctype html>
          <button id="open" onclick="window.open('/child');setTimeout(()=>marker.textContent='Parent fresh',50)">Open child</button>
          <p id="marker">Parent stale</p>`)
      })
      await new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', done)
      })
      try {
        const openedSession = await post('session', ['open'])
        popupSession = openedSession.meta.sessionId
        const fixturePort = fixture.address().port
        const opened = await post('open', [`http://127.0.0.1:${fixturePort}/parent`], popupSession)
        assert.equal(opened.ok, true, opened.error)
        const parentEpoch = opened.epoch
        const opener = (await post('find', ['Open child'], popupSession)).meta.matches.find((entry) => entry.role === 'button')
        assert.ok(opener)
        assert.equal((await post('click', [opener.id], popupSession)).ok, true)
        const childView = await post('look', [], popupSession)
        const childEpoch = childView.epoch
        assert.ok(childEpoch > parentEpoch)
        const close = (await post('find', ['Close child'], popupSession)).meta.matches.find((entry) => entry.role === 'button')
        assert.ok(close)
        assert.equal((await post('click', [close.id], popupSession)).ok, true)

        const freshParent = await post('find', ['Parent fresh'], popupSession)
        assert.equal(freshParent.ok, true, freshParent.error)
        assert.ok(freshParent.epoch > childEpoch, 'restoring the opener must establish a fresh full epoch')
        assert.ok(freshParent.meta.matches.some((entry) => entry.name.includes('Parent fresh')), JSON.stringify(freshParent.meta.matches))
        assert.equal(freshParent.meta.pageSwitched, true)
        const staleProbe = await post('find', ['Parent stale'], popupSession)
        assert.equal(staleProbe.meta.matches.length, 0, 'pre-popup opener UI must not revive')
        assert.equal((await post('click', [opener.id], popupSession)).ok, false,
          'an opener id from before the popup must expire on rehydration')
      } finally {
        if (popupSession) await post('session', ['close', popupSession]).catch(() => {})
        fixture.closeAllConnections?.()
        await new Promise((done) => fixture.close(done))
      }
    })

    await t.test('carries strong identity across same-origin navigations only', async () => {
      const html = (badge, body) => `<!doctype html><header><span data-testid="cart-badge">${badge}</span><nav aria-label="Principal"><a href="/b" aria-label="Ver producto">Ver producto</a></nav></header><main>${body}</main>`
      const fixture = createServer((req, response) => {
        response.setHeader('content-type', 'text/html')
        if (req.url === '/b') { response.end(html('2', '<h1>Detalle</h1><p>Ficha completa</p>')); return }
        response.end(html('1', '<h1>Bienvenido</h1><button>Suscribirme</button>'))
      })
      await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', done) })
      const foreignFixture = createServer((req, response) => {
        response.setHeader('content-type', 'text/html')
        response.end(html('9', '<h1>Otro sitio</h1>'))
      })
      await new Promise((done, reject) => { foreignFixture.once('error', reject); foreignFixture.listen(0, '127.0.0.1', done) })
      try {
        const session = (await post('session', ['open'])).meta.sessionId
        const fixturePort = fixture.address().port

        const first = await post('open', [`http://127.0.0.1:${fixturePort}/a`], session)
        assert.equal(first.ok, true, first.error)
        assert.equal(first.meta.carried, undefined, 'the first page has no baseline to carry from')

        const second = await post('open', [`http://127.0.0.1:${fixturePort}/b`], session)
        assert.equal(second.ok, true, second.error)
        const carried = second.meta.carried
        assert.ok(carried, 'a same-origin navigation must produce a carried report')
        assert.equal(carried.comparedBy, 'CROSS_PAGE_STRONG_IDENTITY_ONLY')
        const badgeChange = carried.changed.find((c) => c.key === 't:cart-badge')
        assert.ok(badgeChange, 'the badge transition must be itemized')
        assert.equal(badgeChange.from.text, '1')
        assert.equal(badgeChange.to.text, '2')
        assert.ok(carried.matches >= 2, 'badge and nav identity persisted')
        // Unmatched page content is COUNTED, never described: different-page content
        // is different, not changed — and never leaks into the report.
        assert.equal(JSON.stringify(carried).includes('Bienvenido'), false)
        assert.equal(JSON.stringify(carried).includes('Ficha'), false)

        const foreign = await post('open', [`http://127.0.0.1:${foreignFixture.address().port}/a`], session)
        assert.equal(foreign.ok, true, foreign.error)
        assert.equal(foreign.meta.carried, undefined, 'a cross-origin navigation must never claim persistence')

        // Same-origin again AFTER the foreign hop: the baseline was rebuilt on the
        // foreign page, so this is a fresh cross-origin pair and must stay silent too.
        const back = await post('open', [`http://127.0.0.1:${fixturePort}/a`], session)
        assert.equal(back.ok, true, back.error)
        assert.equal(back.meta.carried, undefined, 'returning from another origin starts fresh')
      } finally {
        await new Promise((done) => fixture.close(done))
        await new Promise((done) => foreignFixture.close(done))
      }
    })

    await t.test('scroll hydrates lazy content without acting and keeps ids valid', async () => {
      // Round-4 field case: a listing that only materializes its rows on scroll.
      const html = '<!doctype html><meta charset="utf-8"><h1>Lazy list</h1>' +
        '<div style="height:3000px">tall spacer</div><ul id="list"></ul>' +
        '<script>let fired=false;addEventListener("scroll",()=>{if(fired||window.scrollY<2000)return;fired=true;' +
        "document.getElementById('list').innerHTML='<li><a href=\"#a\">Hydrated item alpha</a></li><li><a href=\"#b\">Hydrated item beta</a></li>'})</script>"
      const session = (await post('session', ['open'])).meta.sessionId
      const opened = await post('open', [`data:text/html;charset=utf-8,${encodeURIComponent(html)}`], session)
      assert.equal(opened.ok, true, opened.error)
      const before = await post('find', ['Hydrated item'], session)
      assert.equal((before.meta.matches || []).length, 0, 'lazy content must not exist before scroll')

      const scrolled = await post('scroll', ['bottom'], session)
      assert.equal(scrolled.ok, true, scrolled.error)
      assert.ok(scrolled.meta.y > 1500, 'must actually scroll')

      const diff = await post('look', [], session)
      assert.equal(diff.ok, true, diff.error)
      assert.ok(diff.meta.changed, 'the hydrated rows are a real diff')
      const found = await post('find', ['Hydrated item alpha'], session)
      assert.ok((found.meta.matches || []).some((m) => /alpha/.test(m.name || m.text || '')),
        'hydrated content must be findable after scroll+look')
    })

    await t.test('text falls back to the accessible name, declared as such', async () => {
      // Parity round 3: Google Flights rows carry the whole fare in aria-label and no
      // visible text — both models got "(no text)" from a node whose name had it all.
      const html = '<!doctype html><a aria-label="Desde 975 dólares. Vuelo sin escalas de Plus Ultra" href="#fare"><svg width="40" height="12"></svg></a><p>Visible paragraph</p>'
      const opened = await post('open', [`data:text/html;charset=utf-8,${encodeURIComponent(html)}`])
      assert.equal(opened.ok, true, opened.error)
      const fare = await post('find', ['975'])
      const match = fare.meta.matches?.find((entry) => entry.role === 'link')
      assert.ok(match, JSON.stringify(fare.meta))
      const read = await post('text', [match.id])
      assert.equal(read.ok, true, read.error)
      assert.match(read.meta.text, /975 dólares/)
      assert.equal(read.meta.textSource, 'accessible-name')
      assert.match(read.text, /accessible name — the node has no visible text/)
      // Visible text keeps winning and says so.
      const para = await post('find', ['Visible paragraph'])
      const readPara = await post('text', [para.meta.matches[0].id])
      assert.equal(readPara.meta.textSource, 'inner-text')
    })

    await t.test('a dead session id gets a diagnosis, not "unknown"', async () => {
      const opened = await post('session', ['open'])
      const sid = opened.meta.sessionId
      const closed = await post('session', ['close', sid])
      assert.equal(closed.ok, true, closed.error)
      const late = await post('open', ['data:text/html,late'], sid)
      assert.equal(late.ok, false)
      assert.match(String(late.error), /was closed — open a fresh one/)
      // A never-existing id keeps the original honest answer.
      const ghost = await post('open', ['data:text/html,ghost'], 's_ghost')
      assert.match(String(ghost.error), /unknown session/)
    })

    await t.test('reports a status-200 reCAPTCHA wall as blocked, never as a thin page', async () => {
      // Field-found by two models in one parity run: MercadoLibre's /captcha/wall
      // serves HTTP 200 and no legacy marker matched, so blocked:true never reached
      // either consumer and both had to infer the block from prose.
      const fixture = createServer((req, response) => {
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><html><head><title>Verificación</title></head><body>' +
          '<h1>Por seguridad, completá este paso</h1>' +
          '<script src="https://www.google.com/recaptcha/api.js"></script>' +
          '<div class="g-recaptcha"></div></body></html>')
      })
      await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', done) })
      try {
        const session = (await post('session', ['open'])).meta.sessionId
        const opened = await post('open', [`http://127.0.0.1:${fixture.address().port}/captcha/wall`], session)
        assert.equal(opened.ok, true, opened.error)
        assert.equal(opened.meta.blocked, true, 'a 200-status captcha wall must still report blocked')
        assert.equal(opened.meta.challenge.vendor, 'recaptcha')
        assert.match(opened.text, /BLOCKED/i)
      } finally {
        await new Promise((done) => fixture.close(done))
      }
    })

    await t.test('labels screenshots, snapdom captures and recordings as unredacted pixels', async () => {
      const openedSession = await post('session', ['open'])
      const pixelSession = openedSession.meta.sessionId
      const opened = await post('open', [privacyUrl, '--redact-json', JSON.stringify(['Gamma'])], pixelSession)
      assert.equal(opened.ok, true, opened.error)
      const commands = [
        ['shot', [join(logDir, 'privacy-shot.jpg')]],
        ['snap', [join(logDir, 'privacy-snap.png')]],
        ['rec', ['0.1', join(logDir, 'privacy-rec.webm')]],
      ]
      for (const [cmd, args] of commands) {
        const result = await post(cmd, args, pixelSession)
        assert.equal(result.ok, true, `${cmd}: ${result.error}`)
        assert.equal(result.meta.pixelsRedacted, false)
        assert.deepEqual(result.meta.privacy, { policyRevision: 1, rulesActive: 1, pixelsRedacted: false })
        assert.equal('applied' in result.meta.privacy, false, `${cmd} must not imply that semantic redaction altered pixels`)
      }
      assert.equal((await post('session', ['close', pixelSession])).ok, true)
    })

    await t.test('fails closed when asked to close an unknown or default session', async () => {
      const unknown = await post('session', ['close', 's_does_not_exist'])
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /unknown session/)
      const defaultClose = await post('session', ['close', 's_default'])
      assert.equal(defaultClose.ok, false)
      assert.match(defaultClose.error, /default session cannot be closed/)
    })

    await t.test('keeps the oracle and privacy policy outside the page JavaScript world', async () => {
      const hostileHtml = `<!doctype html><script>
        window.__SD_PRIVACY_REV = Infinity
        window.__SD_PRIVACY = null
        window.__agentRedact = value => value
        window.__agentObserveChunked = async () => { throw new Error(document.body.innerText) }
        window.__agentBuildUi = () => ({ changed: false, privacy: undefined })
      </script><h1>TOPSECRET private heading</h1><button>TOPSECRET action</button>`
      const hostileUrl = `data:text/html,${encodeURIComponent(hostileHtml)}`
      const opened = await post('open', [hostileUrl, '--redact-json', JSON.stringify(['TOPSECRET'])], sessionA)
      assert.equal(opened.ok, true, opened.error)
      const wire = JSON.stringify(opened)
      assert.equal(wire.includes('TOPSECRET'), false, wire)
      assert.deepEqual(opened.meta.privacy, { policyRevision: 3, rulesActive: 1, applied: true })
      assert.match(wire, /\[redacted\]/)
      const restored = await post('open', [privacyUrl, '--redact-json', JSON.stringify(['Gamma'])], sessionA)
      assert.equal(restored.ok, true, restored.error)
    })

    await t.test('redacts encoded URLs and baseline URLs before truncation or logging', async () => {
      const secret = 'alice@corp.test'
      const encoded = encodeURIComponent(secret)
      const fixture = createServer((_req, response) => {
        response.setHeader('content-type', 'text/html')
        response.end(`<!doctype html><a href="/users/${encoded}?email=${encoded}">Profile</a><button onclick="history.pushState({}, '', '/after')">Move</button>`)
      })
      await new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.listen(0, '127.0.0.1', done)
      })
      try {
        const fixturePort = fixture.address().port
        const opened = await post('open', [`http://127.0.0.1:${fixturePort}/users/${encoded}`, '--redact-json', JSON.stringify([secret])], sessionA)
        assert.equal(opened.ok, true, opened.error)
        assert.equal(JSON.stringify(opened).includes(encoded), false)
        const found = await post('find', ['Profile'], sessionA)
        assert.equal(JSON.stringify(found).includes(encoded), false)
        const move = await post('find', ['Move'], sessionA)
        const button = move.meta.matches.find((entry) => entry.name === 'Move')
        assert.ok(button)
        assert.equal((await post('click', [button.id], sessionA)).ok, true)
        const verified = await post('look', [], sessionA)
        assert.equal(JSON.stringify(verified).includes(secret), false)
        assert.equal(JSON.stringify(verified).includes(encoded), false)
        assert.equal(JSON.stringify(verified.meta).includes('/users/'), false, 'baseline URL must be fully redacted')
      } finally {
        await new Promise((done) => fixture.close(done))
      }
    })

    await t.test('publishes MCP session schemas and serializes routing outside assert specs', async () => {
      const restored = await post('open', [privacyUrl], sessionA)
      assert.equal(restored.ok, true, restored.error)
      mcp = spawn(process.execPath, [MCP], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
      const client = mcpClient(mcp)
      rpc = client.call
      await rpc('initialize', { protocolVersion: '2024-11-05' })
      const listed = await rpc('tools/list')
      const verify = listed.tools.find((tool) => tool.name === 'browser_verify')
      const browserAssert = listed.tools.find((tool) => tool.name === 'browser_assert')
      assert.equal(verify.inputSchema.properties.sessionId.type, 'string')
      assert.equal(browserAssert.inputSchema.properties.sessionId.type, 'string')
      assert.equal('sessionId' in browserAssert.inputSchema.properties.mustInclude.items.properties, false)
      assert.equal('sessionId' in browserAssert.inputSchema.properties.retry.properties, false)

      // Cross-client portability: a top-level schema union broke a real client (Codex
      // CLI projected the oneOf branches as complete signatures and lost `target`/
      // `text`, so clicks died client-side and never reached this server). Every tool
      // schema stays FLAT; per-action requirements fail loud SERVER-side instead.
      for (const tool of listed.tools) {
        for (const key of ['oneOf', 'anyOf', 'allOf']) {
          assert.equal(key in tool.inputSchema, false, `${tool.name} inputSchema must be flat (found ${key})`)
        }
      }
      const act = listed.tools.find((tool) => tool.name === 'browser_act')
      assert.equal(act.inputSchema.properties.target.type, 'string')
      assert.equal(act.inputSchema.properties.text.type, 'string')
      const pageTool = listed.tools.find((tool) => tool.name === 'browser_page')
      assert.equal(pageTool.inputSchema.properties.id.type, 'string')
      const clickNoTarget = await rpc('tools/call', { name: 'browser_act', arguments: { action: 'click' } })
      assert.equal(clickNoTarget.isError, true)
      assert.match(clickNoTarget.content[0].text, /click requires target/)
      const zoomNoId = await rpc('tools/call', { name: 'browser_page', arguments: { view: 'zoom' } })
      assert.equal(zoomNoId.isError, true)
      assert.match(zoomNoId.content[0].text, /zoom requires id/)

      for (const arguments_ of [{}, { action: 'entter' }]) {
        const invalidAction = await rpc('tools/call', {
          name: 'browser_act',
          arguments: arguments_,
        })
        assert.equal(invalidAction.isError, true)
        assert.match(invalidAction.content[0].text, /invalid arguments/)
      }
      const invalidOpen = await rpc('tools/call', {
        name: 'browser_open',
        arguments: { url: 42 },
      })
      assert.equal(invalidOpen.isError, true)
      assert.match(invalidOpen.content[0].text, /url must be string/)
      const nullOpen = await rpc('tools/call', {
        name: 'browser_open',
        arguments: null,
      })
      assert.equal(nullOpen.isError, true)
      assert.match(nullOpen.content[0].text, /must be object/)

      const verified = await rpc('tools/call', {
        name: 'browser_verify',
        arguments: { sessionId: sessionA },
      })
      assert.equal(verified.structuredContent.sessionId, sessionA)

      const asserted = await rpc('tools/call', {
        name: 'browser_assert',
        arguments: { sessionId: sessionA, exists: 'Beta', keepBaseline: true },
      })
      assert.equal(asserted.structuredContent.sessionId, sessionA)
      assert.equal(asserted.structuredContent.pass, true, JSON.stringify(asserted.structuredContent.checks))
      assert.equal(asserted.isError, false)

      const badClose = await rpc('tools/call', {
        name: 'browser_session_close',
        arguments: { sessionId: 's_does_not_exist' },
      })
      assert.equal(badClose.isError, true)
      assert.match(badClose.content[0].text, /unknown session/)
      client.close()
    })
  } finally {
    if (mcp) {
      try { mcp.stdin.end() } catch { /* already closed */ }
      try { await waitForExit(mcp, 1500) } catch {
        try { mcp.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    if (daemon) {
      let gracefulExit = false
      try { await post('stop') } catch { /* daemon may already be gone */ }
      try { await waitForExit(daemon, 5000); gracefulExit = true } catch {
        try { daemon.kill('SIGKILL') } catch { /* already gone */ }
      }
      if (gracefulExit) await assert.rejects(readFile(env.SNAPDOM_AGENT_TOKEN_FILE), { code: 'ENOENT' })
    }
    await rm(logDir, { recursive: true, force: true })
    await rm(escapedPath, { force: true })
  }
})
