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

const reflowFixture = ({ semantic = false, covered = false } = {}) => `<!doctype html>
  <style>
    main { display:grid; grid-template-columns:repeat(17,60px); gap:3px; margin-top:60px }
    .tile { height:24px; position:relative; left:0 }
    .paused .tile { left:9px }
    #trigger { position:fixed; left:10px; top:8px; width:200px; height:32px }
    #availability { position:absolute; left:960px; top:650px; width:90px; height:32px }
    .paused #availability { left:1100px }
    #cover { position:absolute; left:1100px; top:650px; width:90px; height:32px; z-index:10; background:gray }
  </style>
  <main>${Array.from({ length: 170 }, (_, i) => `<button class="tile" id="panel-${i}" data-testid="panel-${i}">Panel ${i}</button>`).join('')}</main>
  ${covered ? '<button id="availability" data-testid="availability">Covered destination</button><div id="cover" aria-label="Static cover"></div>' : ''}
  <button id="trigger" data-testid="trigger" aria-pressed="false" onclick="document.body.classList.add('paused');${semantic ? "this.setAttribute('aria-pressed','true');this.textContent='Resume animation'" : ''}">${semantic ? 'Pause animation' : 'Shift panels'}</button>`

test('verify presents meaningful changes before reflow and retains complete assertion evidence', { timeout: 120_000 }, async (t) => {
  const port = await freePort()
  assert.notEqual(port, 8377, 'never attach to the developer daemon')
  const temp = await mkdtemp(join(tmpdir(), 'snapsurf-change-presentation-'))
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
  const open = async (html) => ok(await call('browser_open', { url: dataUrl(html) }))
  const click = async (name) => {
    const found = ok(await call('browser_find', { text: name }))
    const button = found.matches.find((entry) => entry.role === 'button' && entry.name === name)
    assert.ok(button, JSON.stringify(found))
    ok(await call('browser_act', { action: 'click', target: button.id }))
  }
  const accountedFor = (meta) => {
    assert.equal(meta.changesShown, meta.changes.length)
    assert.equal(meta.changesShown + meta.changesOmitted, meta.changesTotal)
    assert.equal(Object.values(meta.changesOmittedByKind).reduce((sum, n) => sum + n, 0), meta.changesOmitted)
  }

  try {
    const initialized = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'change-presentation-test', version: '1' } })
    assert.ok(initialized.serverInfo, stderr)

    await t.test('a late pause control survives a 170-node reflow, with state values and explicit omissions', async () => {
      await open(reflowFixture({ semantic: true }))
      await click('Pause animation')
      const verified = await call('browser_verify')
      const meta = ok(verified)
      assert.equal(meta.changed, true)
      assert.ok(meta.changesTotal >= 172, JSON.stringify(meta))
      assert.equal(meta.changesShown, 40)
      assert.equal(meta.changes[0].kind, 'state')
      assert.equal(meta.changes[0].name, 'Resume animation')
      assert.equal(meta.changes[0].from.pressed, false)
      assert.equal(meta.changes[0].to.pressed, true)
      assert.equal(meta.changes[1].kind, 'content')
      assert.equal(meta.changes[1].name, 'Resume animation')
      assert.ok(meta.changesOmittedByKind.moved > 0)
      assert.equal(meta.changes.some((entry) => entry.name === 'Panel 169'), false)
      accountedFor(meta)
      assert.match(verified.content.map((entry) => entry.text || '').join('\n'), /40 shown; \d+ omitted/)

      const positive = ok(await call('browser_assert', {
        diffId: meta.diffId,
        mustInclude: [{ kind: 'moved', selector: '#panel-169' }, { kind: 'state', selector: '#trigger', to: { pressed: true } }],
        maxChanges: meta.changesTotal,
      }))
      assert.equal(positive.pass, true, JSON.stringify(positive))
      const negative = await call('browser_assert', {
        diffId: meta.diffId,
        mustNotInclude: [{ kind: 'moved', selector: '#panel-169' }],
        maxChanges: meta.changesShown,
        only: [{ kind: 'state' }, { kind: 'content' }],
      })
      assert.equal(negative.isError, true)
      for (const type of ['mustNotInclude', 'maxChanges', 'only']) {
        assert.equal(negative.structuredContent.checks.find((check) => check.type === type).pass, false, type)
      }
      const unchanged = ok(await call('browser_verify'))
      assert.equal(unchanged.changed, false)
      assert.equal(unchanged.changesTotal, 0)
      accountedFor(unchanged)
    })

    await t.test('pure geometry stays geometry-only and remains fully counted', async () => {
      await open(reflowFixture())
      await click('Shift panels')
      const meta = ok(await call('browser_verify'))
      assert.equal(meta.geometryOnly, true, JSON.stringify(meta))
      assert.equal(meta.changes.length, 40)
      assert.ok(meta.changes.every((change) => change.kind === 'moved' || change.kind === 'resized'))
      assert.equal(meta.changes[0].name, 'Panel 0', 'equal-priority changes retain source order')
      accountedFor(meta)
    })

    await t.test('a geometry change that affects actionability outranks unrelated reflow', async () => {
      await open(reflowFixture({ covered: true }))
      await click('Shift panels')
      const meta = ok(await call('browser_verify'))
      assert.ok(meta.actionabilityDelta.becameCovered.some((entry) => entry.name === 'Covered destination'), JSON.stringify(meta))
      assert.equal(meta.changes[0].name, 'Covered destination')
      assert.equal(meta.changes[0].kind, 'moved')
      assert.notEqual(meta.geometryOnly, true)
      accountedFor(meta)
    })

    await t.test('folded wrappers are counted as omissions and remain assertable', async () => {
      await open(`<!doctype html><button onclick="const outer=document.createElement('div');outer.id='new-root';outer.innerHTML='<div id=folded-inner><div><button>New control</button></div></div>';document.body.append(outer)">Add nested controls</button>`)
      await click('Add nested controls')
      const meta = ok(await call('browser_verify'))
      assert.ok(meta.foldedWrappers >= 2, JSON.stringify(meta))
      assert.equal(meta.changesOmitted, meta.foldedWrappers)
      assert.equal(meta.changesOmittedByKind.added, meta.foldedWrappers)
      accountedFor(meta)
      const result = ok(await call('browser_assert', { diffId: meta.diffId, mustInclude: [{ kind: 'added', selector: '#folded-inner' }] }))
      assert.equal(result.pass, true, JSON.stringify(result))
    })
  } finally {
    client.close()
    child.stdin.end()
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(temp, { recursive: true, force: true })
  }
})
