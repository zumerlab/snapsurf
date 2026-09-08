import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const hmac = (token, text) => createHmac('sha256', token).update(text).digest('hex')
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = (server) => new Promise((resolve) => server.close(resolve))

function fixture(url) {
  const covered = url.includes('covered=1')
  return `<!doctype html><html><title>Native browser controls</title>
  <style>body { font:16px sans-serif; } select { min-width:180px; height:40px; }
  .slot { position:relative; width:200px; } .cover { position:absolute; inset:0; background:gray; z-index:10; }
  #mode { color:#111; } @media(prefers-color-scheme:dark) { #mode { color:rgb(255,0,0); } }
  @media(max-width:500px) { h1 { font-size:20px; } }</style><main><h1>Control QA</h1>
  <label for="plan">Plan</label><div class="slot"><select id="plan" aria-label="Plan">
  <option value="">Choose plan</option><option value="basic" selected>Basic</option>
  <option value="internal-secret-code">Professional plan</option><option value="team">Team plan</option>
  <option value="secret-account-77">Private account</option>
  </select>${covered ? '<div class="cover">Covering panel</div>' : ''}</div>
  <p id="status">No selection events</p><input type="checkbox" aria-label="Unrelated toggle">
  <label>Disabled control<select aria-label="Disabled control" disabled><option>Unchanged</option><option>Later</option></select></label>
  <label>Ambiguous options<select aria-label="Ambiguous options"><option selected>Start</option><option value="duplicate">Repeat</option><option value="duplicate">Repeat</option><option disabled>Disabled option</option><optgroup label="Unavailable" disabled><option>Grouped option</option></optgroup></select></label>
  <label>Multiple choices<select aria-label="Multiple choices" multiple><option>One</option><option>Two</option></select></label>
  <button>Ordinary button</button><button onclick="window.open('/popup')">Open child</button>
  <p id="mode"></p><p id="storage"></p></main>
  <script>
  let inputs=0, changes=0;
  const plan=document.getElementById('plan');
  plan.addEventListener('input',()=>inputs++);
  plan.addEventListener('change',()=>{ changes++;document.getElementById('status').textContent=plan.selectedOptions[0].label+'; input '+inputs+'; change '+changes; });
  const dark=matchMedia('(prefers-color-scheme: dark)'), reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function render(){document.getElementById('mode').textContent='Environment '+innerWidth+' by '+innerHeight+'; '+(dark.matches?'dark':'light')+'; '+(reduced.matches?'reduce':'no-preference');}
  window.addEventListener('resize',render);dark.addEventListener('change',render);reduced.addEventListener('change',render);render();
  if(location.search.includes('write=1')){ localStorage.setItem('qa-state','kept');document.cookie='qa-state=kept; path=/'; }
  document.getElementById('storage').textContent='Storage '+(localStorage.getItem('qa-state')||'empty')+'; cookie '+(document.cookie.includes('qa-state=kept')?'kept':'empty');
  </script></html>`
}

