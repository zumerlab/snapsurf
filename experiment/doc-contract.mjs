/**
 * doc-contract.mjs — does the documentation match the product?
 *
 *   node experiment/doc-contract.mjs
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
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers'
import { daemonFetch } from '../tools/daemon-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const BROWSE = join(AGENT, 'tools/browse.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── What the documentation promises ──────────────────────────────────────────────────
const desc = readFileSync(join(AGENT, 'mcp/server.mjs'), 'utf8')
const promised = new Set()
// Only top-level tool descriptions promise response fields. The old unanchored,
// dot-all regex could start at an inline input-property description (which does not end
// with `',\n`) and consume arbitrary schema/implementation code until the next matching
// line. That made a backticked implementation word such as `required` look like a
// structuredContent promise. Tool descriptions are the four-space, whole-line entries in
// TOOLS; property descriptions are nested or inline and intentionally excluded.
for (const m of desc.matchAll(/^ {4}description: '([^\n]*)',$/gm)) {
  for (const f of m[1].matchAll(/`([a-zA-Z][a-zA-Z0-9_]*)`/g)) promised.add(f[1])
}
// Words that are values or parameters, not response fields. Listed explicitly so the
// exemption is visible rather than silently swallowing a real miss.
const NOT_RESPONSE_FIELDS = new Set([
  'anonymous', 'unknown',   // values of authState
  'redact',                 // an input parameter
])

// ── Fixture ──────────────────────────────────────────────────────────────────────────
const LONG_TEXT = `${'padding '.repeat(700)}tail-token-here`
const DOCUMENT_PATH = '/download?edition=' + 'public-research-'.repeat(12) + '#page=3'
const PAGES = {
  '/page': { status: 200, headers: {}, body: '<!doctype html><html><head><title>Doc contract</title></head><body>' +
    '<h1>Contact</h1><a href="/security">disclosure</a><a href="mailto:jdoe@corp.com">write</a>' +
    '<form><input type="email" placeholder="john@company.com"></form>' +
    // long enough that `text` on this node truncates at 600 and must deliver
    // `totalChars`; the token still sits past the old 80-char find window
    `<p>${LONG_TEXT}</p>` +
    `<a href="${DOCUMENT_PATH}" type="application/pdf">Research report PDF</a>` +
    '<button id="replace-card">Replace Gamma card</button>' +
    '<div id="slot"><h3>Gamma</h3><p>Old offering</p><button>Open Gamma</button></div>' +
    `<script>document.getElementById('replace-card').onclick=()=>{const fresh=document.createElement('div');fresh.id='slot';fresh.innerHTML='<h3>Omega</h3><p>New unrelated offering</p><button>Open Omega</button>';document.getElementById('slot').replaceWith(fresh)}</script>` +
    '<button id="open-suggest">Open suggestions</button>' +
    // A dropdown-style insertion whose wrapper chain must FOLD in the diff: the inner
    // generic wrappers carry no identity (no testid, no authored name, no own text), so
    // the delivered response must include `foldedWrappers` alongside the full count.
    `<script>document.getElementById('open-suggest').onclick=()=>{const outer=document.createElement('div');const inner=document.createElement('div');inner.innerHTML='<button>Suggestion one</button><p>historian (1939)</p>';outer.appendChild(inner);document.body.appendChild(outer)}</script>` +
    '</body></html>' },
  '/cf': { status: 403, headers: { 'cf-mitigated': 'challenge' },
    body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script><h1>DataDome CAPTCHA</h1><p>datadome verification</p></body></html>' },
  '/other': { status: 200, headers: {}, body: '<!doctype html><html><body><h1>Second page</h1><p>changed content</p></body></html>' },
  '/redirect-start': { status: 302, headers: { location: '/redirect-middle' }, body: '' },
  '/redirect-middle': { status: 307, headers: { location: '/page' }, body: '' },
  '/download': { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="research.pdf"' }, body: '%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF' },
  // HN-style split card: the title row carries only actionables; the metadata lives in
  // the SIBLING row — `parent` must deliver `siblingRowText`.
  '/split': { status: 200, headers: {}, body: '<!doctype html><html><body><table><tbody>' +
    '<tr><td>1.</td><td><a href="/story">Split card story headline</a> <a href="/from">(site.example)</a></td></tr>' +
    '<tr><td></td><td>99 points by writer | <a href="/c">12 comments</a></td></tr>' +
    '</tbody></table></body></html>' },
  // a subresource that never answers: `open` must return with `loading` declared
  '/hung': { status: 200, headers: {}, body: '<!doctype html><html><body><h1>Hung page</h1><img src="/hang.png" width="1" height="1"></body></html>' },
}
const srv = createServer((req, res) => {
  if (req.url === '/hang.png') return // never answered — keeps `loading` deliverable
  const p = PAGES[req.url.split('?')[0]]
  if (!p) { res.writeHead(404); res.end('no'); return }
  res.writeHead(p.status, { 'content-type': 'text/html', ...p.headers })
  res.end(p.body)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const address = srv.address()
if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port')
const PORT = address.port
const U = (p) => `http://127.0.0.1:${PORT}${p}`

// a short load-wait bound keeps the `/hung` scenario at ~1s instead of the 5s default
const daemon = spawn(process.execPath, [BROWSE, 'serve'], { stdio: 'ignore', env: { ...process.env, SNAPDOM_LOAD_WAIT_MS: '800' } })
const cmd = (c, args = [], sessionId) => daemonFetch({
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true, sessionId }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

// ── Exercise every documented path, collecting every key any response emitted ────────
const seen = new Set()
const contractFailures = []
const collect = (v, depth = 0) => {
  if (!v || typeof v !== 'object' || depth > 6) return
  for (const [k, val] of Object.entries(v)) { seen.add(k); collect(val, depth + 1) }
}
const run = async (label, c, args, sid) => { const r = await cmd(c, args, sid); collect(r); return r }
const requireContract = (condition, message, evidence) => {
  if (!condition) contractFailures.push(message + (evidence === undefined ? '' : ': ' + JSON.stringify(evidence)))
}

const initial = await run('open', 'open', [U('/page')])
const documentLink = initial.meta?.digest?.top?.find((entry) => entry.n === 'Research report PDF')
requireContract(documentLink?.href === U(DOCUMENT_PATH) && documentLink?.document?.url === U(DOCUMENT_PATH),
  'digest must retain the complete absolute document URL including a long query and fragment', documentLink)
requireContract(documentLink?.document?.type === 'pdf' && documentLink.document.evidence === 'link-type' && documentLink.document.reader === 'external-pdf-reader' &&
  documentLink.document.title === 'Research report PDF' && documentLink.document.source?.observationId === initial.meta?.observationId &&
  documentLink.document.source?.id === documentLink.id,
'PDF link hint must preserve its title, reader and observed source identity', documentLink)
const documentFind = await run('find-document', 'find', ['Research report PDF'])
requireContract(documentFind.meta?.matches?.some((entry) => entry.role === 'link' && entry.href === U(DOCUMENT_PATH)),
  'find must retain the same complete document destination as the digest', documentFind.meta)
await run('find', 'find', ['disclosure'])
const deep = await run('find-deep', 'find', ['tail-token-here']) // past the old 80-char window
// a >600-char node: `text` must deliver truncated + `totalChars`, not a silent cut
const longId = deep.meta?.matches?.[0]?.id
if (longId) {
  const first = await run('text-long', 'text', [longId])
  const start = first.meta
  requireContract(first.ok === true && start?.text === LONG_TEXT.slice(0, 600) && start.totalChars === LONG_TEXT.length &&
    start.returnedChars === 600 && start.offset === 0 && start.maxChars === 600 && start.truncated === true && start.nextOffset === 600 &&
    start.textSource === 'inner-text' && start.observationId === initial.meta?.observationId && Number.isFinite(Date.parse(start.capturedAt)),
  'default text read must declare its exact slice, observation, first-read timestamp and remaining text', start)
  const budgeted = await run('text-budgeted', 'text', [longId, '--max-chars', '3000'])
  const chunk = budgeted.meta
  const next = chunk?.continuation
  requireContract(budgeted.ok === true && chunk?.text === LONG_TEXT.slice(0, 3000) && chunk.returnedChars === 3000 &&
    next?.id === longId && next.maxChars === 3000 && next.offset === 3000 && next.observationId === start?.observationId &&
    next.sessionId === first.sessionId && chunk.capturedAt === start?.capturedAt,
  'maxChars must expand the read budget and supply a complete continuation for the same captured text', chunk)
  if (next) {
    const continued = await run('text-continuation', 'text', [next.id, '--max-chars', String(next.maxChars), '--offset', String(next.offset), '--observation-id', next.observationId], next.sessionId)
    const tail = continued.meta
    requireContract(continued.ok === true && chunk.text + tail?.text === LONG_TEXT && tail.offset === 3000 &&
      tail.returnedChars === LONG_TEXT.length - 3000 && tail.totalChars === LONG_TEXT.length && tail.truncated === false &&
      tail.nextOffset === null && tail.continuation === null && tail.capturedAt === start?.capturedAt && tail.observationId === start?.observationId,
    'continuation must finish the exact text without gaps, duplication or a new capture', tail)
  }
  const contextResult = await run('find-context', 'find', ['--context-chars', '1000', '--', 'tail-token-here'])
  const contextMatches = contextResult.meta?.matches || []
  const contexts = contextMatches.filter((entry) => entry.context)
  const context = contexts[0]?.context
  requireContract(contextResult.ok === true && contextResult.meta.contextChars === 1000 && contextResult.meta.contextCharsReturned === 1000 &&
    contexts.reduce((sum, entry) => sum + entry.context.returnedChars, 0) === 1000 &&
    contextResult.meta.contextMatchesOmitted === contextMatches.length - contexts.length &&
    context?.text === LONG_TEXT.slice(0, 1000) && context.totalChars === LONG_TEXT.length && context.truncated === true &&
    context.maxChars === 1000 && context.capturedAt === start?.capturedAt &&
    context.continuation?.offset === 1000 && context.continuation?.observationId === start?.observationId,
  'find context must respect one total character budget and expose continuation for its truncated text', contextResult.meta)
} else requireContract(false, 'long-text fixture must be findable before exercising its documented read contract', deep)
const idr = await run('find-id', 'find', ['Contact'])
const nid = idr.meta?.matches?.[0]?.id
if (nid) await run('text', 'text', [nid])
await run('outline', 'outline', [])
// Exercise a possible replacement explicitly. Its structured evidence must carry both
// the current `name` and prior `beforeName`; merely naming the field in MCP docs is not
// evidence that a real response can deliver it.
const replaceFind = await run('find-replace', 'find', ['Replace Gamma card'])
const replaceId = replaceFind.meta?.matches?.[0]?.id
if (replaceId) {
  await run('replace-click', 'click', [replaceId])
  await run('replace-look', 'look', [])
}
// Exercise wrapper folding: an added subtree whose identity-free generic chain must be
// counted in `foldedWrappers` while the signal items stay listed.
const suggestFind = await run('find-suggest', 'find', ['Open suggestions'])
const suggestId = suggestFind.meta?.matches?.[0]?.id
if (suggestId) {
  await run('suggest-click', 'click', [suggestId])
  const verified = await run('suggest-look', 'look', [])
  const evidence = verified.meta
  if (typeof evidence?.diffId !== 'string' || !evidence.beforeObservationId ||
      !evidence.afterObservationId || evidence.observationId !== evidence.afterObservationId ||
      evidence.baselineAdvanced !== true) {
    contractFailures.push('verify must identify the full transition and its baseline advance: ' + JSON.stringify(verified))
  }
  if (evidence?.diffId) {
    const asserted = await run('assert-stored', 'assert', [JSON.stringify({
      diffId: evidence.diffId,
      changed: true,
      mustInclude: [{ kind: 'added', role: 'button', name: 'Suggestion one' }],
    })])
    const result = asserted.meta?.assert
    if (result?.pass !== true || result?.evidenceSource !== 'stored' ||
        result?.baselineAdvanced !== false ||
        ['diffId', 'beforeObservationId', 'afterObservationId', 'observationId'].some((key) => result?.[key] !== evidence[key])) {
      contractFailures.push('stored assertion must pass using the verify transition without advancing its baseline: ' + JSON.stringify(asserted))
    }
  }
}
const unavailable = await run('assert-unavailable', 'assert', [JSON.stringify({ diffId: 'diff_doc_contract_missing', changed: true })])
if (unavailable.meta?.assert?.pass !== false || unavailable.meta?.assert?.error?.code !== 'DIFF_UNAVAILABLE') {
  contractFailures.push('unavailable diffId must return pass:false and DIFF_UNAVAILABLE: ' + JSON.stringify(unavailable))
}
await run('look-changed', 'open', [U('/other')])           // a second page → a real diff
await run('look', 'look', [])
await run('challenge', 'open', [U('/cf')])                 // blocked / challenge / vendors
await run('failure', 'open', ['https://nope-' + Date.now() + '.invalid/'])
// split card: `parent` on the title must deliver `siblingRowText`
await run('split-open', 'open', [U('/split')])
const splitFind = await run('split-find', 'find', ['Split card story headline'])
const splitId = splitFind.meta?.matches?.[0]?.id
if (splitId) await run('split-parent', 'parent', [splitId])
// a document whose load cannot finish: `open` must deliver `loading`, never silence
await run('loading', 'open', [U('/hung')])
const sid = (await run('session', 'session', ['open'])).meta?.sessionId
if (sid) { await run('session-open', 'open', [U('/page')], sid); await run('session-close', 'session', ['close', sid]) }
await run('redact', 'open', [U('/page'), '--redact-json', JSON.stringify(['security'])])
await run('redact-find', 'find', ['disclosure'])
await run('redact-off', 'redact', ['off'])

// Navigation provenance is evidence from the actual HTTP responses, not inferred from
// comparing two URLs. Query values remain private even when the chain is published.
const redirected = await run('redirect-chain', 'open', [U('/redirect-start?token=doc-contract-secret')])
const nav = redirected.meta
requireContract(redirected.ok === true && nav?.requestedUrl?.startsWith(U('/redirect-start') + '?«') &&
  nav.finalUrl === U('/page') && nav.navigationUrlsSanitized === true && nav.redirectChainAvailable === true &&
  nav.redirectChainScope === 'http' && nav.redirectChainTotal === 3 && nav.redirectChainTruncated === false &&
  JSON.stringify(nav.redirectChain?.map((entry) => entry.status)) === JSON.stringify([302, 307, 200]) &&
  nav.redirectChain?.[1]?.url === U('/redirect-middle') && nav.redirectChain?.[2]?.url === U('/page') &&
  !JSON.stringify(redirected).includes('doc-contract-secret'),
'navigation must expose the observed ordered HTTP chain and final destination while sanitizing query values', nav)

const sourceLink = nav?.digest?.top?.find((entry) => entry.n === 'Research report PDF')
if (sourceLink?.href) {
  const handoff = await run('pdf-handoff', 'open', [sourceLink.href])
  const document = handoff.meta?.document
  requireContract(handoff.ok === true && document?.type === 'pdf' && document.mediaType === 'application/pdf' &&
    document.reader === 'external-pdf-reader' && document.title === sourceLink.n && document.textExtracted === false && document.url === handoff.meta.finalUrl &&
    document.source?.id === sourceLink.id && document.source?.observationId === nav.observationId &&
    document.source?.href === sourceLink.href && document.source?.url === U('/page') &&
    handoff.meta.baselineAdvanced === false && handoff.meta.observationId === undefined && handoff.meta.digest === undefined,
  'PDF response must hand off to an external reader with its exact source reference without claiming a text observation', handoff.meta)
} else requireContract(false, 'PDF handoff source must be discoverable after the redirect', nav)

// ── Verdict ──────────────────────────────────────────────────────────────────────────
const checked = [...promised].filter((f) => !NOT_RESPONSE_FIELDS.has(f)).sort()
const missing = checked.filter((f) => !seen.has(f))
for (const f of checked) console.log(`${seen.has(f) ? '✓' : '✗'} \`${f}\` — promised by a tool description${seen.has(f) ? '' : ', NEVER DELIVERED'}`)

await new Promise((r) => { const s = spawn(process.execPath, [BROWSE, 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* gone */ }
srv.close(); srv.closeAllConnections?.()

console.log(`\n${checked.length - missing.length}/${checked.length} documented fields actually delivered`)
if (missing.length) console.log('PROMISED BUT ABSENT: ' + missing.join(', '))
for (const failure of contractFailures) console.log('CONTRACT FAILURE: ' + failure)
console.log(`(${NOT_RESPONSE_FIELDS.size} identifiers exempt as values/params: ${[...NOT_RESPONSE_FIELDS].join(', ')})`)
process.exit(missing.length || contractFailures.length ? 1 : 0)
