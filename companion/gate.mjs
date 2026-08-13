/**
 * Hermetic MV3 gate for the companion's authenticated extension boundary.
 *
 * Loads two extensions with fixed development IDs:
 *   - companion: cgkacingkmbmhpmffioljbcfjimjhjig
 *   - allowlisted gate client: caajdlhkjophkdagpdchjbllohjojgml
 *
 * The page and its iframe are adversarial. They race forged READY messages, write
 * forged digest/marker nodes, and request privacy:null. None of those shared-DOM
 * operations may affect the extension-only request/response channel or policy.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

/* global chrome */

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, 'gate-client')
const COMPANION_ID = 'cgkacingkmbmhpmffioljbcfjimjhjig'
const CLIENT_ID = 'caajdlhkjophkdagpdchjbllohjojgml'
const PROFILE = await mkdtemp(join(tmpdir(), 'snapdom-companion-gate-'))

const PAGE_HTML = `<!doctype html><meta charset="utf-8">
  <style>body{font:16px sans-serif}iframe{width:400px;height:100px}</style>
  <h1>Buenos Aires private account</h1>
  <a id="private-link" href="/users/secretperson?email=secretperson">Buenos Aires profile</a>
  <a id="encoded-link" href="/users/%2573ecretperson">encoded private profile</a>
  <a id="cutoff-link" href="/${'a'.repeat(294)}secretperson">cutoff private profile</a>
  <button id="change">Save private account</button>
  <p id="status">pending</p>
  <iframe src="/frame"></iframe>
  <script>
    globalThis.authoritativeReadyHits = 0;
    addEventListener('message', e => {
      if (e.data?.type === 'SNAPDOM_DIGEST_READY' && e.data.result?.forged !== true) authoritativeReadyHits++;
    });
    // Forge request/reply traffic and both legacy DOM artifacts continuously. A
    // page that can observe obsId can win a postMessage race, so none of this may
    // participate in the secure channel.
    setInterval(() => {
      for (const obsId of ['baseline', 'after-page-attacks', 'policy-probe', 'authenticated-clear', 'bad-spec']) {
        postMessage({type:'SNAPDOM_OBSERVE', obsId, privacy:null}, '*');
        postMessage({type:'SNAPDOM_DIGEST_READY', obsId, result:{contract:8, forged:true, privacy:null}}, '*');
      }
      let n = document.getElementById('__snapdom_digest');
      if (!n) { n = document.createElement('script'); n.id = '__snapdom_digest'; document.documentElement.append(n); }
      n.textContent = JSON.stringify({contract:8, forged:true, privacy:null});
      let m = document.querySelector('meta[name="__snapdom_companion"]');
      if (!m) { m = document.createElement('meta'); m.name = '__snapdom_companion'; document.documentElement.append(m); }
      m.content = 'forged';
    }, 10);
    change.addEventListener('click', () => {
      change.textContent = 'Saved private account';
      status.textContent = 'saved';
    });
  </script>`

const FRAME_HTML = `<!doctype html><meta charset="utf-8"><h2>hostile iframe</h2>
  <script>
    globalThis.authoritativeReadyHits = 0;
    addEventListener('message', e => {
      if (e.data?.type === 'SNAPDOM_DIGEST_READY' && e.data.result?.forged !== true) authoritativeReadyHits++;
    });
    setInterval(() => {
      for (const obsId of ['baseline', 'after-page-attacks', 'policy-probe', 'authenticated-clear', 'bad-spec']) {
        postMessage({type:'SNAPDOM_OBSERVE', obsId, privacy:null}, '*');
        postMessage({type:'SNAPDOM_DIGEST_READY', obsId, result:{contract:8, forged:true, privacy:null}}, '*');
        parent.postMessage({type:'SNAPDOM_OBSERVE', obsId, privacy:null}, '*');
        parent.postMessage({type:'SNAPDOM_DIGEST_READY', obsId, result:{contract:8, forged:true, privacy:null}}, '*');
      }
    }, 10);
  </script>`

