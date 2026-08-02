/**
 * contract-gates.mjs — the acceptance tests an external benchmark wrote for its findings.
 *
 *   node packages/agent/experiment/contract-gates.mjs
 *
 * Every check here is one defect's own acceptance test, taken verbatim from the report
 * that found it, plus the negative controls the same report says must never break. They
 * were verified once by hand on the day of the fix, by the same person who wrote the fix,
 * on fixtures written in the same session — which is exactly the position where a repro
 * can pass for the wrong reason (that report retracted one of its own for precisely that:
 * relative hrefs do not resolve inside a `data:` URL, so a redaction "worked" because
 * every href was null).
 *
 * So they live here, run offline, and run on every `npm run test:regression`.
 *
 * Fixtures are served locally: an HTTP server for the page shapes and an HTTPS server
 * with a throwaway self-signed certificate for the TLS case. Nothing here touches the
 * network except the DNS check, which uses a `.invalid` name that is reserved never to
 * resolve.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const dArg = process.argv.indexOf('--daemon')
const BROWSE = dArg > -1 && process.argv[dArg + 1] ? process.argv[dArg + 1] : join(AGENT, 'tools/browse.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Fixtures ─────────────────────────────────────────────────────────────────────────
const ALPHA = Array.from({ length: 40 }, (_, i) => 'alpha' + String(i + 1).padStart(3, '0')).join(' ')
const PAGES = {
  // D1: tokens at known offsets — alphaNNN starts at (NNN-1)*9
  '/alpha': { status: 200, headers: {}, body: `<!doctype html><html><body><p>${ALPHA}</p></body></html>` },
  // D3/D4: the term lives ONLY in hrefs, never in the link text
  '/hrefs': { status: 200, headers: {}, body: '<!doctype html><html><head><title>Contact</title></head><body>' +
    '<h1>Contact</h1><a href="/security">vulnerability disclosure</a>' +
    '<a href="mailto:jdoe@corp.com">write to us</a><a href="/users/jdoe/profile">team member</a>' +
    '<p>Ordinary text with nothing sensitive in it.</p></body></html>' },
  // D5: a challenge that never clears
  '/cf': { status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
    body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script><p>Verifying you are human.</p></body></html>' },
  // D6: cloudflare in the plumbing, a different vendor named by the page
  '/chained': { status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
    body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script><h1>DataDome CAPTCHA</h1><p>datadome verification required</p></body></html>' },
  // NEGATIVE CONTROL: a real page that merely sits behind cloudflare
  '/legit': { status: 200, headers: { server: 'cloudflare' },
    body: '<!doctype html><html><head><title>Acme — Contact</title></head><body><h1>Contact</h1><p>Call 914-555-0100</p><p>Plenty of ordinary content here.</p></body></html>' },
  // NEGATIVE CONTROL: a genuinely thin page must come back thin and UNFLAGGED
  '/thin': { status: 200, headers: {}, body: '<!doctype html><html><head><title>WEB Hosting</title></head><body><h1>WEB Hosting</h1></body></html>' },
}
const PORT = 8404
const srv = createServer((req, res) => {
  const p = PAGES[req.url.split('?')[0]]
  if (!p) { res.writeHead(404); res.end('no'); return }
  res.writeHead(p.status, { 'content-type': 'text/html', ...p.headers })
  res.end(p.body)
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const U = (p) => `http://127.0.0.1:${PORT}${p}`

// HTTPS with a throwaway self-signed cert, for the TLS classification check.
let httpsSrv = null, TLS_URL = null, certDir = null
try {
  certDir = mkdtempSync(join(tmpdir(), 'snapdom-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'),
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' })
  httpsSrv = createHttps({ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) },
    (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>ok</body></html>') })
  await new Promise((r) => httpsSrv.listen(8405, '127.0.0.1', r))
  TLS_URL = 'https://127.0.0.1:8405/'
} catch { /* no openssl: the TLS check reports as skipped rather than failing */ }