async function harness(flags = []) {
  const reservation = createServer()
  const port = await listen(reservation)
  await close(reservation)
  assert.notEqual(port, 8377, 'never address a developer daemon')
  const runtime = await mkdtemp(join(tmpdir(), 'snapsurf-controls-'))
  const token = randomBytes(32).toString('hex')
  const env = { ...process.env, SNAPSURF_PORT: String(port), SNAPSURF_TOKEN: token, SNAPSURF_TOKEN_FILE: join(runtime, 'token'), SNAPSURF_LOGDIR: runtime, SNAPSURF_OPEN_WATCH_MS: '0' }
  const daemon = spawn(process.execPath, ['tools/browse.mjs', 'serve', ...flags], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  daemon.stdout.on('data', (chunk) => { output += String(chunk) })
  daemon.stderr.on('data', (chunk) => { output += String(chunk) })
  const post = async (cmd, args = [], sessionId) => {
    const body = JSON.stringify({ cmd, args, sessionId, envelope: true })
    const nonce = randomBytes(16).toString('hex')
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/cmd`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-snapdom-nonce': nonce, 'x-snapdom-auth': hmac(token, `request-v1\n${nonce}\n${body}`) },
    })
    const text = await response.text()
    assert.equal(response.headers.get('x-snapdom-auth'), hmac(token, `response-v1\n${nonce}\n${text}`), 'every reply must be authenticated')
    return JSON.parse(text)
  }
  const stop = async () => {
    if (daemon.exitCode === null) {
      const exited = new Promise((resolve) => daemon.once('exit', resolve))
      await post('stop').catch(() => {})
      await Promise.race([exited, delay(5000).then(() => { if (daemon.exitCode === null) daemon.kill('SIGTERM') })])
      if (daemon.exitCode === null) await exited
    }
    await rm(runtime, { recursive: true, force: true })
  }
  let ready = false
  for (let i = 0; i < 200 && daemon.exitCode === null; i++) {
    try { if ((await post('status')).ok) { ready = true; break } } catch { /* startup */ }
    await delay(100)
  }
  if (!ready) { await stop(); throw new Error(output || 'isolated daemon did not become ready') }
  const find = async (name, sessionId, role) => {
    const result = await post('find', [name], sessionId)
    assert.equal(result.ok, true, JSON.stringify(result))
    // Require the authored name, rather than accidentally acting on a label wrapper
    // or on a select named after the combined text of all its options.
    if (['Plan', 'Disabled control', 'Ambiguous options'].includes(name)) role = 'combobox'
    if (name === 'Multiple choices') role = result.meta.matches.find((m) => ['listbox', 'combobox'].includes(m.role))?.role
    const matches = result.meta.matches.filter((m) => m.name === name && (!role || m.role === role))
    const match = matches.find((m) => ['combobox', 'listbox', 'button'].includes(m.role)) || matches[0]
    assert.ok(match, `missing ${name}: ${JSON.stringify(result.meta)}`)
    return match.id
  }
  return { post, find, env, runtime, stop }
}

function rpcClient(child) {
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let id = 0
  lines.on('line', (line) => {
    let result
    try { result = JSON.parse(line) } catch { return }
    const request = pending.get(result.id)
    if (!request) return
    pending.delete(result.id)
    if (result.error) request.reject(new Error(result.error.message))
    else request.resolve(result.result)
  })
  return {
    async call(name, args) {
      const current = ++id
      return new Promise((resolve, reject) => {
        pending.set(current, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }) + '\n')
      })
    },
    close() { lines.close() },
  }
}

test('native select and per-session responsive/media controls through daemon, MCP and CLI', { timeout: 120_000 }, async (t) => {
  const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture(req.url)) })
  const base = `http://127.0.0.1:${await listen(site)}`
  const h = await harness()
  const { post, find } = h
  try {
    await t.test('exact values and labels fire events, preserve baseline and expose faithful no-ops', async () => {
      const opened = await post('open', [base])
      const id = await find('Plan', undefined, 'combobox')
      const selected = await post('select', [id, '--value', 'internal-secret-code'])
      assert.equal(selected.ok, true, JSON.stringify(selected))
      assert.equal(selected.epoch, opened.epoch)
      assert.equal(selected.meta.baselineAdvanced, false)
      assert.equal(selected.meta.selectionChanged, true)
      assert.equal(JSON.stringify(selected).includes('internal-secret-code'), false)
      const verified = await post('look')
      assert.equal(verified.meta.changed, true)
      assert.equal(verified.meta.beforeObservationId, opened.meta.observationId)
      await find('Professional plan; input 1; change 1')
      const absence = await post('assert', [JSON.stringify({ diffId: verified.meta.diffId, mustNotInclude: [{ role: 'checkbox', name: 'Unrelated toggle' }] })])
      assert.equal(absence.meta.assert.pass, true)
      const current = await find('Plan', undefined, 'combobox')
      const same = await post('select', [current, '--label', 'Professional plan'])
      assert.equal(same.meta.selectionChanged, false)
      assert.equal((await post('look')).meta.changed, false)
      await find('Professional plan; input 1; change 1')
      const label = await post('select', [await find('Plan', undefined, 'combobox'), '--label', 'Team plan'])
      assert.equal(label.ok, true)
      assert.equal((await post('look')).meta.changed, true)
      await find('Team plan; input 2; change 2')
      const empty = await post('select', [await find('Plan', undefined, 'combobox'), '--value', ''])
      assert.equal(empty.ok, true)
      await post('look')
      await find('Choose plan; input 3; change 3')
    })
    await t.test('invalid controls, ambiguous or disabled choices, and missing IDs fail without changing selection', async () => {
      await post('open', [base])
      const cases = [
        ['Ordinary button', '--label', 'Basic', 'not-native-select'],
        ['Disabled control', '--label', 'Later', 'disabled'],
        ['Multiple choices', '--label', 'One', 'multiple-select'],
        ['Ambiguous options', '--value', 'duplicate', 'option-unresolved'],
        ['Ambiguous options', '--label', 'Repeat', 'option-unresolved'],
        ['Ambiguous options', '--label', 'Disabled option', 'disabled'],
        ['Ambiguous options', '--label', 'Grouped option', 'disabled'],
        ['Plan', '--value', 'absent', 'option-unresolved'],
      ]
      for (const [name, flag, choice, denied] of cases) {
        const outcome = await post('select', [await find(name), flag, choice])
        assert.equal(outcome.ok, false, JSON.stringify(outcome))
        assert.equal(outcome.meta.denied, denied)
        assert.equal((await post('look')).meta.changed, false, name)
      }
      assert.equal((await post('select', ['n_missing', '--value', 'basic'])).ok, false)
      await post('look')
      assert.equal((await post('select', ['5,5', '--value', 'basic'])).ok, false)
      await post('look')
      await find('No selection events')
      await post('open', [base + '?covered=1'])
      const covered = await post('select', [await find('Plan'), '--label', 'Team plan'])
      assert.equal(covered.ok, false)
      assert.equal(covered.meta.denied, 'covered')
      assert.equal((await post('look')).meta.changed, false)
    })
    await t.test('privacy rules block choice probes and choices never enter the audit log', async () => {
      await post('open', [base, '--redact-json', '["secret-account-77"]'])
      const blocked = await post('select', [await find('Plan'), '--value', 'secret-account-77'])
      assert.equal(blocked.ok, false)
      assert.equal(blocked.meta.denied, 'privacy-query')
      assert.equal(JSON.stringify(blocked).includes('secret-account-77'), false)
      assert.equal(blocked.meta.privacy.applied, true)
      assert.equal((await post('look')).meta.changed, false)
      await delay(50)
      const logs = (await Promise.all((await readdir(h.runtime)).filter((name) => name.endsWith('.jsonl')).map((name) => readFile(join(h.runtime, name), 'utf8')))).join('\n')
      assert.equal(logs.includes('internal-secret-code'), false)
      assert.equal(logs.includes('secret-account-77'), false)
    })
    await t.test('environment settings persist across navigation, keep storage/privacy and isolate sessions', async () => {
      const first = await post('session', ['open', '--json', JSON.stringify({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })])
      const s1 = first.meta.sessionId
      const second = await post('session', ['open'])
      const s2 = second.meta.sessionId
      assert.deepEqual(first.meta.environment.viewport, { width: 390, height: 844 })
      const opened = await post('open', [base + '?write=1', '--redact-json', '["private-token"]'], s1)
      await find('Environment 390 by 844; dark; reduce', s1)
      await post('open', [base], s2)
      await find('Environment 1280 by 800; light; no-preference', s2)
      await find('Storage empty; cookie empty', s2)
      const updated = await post('environment', ['--json', JSON.stringify({ viewport: { width: 760, height: 640 }, colorScheme: 'light' })], s1)
      assert.equal(updated.ok, true, JSON.stringify(updated))
      assert.equal(updated.epoch, opened.epoch)
      assert.equal(updated.meta.baselineAdvanced, false)
      assert.equal(updated.meta.privacy.applied, true)
      assert.equal(updated.meta.environment.reducedMotion, 'reduce')
      const verified = await post('look', [], s1)
      assert.equal(verified.meta.changed, true)
      assert.equal(verified.meta.beforeObservationId, opened.meta.observationId)
      await find('Environment 760 by 640; light; reduce', s1)
      await find('Storage kept; cookie kept', s1)
      await post('open', [base], s1)
      await find('Environment 760 by 640; light; reduce', s1)
      await find('Storage kept; cookie kept', s1)
      await find('Environment 1280 by 800; light; no-preference', s2)
      await post('click', [await find('Open child', s1, 'button')], s1)
      await post('look', [], s1)
      await find('Environment 760 by 640; light; reduce', s1)
      assert.equal((await post('environment', [], s1)).meta.environment.colorScheme, 'light')
      const before = await post('environment', [], s1)
      for (const bad of [{ viewport: { width: 1.5, height: 600 } }, { viewport: { width: 0, height: 10 } }, { viewport: { width: 300 } }, { colorScheme: 'unknown' }, { reducedMotion: 'none' }, { locale: 'fr' }]) {
        assert.equal((await post('environment', ['--json', JSON.stringify(bad)], s1)).ok, false)
        await post('look', [], s1)
        assert.deepEqual((await post('environment', [], s1)).meta.environment, before.meta.environment)
      }
      await post('session', ['close', s1])
      await post('session', ['close', s2])
    })
    await t.test('MCP publishes flat select and environment contracts and CLI accepts JSON settings', async () => {
      const mcp = spawn(process.execPath, ['mcp/server.mjs'], { env: h.env, stdio: ['pipe', 'pipe', 'pipe'] })
      const rpc = rpcClient(mcp)
      try {
        const tools = (await rpc.call('tools/list')).tools
        assert.ok(tools.find((tool) => tool.name === 'browser_act').inputSchema.properties.action.enum.includes('select'))
        assert.ok(tools.find((tool) => tool.name === 'browser_environment'))
        const created = await rpc.call('browser_session_open', { viewport: { width: 412, height: 915 }, colorScheme: 'dark', reducedMotion: 'reduce' })
        assert.equal(created.isError, false, JSON.stringify(created))
        const sessionId = created.structuredContent.sessionId
        await rpc.call('browser_open', { url: base, sessionId })
        const target = await find('Plan', sessionId)
        const invalid = await rpc.call('browser_act', { action: 'select', target, value: 'basic', label: 'Basic', sessionId })
        assert.equal(invalid.isError, true)
        await rpc.call('browser_verify', { sessionId })
        const selected = await rpc.call('browser_act', { action: 'select', target: await find('Plan', sessionId), label: 'Team plan', sessionId })
        assert.equal(selected.isError, false, JSON.stringify(selected))
        assert.equal((await rpc.call('browser_verify', { sessionId })).structuredContent.changed, true)
        await find('Team plan; input 1; change 1', sessionId)
        const updated = await rpc.call('browser_environment', { reducedMotion: 'no-preference', sessionId })
        assert.equal(updated.structuredContent.environment.reducedMotion, 'no-preference')
        await rpc.call('browser_verify', { sessionId })
        await find('Environment 412 by 915; dark; no-preference', sessionId)
        const cli = spawn(process.execPath, ['tools/browse.mjs', 'environment', '--json', JSON.stringify({ colorScheme: 'light' }), '--session', sessionId], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] })
        let cliOutput = ''
        cli.stdout.on('data', (chunk) => { cliOutput += String(chunk) })
        cli.stderr.on('data', (chunk) => { cliOutput += String(chunk) })
        const code = await new Promise((resolve) => cli.once('exit', resolve))
        assert.equal(code, 0, cliOutput)
        await rpc.call('browser_verify', { sessionId })
        await find('Environment 412 by 915; light; no-preference', sessionId)
        await rpc.call('browser_session_close', { sessionId })
      } finally {
        rpc.close()
        mcp.stdin.end()
        await new Promise((resolve) => mcp.once('exit', resolve))
      }
    })
  } finally { await h.stop(); await close(site) }
})

test('readonly policy refuses select and environment writes but allows reading QA settings', { timeout: 45_000 }, async () => {
  const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture('/')) })
  const base = `http://127.0.0.1:${await listen(site)}`
  const h = await harness(['--readonly'])
  try {
    await h.post('open', [base])
    const selected = await h.post('select', [await h.find('Plan'), '--label', 'Team plan'])
    assert.equal(selected.ok, false)
    assert.equal(selected.meta.denied, 'readonly')
    assert.equal((await h.post('look')).meta.changed, false)
    const resized = await h.post('environment', ['--json', '{"colorScheme":"dark"}'])
    assert.equal(resized.ok, false)
    assert.equal(resized.meta.denied, 'readonly')
    assert.equal((await h.post('look')).meta.changed, false)
    assert.equal((await h.post('environment')).meta.environment.colorScheme, 'light')
  } finally { await h.stop(); await close(site) }
})
