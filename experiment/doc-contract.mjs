/**
 * doc-contract.mjs — does the documentation match the product?
 *
 *   node packages/agent/experiment/doc-contract.mjs
 *
 * The real phase-4 gate is a stranger integrating from the README in under 30 minutes.
 * That needs a person or a model who has never seen this, and it has NOT been run.
 *
 * This is the deterministic half of it, and it targets the failure that actually bit us:
 * a production consumer read the tool descriptions, looked for the fields they promise,
 * found bare envelopes, and reported that the tool could not read a page at all. The
 * capability was there; the documentation pointed at a place it was not published. No
 * amount of "the tool works" catches that — only checking the promise against the payload.
 *
 * So: every identifier a tool description promises in backticks must actually appear in a
 * response, produced by the documented call. A promise nothing delivers is a defect in
 * whichever half is wrong, and the point is that it is found here rather than by a
 * consumer who then concludes the product is broken.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const BROWSE = join(AGENT, 'tools/browse.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── What the documentation promises ──────────────────────────────────────────────────
const desc = readFileSync(join(AGENT, 'mcp/server.mjs'), 'utf8')
const promised = new Set()
for (const m of desc.matchAll(/description: '(.*?)',\n/gs)) {
  for (const f of m[1].matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)`/g)) promised.add(f[1])
}
// Words that are values or parameters, not response fields. Listed explicitly so the
// exemption is visible rather than silently swallowing a real miss.
const NOT_RESPONSE_FIELDS = new Set([
  'anonymous', 'unknown',   // values of authState
  'redact',                 // an input parameter
])

// ── Fixture ──────────────────────────────────────────────────────────────────────────
const PAGES = {
  '/page': { status: 200, headers: {}, body: '<!doctype html><html><head><title>Doc contract</title></head><body>' +
    '<h1>Contact</h1><a href="/security">disclosure</a><a href="mailto:jdoe@corp.com">write</a>' +
    '<form><input type="email" placeholder="john@company.com"></form>' +
    `<p>${'padding '.repeat(30)}tail-token-here</p></body></html>` },
  '/cf': { status: 403, headers: { 'cf-mitigated': 'challenge' },
    body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script><h1>DataDome CAPTCHA</h1><p>datadome verification</p></body></html>' },
  '/other': { status: 200, headers: {}, body: '<!doctype html><html><body><h1>Second page</h1><p>changed content</p></body></html>' },
}
const PORT = 8406
const srv = createServer((req, res) => {
  const p = PAGES[req.url.split('?')[0]]
  if (!p) { res.writeHead(404); res.end('no'); return }
  res.writeHead(p.status, { 'content-type': 'text/html', ...p.headers })
  res.end(p.body)
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const U = (p) => `http://127.0.0.1:${PORT}${p}`

const daemon = spawn(process.execPath, [BROWSE, 'serve'], { stdio: 'ignore' })
const cmd = (c, args = [], sessionId) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true, sessionId }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

// ── Exercise every documented path, collecting every key any response emitted ────────
const seen = new Set()
const collect = (v, depth = 0) => {
  if (!v || typeof v !== 'object' || depth > 6) return
  for (const [k, val] of Object.entries(v)) { seen.add(k); collect(val, depth + 1) }
}
const run = async (label, c, args, sid) => { const r = await cmd(c, args, sid); collect(r); return r }

await run('open', 'open', [U('/page')])
await run('find', 'find', ['disclosure'])
await run('find-deep', 'find', ['tail-token-here'])       // past the old 80-char window
const idr = await run('find-id', 'find', ['Contact'])
const nid = idr.meta?.matches?.[0]?.id
if (nid) await run('text', 'text', [nid])
await run('outline', 'outline', [])
await run('look-changed', 'open', [U('/other')])           // a second page → a real diff
await run('look', 'look', [])
await run('challenge', 'open', [U('/cf')])                 // blocked / challenge / vendors
await run('failure', 'open', ['https://nope-' + Date.now() + '.invalid/'])
const sid = (await run('session', 'session', ['open'])).meta?.sessionId
if (sid) { await run('session-open', 'open', [U('/page')], sid); await run('session-close', 'session', ['close', sid]) }
await run('redact', 'open', [U('/page'), '--redact-json', JSON.stringify(['security'])])
await run('redact-find', 'find', ['disclosure'])
await run('redact-off', 'redact', ['off'])

// ── Verdict ──────────────────────────────────────────────────────────────────────────
const checked = [...promised].filter((f) => !NOT_RESPONSE_FIELDS.has(f)).sort()
const missing = checked.filter((f) => !seen.has(f))
for (const f of checked) console.log(`${seen.has(f) ? '✓' : '✗'} \`${f}\` — promised by a tool description${seen.has(f) ? '' : ', NEVER DELIVERED'}`)

await new Promise((r) => { const s = spawn(process.execPath, [BROWSE, 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* gone */ }
srv.close(); srv.closeAllConnections?.()

console.log(`\n${checked.length - missing.length}/${checked.length} documented fields actually delivered`)
if (missing.length) console.log('PROMISED BUT ABSENT: ' + missing.join(', '))
console.log(`(${NOT_RESPONSE_FIELDS.size} identifiers exempt as values/params: ${[...NOT_RESPONSE_FIELDS].join(', ')})`)
process.exit(missing.length ? 1 : 0)