// ── Daemon ───────────────────────────────────────────────────────────────────────────
const daemon = spawn(process.execPath, [BROWSE, 'serve'], { stdio: 'ignore' })
const cmd = (c, args = [], sessionId) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true, sessionId }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const results = []
const check = (id, name, pass, detail = '') => {
  results.push({ id, name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── D1 · the search window must equal the display window ─────────────────────────────
// "For any node N returned by find(q1), every substring of N.text must find N."
await cmd('open', [U('/alpha')])
const hit = async (q) => ((await cmd('find', [q])).meta?.matches || []).length > 0
check('D1', 'a token at offset 63 is findable', await hit('alpha008'))
check('D1', 'a token at offset 81 is findable (was the 40-char blind band)', await hit('alpha010'))
check('D1', 'a token at offset 216 is findable', await hit('alpha025'))

// ── D3 · a redact policy covers hrefs ────────────────────────────────────────────────
// "for every redact term t and observation O: t not in json(O)"
const red1 = await cmd('open', [U('/hrefs'), '--redact-json', JSON.stringify(['security'])])
const blob1 = JSON.stringify(red1).toLowerCase()
check('D3', 'a term present only in an href does not escape', !blob1.includes('security'),
  blob1.includes('security') ? 'LEAKED' : '0 occurrences in the whole envelope')

const red2 = await cmd('open', [U('/hrefs'), '--redact-json', JSON.stringify(['jdoe'])])
const blob2 = JSON.stringify(red2).toLowerCase()
check('D3', 'the documented mailto: passthrough is not a bypass under a policy', !blob2.includes('jdoe'),
  blob2.includes('jdoe') ? 'LEAKED via mailto: or path' : '0 occurrences')

// ── D4 · the attestation rides on every response, not only `open` ────────────────────
const findUnderPolicy = await cmd('find', ['ordinary'])
check('D4', 'find carries the policy attestation', !!findUnderPolicy.meta?.privacy?.policyRevision,
  JSON.stringify(findUnderPolicy.meta?.privacy || null))
await cmd('redact', ['off'])

// ── D5 · waitForChallenge must never delete the signal ───────────────────────────────
// "blocked(open(u, wait)) == blocked(open(u)) unless the challenge actually cleared"
const noFlag = await cmd('open', [U('/cf')])
const withFlag = await cmd('open', [U('/cf'), '--wait-challenge', '3000'])
check('D5', 'blocked without the flag', noFlag.meta?.blocked === true)
check('D5', 'blocked SURVIVES the flag on an unchanged page', withFlag.meta?.blocked === true,
  `challengeCleared: ${withFlag.meta?.challengeCleared}`)
check('D5', 'the invariant holds', !!noFlag.meta?.blocked === !!withFlag.meta?.blocked)

// ── D6 · chained vendors are all named ───────────────────────────────────────────────
const chained = await cmd('open', [U('/chained')])
const vendors = chained.meta?.challenge?.vendors || []
check('D6', 'every detected vendor is listed', vendors.includes('cloudflare') && vendors.includes('datadome'),
  JSON.stringify(vendors))

// ── D7 · transport failures are typed, like application blocks ───────────────────────
// A page whose navigation failed at the TLS layer cannot navigate again — the next
// `open` times out. That is Chromium's behaviour, not a defect, but it made an unrelated
// check fail 45 s later and look like one. So the failure cases get a throwaway session:
// exactly what per-session pages are for.
const failSid = (await cmd('session', ['open'])).meta?.sessionId
const dns = await cmd('open', ['https://nonexistent-' + Date.now() + '.invalid/'], failSid)
check('D7', 'NXDOMAIN is typed, not a thrown string', dns.meta?.failure?.layer === 'dns',
  JSON.stringify(dns.meta?.failure || dns.error))
if (TLS_URL) {
  const tls = await cmd('open', [TLS_URL], failSid)
  check('D7', 'a certificate failure is typed as tls, hostUp true',
    tls.meta?.failure?.layer === 'tls' && tls.meta?.failure?.hostUp === true,
    JSON.stringify(tls.meta?.failure || tls.error))
} else {
  check('D7', 'certificate failure (skipped: no openssl to make a test cert)', true, 'skipped')
}
if (failSid) await cmd('session', ['close', failSid])

// ── D2 · whose view is this, without a second call ───────────────────────────────────
const auth = await cmd('open', [U('/legit')])
check('D2', 'the anonymous view announces itself on the first call',
  auth.meta?.authState === 'anonymous' && auth.meta?.cookiesForOrigin === 0,
  `authState=${auth.meta?.authState} cookies=${auth.meta?.cookiesForOrigin}`)

// ── Negative controls · the properties that make the positives worth anything ────────
check('NEG', 'a page merely hosted behind a vendor is NOT flagged blocked', !auth.meta?.blocked)
const thin = await cmd('open', [U('/thin')])
check('NEG', 'a genuinely thin page comes back thin and UNFLAGGED', !thin.meta?.blocked,
  `mapTotal=${thin.meta?.mapTotal}`)

// ── Teardown ─────────────────────────────────────────────────────────────────────────
await new Promise((r) => { const s = spawn(process.execPath, [BROWSE, 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* already gone */ }
srv.close(); srv.closeAllConnections?.()
if (httpsSrv) { httpsSrv.close(); httpsSrv.closeAllConnections?.() }
if (certDir) { try { rmSync(certDir, { recursive: true, force: true }) } catch { /* ok */ } }

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} contract checks OK`)
if (failed.length) console.log('FAILING: ' + failed.map((f) => `[${f.id}] ${f.name}`).join(' · '))
process.exit(failed.length ? 1 : 0)
