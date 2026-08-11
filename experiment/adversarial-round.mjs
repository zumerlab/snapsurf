/**
 * adversarial-round.mjs — try to break the honesty contract, deterministically.
 *
 *   node experiment/adversarial-round.mjs
 *
 * The pitch rests on two claims: a policy hides what it says it hides, and confusion
 * never comes back green. Both are testable without a model — you just have to attack
 * them instead of demonstrating them. Everything here is a hostile input, not a happy
 * path, and every check states what a FAILURE would mean.
 *
 * Exit code is the number of surviving findings, so this can drive a loop that stops
 * when a round comes back dry.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, '..')
const BROWSE = join(AGENT, 'tools/browse.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SECRET = 'Zorbaxil'
const PAGE = `<!doctype html><html><head><title>${SECRET} clinic</title></head><body>
<h1>${SECRET}</h1>
<a href="/p/${SECRET}/notes">notes</a>
<a href="mailto:${SECRET.toLowerCase()}@x.test">mail</a>
<input value="${SECRET}" placeholder="${SECRET} here">
<p data-note="${SECRET}">visible text mentioning ${SECRET} inline</p>
<p>${'filler '.repeat(40)}${SECRET}-far-away</p>
</body></html>`
const PORT = 8408
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${PORT}/p/${SECRET}`

const daemon = spawn(process.execPath, [BROWSE, 'serve'], { stdio: 'ignore' })
const cmd = (c, args = []) => fetch('http://127.0.0.1:8377/cmd', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: c, args, envelope: true }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
for (let i = 0; i < 40; i++) { const r = await cmd('status'); if (r.ok) break; await sleep(500) }

const findings = []
const attack = (name, broken, detail, why) => {
  if (broken) findings.push({ name, detail, why })
  console.log(`${broken ? '⚠ FINDING' : '✓ holds  '} ${name}${detail ? ` — ${detail}` : ''}`)
}
const has = (o) => JSON.stringify(o).toLowerCase().includes(SECRET.toLowerCase())

// ── Attack 1 · does the policy survive hostile rule shapes? ──────────────────────────
const RULE_SHAPES = [
  ['exact', [SECRET]],
  ['different case', [SECRET.toUpperCase()]],
  ['with surrounding space', [`  ${SECRET}  `]],
  ['regex metacharacters', [`${SECRET}.*`]],
  ['overlapping rules', [SECRET.slice(0, 4), SECRET]],
  ['duplicate rules', [SECRET, SECRET]],
  ['a rule that is a lone space', [' ', SECRET]],
  ['many rules', [...Array.from({ length: 200 }, (_, i) => 'noise' + i), SECRET]],
]
for (const [label, rules] of RULE_SHAPES) {
  const r = await cmd('open', [URL_, '--redact-json', JSON.stringify(rules)])
  const leaked = has(r)
  // A literal rule that cannot match is the operator's mistake, but it must not be a
  // SILENT one: the tool has to say so when the rule is set. Leaking with no warning is
  // the finding; leaking after an explicit warning is a documented literal-match policy.
  const warned = (r.meta?.ruleWarnings || []).length > 0
  attack(`policy survives: ${label}`, leaked && !warned,
    leaked ? (warned ? 'no match, but the operator was WARNED at set time' : 'SECRET PRESENT, no warning') : 'clean',
    'a rule shape that silently stops matching is a leak with an attestation on it')
}
await cmd('redact', ['off'])

// ── Attack 2 · can an empty rule list disable the policy without saying so? ──────────
const emptyRules = await cmd('open', [URL_, '--redact-json', JSON.stringify([])])
attack('an empty rule list does not claim a policy is applied',
  !!emptyRules.meta?.privacy?.applied && (emptyRules.meta?.privacy?.rulesActive === 0),
  JSON.stringify(emptyRules.meta?.privacy || null),
  'attesting "applied" with zero rules would be the worst possible combination')

// ── Attack 3 · confusion must never come back green ──────────────────────────────────
await cmd('open', [URL_])
const BAD_SPECS = [
  ['unknown key', { chnged: true }],
  ['empty spec', {}],
  ['kind that does not exist', { mustInclude: [{ kind: 'exploded' }] }],
  ['mustInclude not an array', { mustInclude: { kind: 'added' } }],
  ['entry that is not an object', { mustInclude: ['added'] }],
  ['unknown entry field', { mustInclude: [{ kynd: 'added' }] }],
  ['retry without a budget', { changed: true, retry: {} }],
  ['ignore that is not selectors', { changed: true, ignore: [42] }],
  ['null spec', null],
  ['array instead of object', []],
]
for (const [label, spec] of BAD_SPECS) {
  const r = await cmd('assert', [JSON.stringify(spec)])
  const green = /^PASS/.test(r.text || '') || r.meta?.assert?.pass === true
  attack(`bad spec fails loud: ${label}`, green, green ? 'RETURNED PASS' : 'rejected with a reason',
    'a malformed check that reports success is the exact failure this contract forbids')
}

// ── Attack 4 · a no-op must not be assertable as a change, and vice versa ────────────
await cmd('open', [URL_])
const noop = await cmd('assert', [JSON.stringify({ changed: true })])
attack('a page that did not change cannot assert changed:true',
  noop.meta?.assert?.pass === true, noop.meta?.assert?.pass === true ? 'PASSED WRONGLY' : 'correctly failed',
  'this is the false-green the whole product exists to prevent')

// ── Attack 5 · session isolation under hostile use ───────────────────────────────────
const s1 = (await cmd('session', ['open'])).meta?.sessionId
const s2 = (await cmd('session', ['open'])).meta?.sessionId
await fetch('http://127.0.0.1:8377/cmd', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'open', args: [URL_], envelope: true, sessionId: s1 }) })
const bogus = await fetch('http://127.0.0.1:8377/cmd', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'find', args: ['notes'], envelope: true, sessionId: 's_does_not_exist' }) }).then((r) => r.json())
attack('an unknown session id is refused, not silently defaulted',
  bogus.ok === true, bogus.ok ? 'SILENTLY SERVED by another session' : String(bogus.error || '').slice(0, 60),
  'defaulting would let a misrouted call read a different page and look successful')
for (const s of [s1, s2]) if (s) await cmd('session', ['close', s])

// ── Attack 6 · the cap must refuse, not degrade ──────────────────────────────────────
const opened = []
for (let i = 0; i < 12; i++) { const r = await cmd('session', ['open']); if (r.meta?.sessionId) opened.push(r.meta.sessionId); else break }
const capped = opened.length < 12
attack('the session cap refuses with a reason instead of exhausting memory',
  !capped, capped ? `stopped at ${opened.length}` : 'opened 12 with no limit',
  'an unbounded cap turns a runaway caller into a dead machine')
for (const s of opened) await cmd('session', ['close', s])

await new Promise((r) => { const s = spawn(process.execPath, [BROWSE, 'stop'], { stdio: 'ignore' }); s.on('exit', r) })
try { daemon.kill() } catch { /* gone */ }
srv.close(); srv.closeAllConnections?.()

console.log(`\n${findings.length} finding(s)`)
for (const f of findings) console.log(`  · ${f.name}: ${f.detail}\n    why it matters: ${f.why}`)
process.exit(findings.length ? 1 : 0)