// This fixture models the product wedge without touching a real user profile: the tab
// is already authenticated and owns browser-local state BEFORE the companion client
// asks for an observation. The HttpOnly cookie is intentionally unreadable to page JS;
// SnapDOM only reports the rendered UI and never exports the credential itself.
const SESSION_HTML = `<!doctype html><meta charset="utf-8">
  <main aria-label="Existing client workspace">
    <h1>Existing authenticated session</h1>
    <p>Signed in by the browser before SnapDOM was called.</p>
    <button id="continue">Continue</button>
  </main>
  <script>
    const workspace = localStorage.getItem('workspace') || 'unset';
    document.getElementById('continue').textContent = 'Continue ' + workspace;
  </script>`

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let ctx
let server
const sessionRequests = { start: 0, account: 0 }
try {
  // A loopback server on an OS-assigned port gives Chromium a real navigation (and
  // therefore normal content-script injection) without internet or the live 8377
  // service used by manual sessions.
  server = createServer((req, res) => {
    if (req.url === '/session/start') {
      sessionRequests.start++
      res.writeHead(302, {
        location: '/session/account',
        'set-cookie': 'snapdom_fixture_session=active; HttpOnly; SameSite=Strict; Path=/',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (req.url === '/session/account') {
      sessionRequests.account++
      const authenticated = /(?:^|;\s*)snapdom_fixture_session=active(?:;|$)/.test(req.headers.cookie || '')
      res.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(authenticated ? SESSION_HTML : '<h1>Sign in required</h1>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.url === '/frame' ? FRAME_HTML : PAGE_HTML)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind local gate server')
  const fixtureUrl = `http://127.0.0.1:${address.port}/%2573ecretperson?owner=%2573ecretperson`

  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    viewport: { width: 900, height: 700 },
    args: [
      `--disable-extensions-except=${HERE},${CLIENT}`,
      `--load-extension=${HERE},${CLIENT}`,
    ],
  })

  const workers = ctx.serviceWorkers()
  if (workers.length < 2) {
    await Promise.all([
      ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null),
      ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null),
    ])
  }
  // MV3 workers are lazy. Opening an extension-owned page wakes the gate client
  // without creating any page-world bridge into the target tab.
  if (!ctx.serviceWorkers().some((w) => new URL(w.url()).host === CLIENT_ID)) {
    const wake = await ctx.newPage()
    await wake.goto(`chrome-extension://${CLIENT_ID}/worker.js`).catch(() => {})
    await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null)
    await wake.close()
  }
  const workerIds = new Set(ctx.serviceWorkers().map((w) => new URL(w.url()).host))
  check('fixed companion extension id loaded', workerIds.has(COMPANION_ID), [...workerIds].join(', '))
  check('allowlisted gate-client extension id loaded', workerIds.has(CLIENT_ID), [...workerIds].join(', '))

  const page = await ctx.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(750)

  const clientWorker = ctx.serviceWorkers().find((w) => new URL(w.url()).host === CLIENT_ID)
  if (!clientWorker) throw new Error('gate-client service worker did not start')
  const tabId = await clientWorker.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url)?.id), page.url())
  check('target tab resolved without page bridge', Number.isInteger(tabId), String(tabId))
  const askTab = async (targetTabId, request) => clientWorker.evaluate(
    ({ tabId, request }) => globalThis.snapdomGateAsk(tabId, request),
    { tabId: targetTabId, request },
  )
  const ask = async (request) => askTab(tabId, request)

  const first = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'baseline', fullUrl: true, privacy: { redact: ['Buenos Aires', 'secretperson'] } })
  check('authenticated response envelope', first?.type === 'SNAPDOM_DIGEST_READY' && first.obsId === 'baseline' && first.result?.contract === 8,
    JSON.stringify({ type: first?.type, obsId: first?.obsId, contract: first?.result?.contract, error: first?.error }))
  check('response is not page-forged', first?.result?.forged !== true)
  const firstWire = JSON.stringify(first?.result || {})
  check('policy redacts every result string including encoded URLs and hrefs',
    !/Buenos Aires|secretperson|%2573ecretperson/i.test(firstWire) && /\[redacted\]/i.test(firstWire), firstWire)
  const topBySelector = new Map((first?.result?.digest?.top || []).map((entry) => [entry.selector, entry]))
  check('href redaction runs before output truncation', topBySelector.get('#cutoff-link')?.href === '[redacted]',
    JSON.stringify(topBySelector.get('#cutoff-link') || null))
  check('percent-encoded href cannot bypass a literal rule', topBySelector.get('#encoded-link')?.href === '[redacted]',
    JSON.stringify(topBySelector.get('#encoded-link') || null))
  check('privacy report travels from isolated reader', first?.result?.privacy?.rulesActive === 2, JSON.stringify(first?.result?.privacy || null))
  check('privacy report exposes no hit or frequency oracle', first?.result?.privacy?.applied === true &&
    !['hitsByRule', 'fields', 'nodesRedacted'].some((key) => key in (first?.result?.privacy || {})),
  JSON.stringify(first?.result?.privacy || null))
  check('unobservable regions travel with details', first?.result?.unobservable > 0 && first.result.unobservableDetails?.some((r) => r.sourceType === 'iframe'),
    JSON.stringify(first?.result?.unobservableDetails || []))

  const unchangedPrivate = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'private-roundtrip' })
  check('unchanged private observation stays changed:false', unchangedPrivate?.result?.changed === false &&
    unchangedPrivate.result?.privacy?.rulesActive === 2 &&
    !/Buenos Aires|secretperson|%2573ecretperson/i.test(JSON.stringify(unchangedPrivate?.result || {})),
  JSON.stringify({ changed: unchangedPrivate?.result?.changed, changes: unchangedPrivate?.result?.changes, privacy: unchangedPrivate?.result?.privacy }))

  const filteredPolicy = await ask({
    type: 'SNAPDOM_OBSERVE', obsId: 'filtered-policy',
    privacy: { redact: [' ', 'Buenos Aires', '', 'secretperson', '   '] },
  })
  check('empty privacy entries are filtered without a false rule count',
    filteredPolicy?.result?.privacy?.rulesActive === 2 && filteredPolicy.result.changed === false &&
    !/Buenos Aires|secretperson/i.test(JSON.stringify(filteredPolicy.result)),
    JSON.stringify({ error: filteredPolicy?.error, privacy: filteredPolicy?.result?.privacy, changed: filteredPolicy?.result?.changed }))

  const malformedPolicy = await ask({
    type: 'SNAPDOM_OBSERVE', obsId: 'malformed-policy',
    privacy: { redact: 'secretperson' },
  })
  const emptyOnlyPolicy = await ask({
    type: 'SNAPDOM_OBSERVE', obsId: 'empty-only-policy',
    privacy: { redact: ['', '   '] },
  })
  check('malformed privacy is rejected instead of becoming an authenticated clear',
    /invalid privacy policy/i.test(malformedPolicy?.error || '') && malformedPolicy?.result === undefined,
    JSON.stringify(malformedPolicy))
  check('zero effective privacy rules cannot receive an applied attestation',
    /invalid privacy policy/i.test(emptyOnlyPolicy?.error || '') && emptyOnlyPolicy?.result?.privacy === undefined,
    JSON.stringify(emptyOnlyPolicy))
  const afterInvalidPolicy = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'after-invalid-policy' })
  check('rejected privacy updates leave the sticky policy intact',
    afterInvalidPolicy?.result?.privacy?.rulesActive === 2 && afterInvalidPolicy.result.changed === false &&
    !/Buenos Aires|secretperson/i.test(JSON.stringify(afterInvalidPolicy.result)),
    JSON.stringify({ privacy: afterInvalidPolicy?.result?.privacy, changed: afterInvalidPolicy?.result?.changed }))

  await page.click('#change')
  const second = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'after-page-attacks' })
  check('page privacy:null cannot clear sticky policy', second?.result?.privacy?.rulesActive === 2 && !/Buenos Aires|secretperson/i.test(JSON.stringify(second?.result || {})),
    JSON.stringify(second?.result?.privacy || null))
  check('real semantic change survives attack traffic', second?.result?.changed === true && (second.result.changes || []).some((c) => /saved|pending/i.test(c.name || '')),
    JSON.stringify(second?.result?.changes || []))

  const hostileFrame = page.frames().find((frame) => frame.url().endsWith('/frame'))
  const frameAttack = await hostileFrame.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 100))
    return globalThis.authoritativeReadyHits
  })
  const third = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'policy-probe', spec: { exists: 'Buenos Aires', keepBaseline: true } })
  check('iframe receives no authoritative replies', frameAttack === 0, `READY hits: ${frameAttack}`)
  check('iframe privacy:null cannot clear policy', third?.result?.pass === false && third.result.checks?.some((c) => c.actual === 'blocked by privacy rule'),
    JSON.stringify(third?.result?.checks || []))
  const coverageProbe = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'coverage-policy-probe', spec: { notCovered: 'Buenos Aires', keepBaseline: true } })
  check('notCovered cannot probe a redacted term', coverageProbe?.result?.pass === false && coverageProbe.result.checks?.some((c) => c.type === 'notCovered' && c.actual === 'blocked by privacy rule'),
    JSON.stringify(coverageProbe?.result?.checks || []))
  const urlProbe = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'url-policy-probe', spec: { urlIncludes: 'secretperson', keepBaseline: true } })
  const encodedUrlProbe = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'encoded-url-policy-probe', spec: { urlIncludes: '%2573ecretperson', keepBaseline: true } })
  check('URL assertions cannot probe a redacted term or encoded form', [urlProbe, encodedUrlProbe].every((reply) =>
    reply?.result?.pass === false && reply.result.checks?.some((c) => c.type === 'urlIncludes' && c.actual === 'blocked by privacy rule')),
  JSON.stringify([urlProbe?.result?.checks, encodedUrlProbe?.result?.checks]))
  check('blocked privacy probes never echo the hidden term',
    !/Buenos Aires|secretperson|%2573ecretperson/i.test(JSON.stringify([third?.result, coverageProbe?.result, urlProbe?.result, encodedUrlProbe?.result])),
    JSON.stringify([third?.result, coverageProbe?.result, urlProbe?.result, encodedUrlProbe?.result]))

  await page.evaluate(() => history.replaceState({}, '', '/clean?owner=public-query#/active'))
  const hashRoute = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'hash-route-evidence', spec: { urlIncludes: '#/active', keepBaseline: true } })
  const hashCheck = hashRoute?.result?.checks?.find((c) => c.type === 'urlIncludes')
  check('URL assertion evidence preserves the matched SPA hash and hides query payload',
    hashRoute?.result?.pass === true && /\?«\d+ chars»#\/active$/.test(hashCheck?.actual || '') &&
    !/public-query/.test(hashCheck?.actual || ''), JSON.stringify(hashCheck || null))

  await page.evaluate(() => history.replaceState({}, '', '/clean#/secretperson'))
  const hiddenHash = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'private-hash-evidence', spec: { urlIncludes: '#/', keepBaseline: true } })
  const hiddenHashWire = JSON.stringify(hiddenHash?.result || {})
  check('privacy terms in a matched hash never leave URL assertion evidence',
    hiddenHash?.result?.pass === true && !/secretperson/i.test(hiddenHashWire) && /\[redacted\]/i.test(hiddenHashWire), hiddenHashWire)
  await page.evaluate(() => history.replaceState({}, '', '/clean'))

  const blindNegative = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'blind-negative', spec: { changed: false, keepBaseline: true } })
  check('changed:false fails unknown when regions are unobservable', blindNegative?.result?.pass === false &&
    blindNegative.result.checks?.some((c) => c.type === 'changed' && /^unknown: \d+ unobservable/.test(c.actual)) &&
    blindNegative.result.unobservableDetails?.some((r) => r.sourceType === 'iframe'),
  JSON.stringify({ checks: blindNegative?.result?.checks, details: blindNegative?.result?.unobservableDetails }))

  const allKinds = ['added', 'removed', 'content', 'state', 'style', 'moved', 'resized', 'possible-replacement']
  const blindAbsenceCases = [
    ['mustNotInclude', { mustNotInclude: [{ kind: 'content', name: 'never-produced-by-fixture' }], keepBaseline: true }],
    ['only', { only: allKinds.map((kind) => ({ kind })), keepBaseline: true }],
    ['maxChanges', { maxChanges: 999999, keepBaseline: true }],
  ]
  for (const [type, spec] of blindAbsenceCases) {
    const reply = await ask({ type: 'SNAPDOM_ASSERT', obsId: `blind-${type}`, spec })
    check(`${type} cannot attest absence across unobservable regions`,
      reply?.result?.pass === false && reply.result.checks?.some((c) => c.type === type && /^unknown: \d+ unobservable/.test(String(c.actual))),
      JSON.stringify(reply?.result?.checks || []))
  }

  // Force the chunked reader to park while the DOM mutates. `torn` must participate in
  // the verdict itself; publishing it beside a green absence assertion is not enough.
  await page.evaluate(() => {
    const bulk = document.createElement('div')
    bulk.id = 'torn-bulk'
    const fragment = document.createDocumentFragment()
    // The walk slices only after 40ms of CONTINUOUS work (makeSlicer's budget), and a
    // walk that fits in one slice can never be torn — no park, no gap for the interval
    // to land in. 6000 trivial spans sat right AT that boundary on a fast machine and
    // the check flaked with the answer depending on JIT/alloc noise, not on the
    // property under test. The count buys margin: several guaranteed slices per walk.
    for (let i = 0; i < 20000; i++) {
      const span = document.createElement('span')
      span.textContent = `stable-${i}`
      fragment.append(span)
    }
    bulk.append(fragment)
    document.body.append(bulk)
    globalThis.__snapdomTornTimer = setInterval(() => {
      bulk.toggleAttribute('data-concurrent-mutation')
    }, 0)
  })
  await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'torn-baseline' })
  const tornAbsence = await ask({
    type: 'SNAPDOM_ASSERT', obsId: 'torn-absence',
    spec: { maxChanges: 999999, keepBaseline: true },
  })
  check('current torn observation makes an absence predicate unknown',
    tornAbsence?.result?.pass === false && tornAbsence.result.torn > 0 &&
    tornAbsence.result.checks?.some((c) => c.type === 'maxChanges' && /observation torn by \d+ concurrent mutation/.test(String(c.actual))),
    JSON.stringify({ torn: tornAbsence?.result?.torn, checks: tornAbsence?.result?.checks }))
  await page.evaluate(() => {
    clearInterval(globalThis.__snapdomTornTimer)
    delete globalThis.__snapdomTornTimer
    document.getElementById('torn-bulk')?.remove()
  })

  const policyTransition = await ask({
    type: 'SNAPDOM_OBSERVE', obsId: 'policy-transition',
    privacy: { redact: ['Buenos Aires', 'secretperson', 'Saved private account'] },
  })
  check('changing privacy establishes a fresh baseline instead of fabricating a diff',
    policyTransition?.result?.changed === undefined && policyTransition.result?.privacy?.rulesActive === 3 &&
    !/Buenos Aires|secretperson|Saved private account/i.test(JSON.stringify(policyTransition.result)),
    JSON.stringify({ changed: policyTransition?.result?.changed, changes: policyTransition?.result?.changes, privacy: policyTransition?.result?.privacy }))
  const stableAfterPolicyTransition = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'stable-after-policy-transition' })
  check('new privacy baseline produces an unchanged roundtrip',
    stableAfterPolicyTransition?.result?.changed === false && stableAfterPolicyTransition.result?.privacy?.rulesActive === 3,
    JSON.stringify({ changed: stableAfterPolicyTransition?.result?.changed, changes: stableAfterPolicyTransition?.result?.changes, privacy: stableAfterPolicyTransition?.result?.privacy }))

  const pageSurface = await page.evaluate(() => ({
    readyHits: globalThis.authoritativeReadyHits,
    marker: document.querySelector('meta[name="__snapdom_companion"]')?.content,
    slot: document.getElementById('__snapdom_digest')?.textContent,
  }))
  check('companion publishes no results to page postMessage', pageSurface.readyHits === 0, `READY hits: ${pageSurface.readyHits}`)
  check('page-owned marker/DOM slot have no authority', pageSurface.marker === 'forged' && /"forged":true/.test(pageSurface.slot || ''), JSON.stringify(pageSurface))

  const directPageCall = await page.evaluate(async (companionId) => {
    if (!globalThis.chrome?.runtime?.sendMessage) return { api: false }
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage(companionId, { channel: 'snapdom-companion-v1', tabId: 0, request: { type: 'SNAPDOM_OBSERVE' } }),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 250)),
      ])
      return { api: true, result }
    } catch (error) {
      return { api: true, error: String(error) }
    }
  }, COMPANION_ID)
  check('web page cannot call companion extension API', directPageCall.api === false || directPageCall.result === undefined,
    JSON.stringify(directPageCall))

  const cleared = await ask({ type: 'SNAPDOM_OBSERVE', obsId: 'authenticated-clear', privacy: null })
  check('allowlisted extension can intentionally clear policy', cleared?.result?.privacy === undefined && /Buenos Aires/i.test(JSON.stringify(cleared?.result?.digest || {})))

  const bad = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'bad-spec', spec: { mustInclud: [] } })
  check('fail-loud assertion contract preserved', bad?.result?.pass === false && bad.result.checks?.some((c) => c.type === 'spec' && !c.pass),
    JSON.stringify(bad?.result?.checks || []))
  const coercive = await ask({ type: 'SNAPDOM_ASSERT', obsId: 'coercive-spec', spec: { maxChanges: '999' } })
  check('coercive assertion types cannot pass green', coercive?.result?.pass === false &&
    coercive.result.checks?.some((c) => c.type === 'spec' && !c.pass), JSON.stringify(coercive?.result?.checks || []))

  // Existing-session proof. Playwright is only the hermetic test harness here: the
  // product request goes gate-client extension -> companion worker -> isolated content
  // script, after authentication and browser-local state already exist in the tab.
  const sessionPage = await ctx.newPage()
  const sessionOrigin = new URL(fixtureUrl).origin
  await sessionPage.goto(`${sessionOrigin}/session/start`, { waitUntil: 'domcontentloaded' })
  await sessionPage.evaluate(() => localStorage.setItem('workspace', 'workspace-alpha'))
  await sessionPage.reload({ waitUntil: 'domcontentloaded' })
  await sessionPage.waitForFunction(() => document.querySelector('#continue')?.textContent === 'Continue workspace-alpha')
  const pageCookieSurface = await sessionPage.evaluate(() => document.cookie)
  check('fixture credential is HttpOnly and absent from the page surface', pageCookieSurface === '', JSON.stringify(pageCookieSurface))

  const sessionTabId = await clientWorker.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url)?.id), sessionPage.url())
  check('pre-existing authenticated tab resolved by extension id', Number.isInteger(sessionTabId), String(sessionTabId))
  const requestsBeforeObserve = { ...sessionRequests }
  const existingSession = await askTab(sessionTabId, { type: 'SNAPDOM_OBSERVE', obsId: 'existing-session' })
  const existingWire = JSON.stringify(existingSession?.result || {})
  check('client-side observer sees authenticated rendered state without a login action',
    existingSession?.result?.contract === 8 && /Existing authenticated session/.test(existingWire) && /Continue workspace-alpha/.test(existingWire),
    existingWire)
  check('observation did not navigate or replay authentication',
    sessionRequests.start === requestsBeforeObserve.start && sessionRequests.account === requestsBeforeObserve.account &&
    sessionPage.url() === `${sessionOrigin}/session/account`,
    JSON.stringify({ before: requestsBeforeObserve, after: sessionRequests, url: sessionPage.url() }))
  check('credential value never enters the semantic response', !/snapdom_fixture_session|=active/.test(existingWire), existingWire)
  await sessionPage.close()
} finally {
  await ctx?.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(PROFILE, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\nGATE RED — ${failed.length} failure(s)` : '\nGATE GREEN — authenticated companion boundary holds')
process.exit(failed.length ? 1 : 0)
