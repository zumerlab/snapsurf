#!/usr/bin/env node
/**
 * Client-side selective-evidence egress experiment, version 2.
 *
 * The experiment gives both evidence readers the same full pre/post contract:
 *   Cart 0 -> Cart 1 AND Ready -> Added Item 0.
 *
 * Playwright owns only a hermetic, task-created Chromium test harness. The measured
 * SnapDOM request path is gate-client extension -> companion service worker ->
 * isolated content script; it sends no CDP/debugger product request and never reads
 * a personal browser profile. Every measured evidence body is retained verbatim in
 * a gzip archive and referenced by byte length plus SHA-256 from the result file.
 */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createHash, randomInt } from 'node:crypto'
import { createServer, get } from 'node:http'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from 'playwright'

/* global chrome, document */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPANION = join(ROOT, 'companion')
const CLIENT = join(COMPANION, 'gate-client')
const CLIENT_ID = 'caajdlhkjophkdagpdchjbllohjojgml'
const ROW_SCALES = [50, 250, 1000, 3000]
const UNCERTAINTY_SCALES = [0, 10, 100, 300]
const REPS = 4
const HIGH_PORT_MIN = 20000
const HIGH_PORT_MAX_EXCLUSIVE = 61000
const FORBIDDEN_PORT = 8377
const RESULT_OUTPUT = argumentPath('--output') || join(ROOT, 'experiment', 'results', 'client-side-egress-v2.json')
const ARTIFACT_OUTPUT = argumentPath('--artifacts') || join(ROOT, 'experiment', 'results', 'client-side-egress-v2.artifacts.json.gz')

await assertAbsent(RESULT_OUTPUT)
await assertAbsent(ARTIFACT_OUTPUT)

const startedAt = new Date().toISOString()
const artifactBodies = []
const run = await runInIsolatedBrowser(artifactBodies)
const completedAt = new Date().toISOString()

const artifactIds = new Set(artifactBodies.map((entry) => entry.id))
const referencedArtifactIds = collectArtifactIds(run)
const artifactIntegrity = {
  expectedBodies: ROW_SCALES.length * REPS * 4 + UNCERTAINTY_SCALES.length * REPS,
  bodies: artifactBodies.length,
  uniqueIds: artifactIds.size === artifactBodies.length,
  allHashesMatch: artifactBodies.every((entry) => entry.sha256 === sha256(entry.body) && entry.byteLength === utf8Bytes(entry.body)),
  allBodiesReferenced: artifactBodies.every((entry) => referencedArtifactIds.has(entry.id)),
  noDanglingReferences: [...referencedArtifactIds].every((id) => artifactIds.has(id)),
}
assertIntegrity('artifact bodies', artifactIntegrity, [
  ['body count', artifactIntegrity.bodies === artifactIntegrity.expectedBodies],
  ['unique ids', artifactIntegrity.uniqueIds],
  ['body hashes', artifactIntegrity.allHashesMatch],
  ['all bodies referenced', artifactIntegrity.allBodiesReferenced],
  ['no dangling references', artifactIntegrity.noDanglingReferences],
])

const primarySummary = summarizePrimary(run.primaryTrials)
const uncertaintySummary = summarizeUncertainty(run.uncertaintyTrials)
const integrity = {
  primaryTrials: run.primaryTrials.length,
  expectedPrimaryTrials: ROW_SCALES.length * REPS,
  uncertaintyTrials: run.uncertaintyTrials.length,
  expectedUncertaintyTrials: UNCERTAINTY_SCALES.length * REPS,
  balancedPreReadOrder: balancedOrder(run.primaryTrials, 'pre'),
  balancedPostReadOrder: balancedOrder(run.primaryTrials, 'post'),
  allPrimitiveOraclesExact: run.primaryTrials.every((trial) => trial.oracle.contractPass),
  allAriaContractsExact: run.primaryTrials.every((trial) => trial.contracts.aria.exactPrePost),
  allSnapdomContractsExact: run.primaryTrials.every((trial) => trial.contracts.snapdom.exactPrePost),
  allSnapdomBaselinesCold: run.primaryTrials.every((trial) => trial.snapdom.baseline.changed === null),
  allSnapdomPostsChanged: run.primaryTrials.every((trial) => trial.snapdom.warmPost.changed === true),
  allUnobservableCountsExact: run.uncertaintyTrials.every((trial) => trial.oracle.totalRegions === trial.snapdom.unobservable && trial.snapdom.unobservable === trial.snapdom.unobservableDetails),
  allUnobservableKindsExact: run.uncertaintyTrials.every((trial) =>
    (trial.snapdom.bySourceType.canvas || 0) === trial.oracle.canvases &&
    (trial.snapdom.bySourceType.iframe || 0) === trial.oracle.opaqueIframes),
  zeroUnexpectedUnobservableInPrimary: run.primaryTrials.every((trial) => trial.snapdom.baseline.unobservable === 0 && trial.snapdom.warmPost.unobservable === 0),
  zeroTorn: [...run.primaryTrials.flatMap((trial) => [trial.snapdom.baseline, trial.snapdom.warmPost]), ...run.uncertaintyTrials.map((trial) => trial.snapdom)].every((observation) => observation.torn === 0),
  fixturePortNot8377: run.environment.fixturePort !== FORBIDDEN_PORT,
  fixturePortWasExplicitHighPort: run.environment.fixturePort >= HIGH_PORT_MIN && run.environment.fixturePort < HIGH_PORT_MAX_EXCLUSIVE,
  fixturePortClosed: run.environment.fixturePortClosed,
  temporaryProfileRemoved: run.environment.profileRemoved,
  artifactBodies: artifactIntegrity,
}
assertIntegrity('experiment', integrity, [
  ['primary trial count', integrity.primaryTrials === integrity.expectedPrimaryTrials],
  ['uncertainty trial count', integrity.uncertaintyTrials === integrity.expectedUncertaintyTrials],
  ['balanced pre order', integrity.balancedPreReadOrder],
  ['balanced post order', integrity.balancedPostReadOrder],
  ['primitive oracle', integrity.allPrimitiveOraclesExact],
  ['ARIA contract', integrity.allAriaContractsExact],
  ['SnapDOM contract', integrity.allSnapdomContractsExact],
  ['cold SnapDOM baselines', integrity.allSnapdomBaselinesCold],
  ['changed SnapDOM posts', integrity.allSnapdomPostsChanged],
  ['uncertainty counts', integrity.allUnobservableCountsExact],
  ['uncertainty kinds', integrity.allUnobservableKindsExact],
  ['primary uncertainty', integrity.zeroUnexpectedUnobservableInPrimary],
  ['torn observations', integrity.zeroTorn],
  ['forbidden port', integrity.fixturePortNot8377],
  ['explicit high port', integrity.fixturePortWasExplicitHighPort],
  ['closed port', integrity.fixturePortClosed],
  ['removed profile', integrity.temporaryProfileRemoved],
])

const artifactDocument = {
  schema: 1,
  classification: 'verbatim measured evidence bodies for client-side-egress-v2',
  generatedAt: completedAt,
  encoding: 'UTF-8 strings inside gzip-compressed JSON',
  bodies: artifactBodies,
}
const artifactCompressed = gzipSync(Buffer.from(`${JSON.stringify(artifactDocument)}\n`), { level: 9, mtime: 0 })
const artifactArchive = {
  path: basename(ARTIFACT_OUTPUT),
  mediaType: 'application/gzip',
  byteLength: artifactCompressed.byteLength,
  sha256: sha256(artifactCompressed),
  bodyCount: artifactBodies.length,
}

const output = {
  schema: 2,
  classification: 'single-machine, synthetic, descriptive egress experiment; not a speed, token, or task-success claim',
  question: 'For the same exact pre/post contract, what evidence bytes and reader wall time are observed for full ARIA snapshots versus the client-side SnapDOM response, including SnapDOM baseline cost?',
  exactContract: {
    pre: { cart: '0', status: 'Ready' },
    post: { cart: '1', status: 'Added Item 0' },
  },
  startedAt,
  completedAt,
  browser: {
    engine: 'chromium',
    version: run.environment.browserVersion,
    profile: 'task-owned temporary profile',
  },
  companionPath: 'allowlisted gate-client extension -> companion service worker -> isolated content script',
  fixture: {
    host: '127.0.0.1',
    portSelection: `explicit random integer in [${HIGH_PORT_MIN}, ${HIGH_PORT_MAX_EXCLUSIVE}); retry on collision; ${FORBIDDEN_PORT} forbidden`,
    port: run.environment.fixturePort,
    bindAttempts: run.environment.bindAttempts,
  },
  primary: {
    rowScales: ROW_SCALES,
    repetitions: REPS,
    readOrder: 'balanced independently before and after; post order reverses pre order in each repetition',
    summary: primarySummary,
    trials: run.primaryTrials,
  },
  uncertaintyBoundary: {
    regionScales: UNCERTAINTY_SCALES,
    repetitions: REPS,
    composition: 'alternating visible canvas and sandboxed opaque iframe regions',
    question: 'How does the received SnapDOM response body grow as unobservableDetails grows?',
    summary: uncertaintySummary,
    trials: run.uncertaintyTrials,
  },
  measurements: {
    bytes: 'UTF-8 byte length of the exact received ARIA string or JSON.stringify of the exact received SnapDOM reply envelope',
    wallTime: 'descriptive single-reader elapsed wall time measured around each read; readers ran sequentially in balanced order',
    warmPost: 'post-action body only, after that reader already made its pre-action observation',
    coldPrePlusPost: 'sum of that reader\'s pre-action and post-action bodies/times; this explicitly includes the SnapDOM baseline',
  },
  artifactArchive,
  integrity,
  caveats: [
    'The ARIA string and SnapDOM reply are different evidence formats. Both are required here to carry the same authored contract, but SnapDOM also carries geometry, typed deltas, and uncertainty metadata.',
    'The SnapDOM byte measurement serializes the reply received from Chrome extension messaging; it is not a measurement of Chrome IPC framing or transport overhead.',
    'The fixture is synthetic and changes one fixed semantic region. These observations do not establish model-token savings, task success, production-site behavior, or causal speed superiority.',
    'Reader wall times are reported because the protocol requires them, but no speed claim is made. The readers have different implementations and run sequentially.',
    'The cold pre+post metric is an evidence-cycle total, not browser startup or extension installation time.',
    'The uncertainty stress intentionally demonstrates a boundary: honest unobservableDetails can make the SnapDOM response grow with canvas and opaque-frame count.',
    'Playwright launches and controls the isolated test browser. The measured SnapDOM product request itself uses extension messaging and makes no CDP/debugger request.',
  ],
}

await writeFile(ARTIFACT_OUTPUT, artifactCompressed, { flag: 'wx', mode: 0o600 })
await writeFile(RESULT_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({
  output: RESULT_OUTPUT,
  artifacts: ARTIFACT_OUTPUT,
  primarySummary,
  uncertaintySummary,
  integrity,
}, null, 2))

async function runInIsolatedBrowser(bodies) {
  const primaryTrials = []
  const uncertaintyTrials = []
  const cleanupErrors = []
  let context
  let browser
  let server
  let profile
  let fixturePort
  let bindAttempts
  let browserVersion
  let clientWorker
  let runError

  try {
    profile = await mkdtemp(join(tmpdir(), 'snapdom-client-egress-v2-'))
    server = createServer(fixtureHandler)
    ;({ port: fixturePort, attempts: bindAttempts } = await listenOnExplicitRandomHighPort(server))

    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1100, height: 800 },
      args: [
        `--disable-extensions-except=${COMPANION},${CLIENT}`,
        `--load-extension=${COMPANION},${CLIENT}`,
      ],
    })
    browser = context.browser()
    browserVersion = browser?.version() || null
    await wakeClient(context)
    clientWorker = context.serviceWorkers().find((worker) => new URL(worker.url()).host === CLIENT_ID)
    if (!clientWorker) throw new Error('gate-client service worker did not start')

    for (const rowCount of ROW_SCALES) {
      for (let rep = 0; rep < REPS; rep++) {
        const page = await context.newPage()
        try {
          const trial = await runPrimaryTrial({ page, clientWorker, fixturePort, rowCount, rep, bodies })
          primaryTrials.push(trial)
        } finally {
          await page.close()
        }
      }
    }

    for (const regionCount of UNCERTAINTY_SCALES) {
      for (let rep = 0; rep < REPS; rep++) {
        const page = await context.newPage()
        try {
          const trial = await runUncertaintyTrial({ page, clientWorker, fixturePort, regionCount, rep, bodies })
          uncertaintyTrials.push(trial)
        } finally {
          await page.close()
        }
      }
    }
  } catch (error) {
    runError = error
  } finally {
    // Deliberately nested: server and profile cleanup still run if context.close()
    // throws, and profile deletion still runs if server.close() also throws.
    try {
      if (context) await context.close()
    } catch (error) {
      cleanupErrors.push(new Error(`context cleanup failed: ${errorMessage(error)}`))
    } finally {
      try {
        if (browser?.isConnected()) await browser.close()
      } catch (error) {
        cleanupErrors.push(new Error(`browser fallback cleanup failed: ${errorMessage(error)}`))
      } finally {
        try {
          if (server?.listening) await closeServer(server)
        } catch (error) {
          cleanupErrors.push(new Error(`fixture cleanup failed: ${errorMessage(error)}`))
        } finally {
          try {
            if (profile) await rm(profile, { recursive: true, force: true })
          } catch (error) {
            cleanupErrors.push(new Error(`profile cleanup failed: ${errorMessage(error)}`))
          }
        }
      }
    }
  }

  const fixturePortClosed = await portClosed(fixturePort)
  const profileRemoved = profile ? !(await exists(profile)) : false
  if (!fixturePortClosed) cleanupErrors.push(new Error(`fixture port ${fixturePort} remained open`))
  if (!profileRemoved) cleanupErrors.push(new Error(`temporary profile remained at ${profile}`))
  if (runError || cleanupErrors.length) {
    throw new AggregateError([...(runError ? [runError] : []), ...cleanupErrors], 'client-side-egress-v2 failed closed')
  }

  return {
    primaryTrials,
    uncertaintyTrials,
    environment: { browserVersion, fixturePort, bindAttempts, fixturePortClosed, profileRemoved },
  }
}

async function runPrimaryTrial({ page, clientWorker, fixturePort, rowCount, rep, bodies }) {
  const id = `rows-${rowCount}-rep-${rep}`
  const url = `http://127.0.0.1:${fixturePort}/catalog?rows=${rowCount}&rep=${rep}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const ask = await makeAsk(page, clientWorker)
  const oraclePre = await primitiveCatalogOracle(page)
  const preOrder = rep % 2 === 0 ? ['snapdom', 'aria'] : ['aria', 'snapdom']
  const postOrder = [...preOrder].reverse()
  const observationKey = `${String(rowCount).padStart(4, '0')}-${rep}`
  const pre = await readOrdered(preOrder, {
    snapdom: () => readSnapdom(ask, `primary-pre-${observationKey}`),
    aria: () => readAria(page),
  })

  await page.locator('#target').click()
  await page.waitForFunction(() => document.querySelector('#badge')?.textContent?.trim() === '1' && document.querySelector('#status')?.textContent?.trim() === 'Added Item 0')
  const oraclePost = await primitiveCatalogOracle(page)
  const post = await readOrdered(postOrder, {
    snapdom: () => readSnapdom(ask, `primary-post-${observationKey}`),
    aria: () => readAria(page),
  })

  validateSnapdomReply(pre.snapdom.reply, { baseline: true })
  validateSnapdomReply(post.snapdom.reply, { baseline: false })
  const ariaContract = ariaEvidenceContract(pre.aria.body, post.aria.body)
  const snapdomContract = snapdomEvidenceContract(pre.snapdom.reply, post.snapdom.reply)
  const oracleContract = primitiveContract(oraclePre, oraclePost, rowCount)
  const refs = {
    ariaPre: retainBody(bodies, { id: `${id}:aria:pre`, trialId: id, reader: 'aria', phase: 'pre', mediaType: 'text/yaml; profile=playwright-aria-snapshot', body: pre.aria.body }),
    ariaPost: retainBody(bodies, { id: `${id}:aria:post`, trialId: id, reader: 'aria', phase: 'post', mediaType: 'text/yaml; profile=playwright-aria-snapshot', body: post.aria.body }),
    snapdomPre: retainBody(bodies, { id: `${id}:snapdom:pre`, trialId: id, reader: 'snapdom', phase: 'pre', mediaType: 'application/json', body: pre.snapdom.body }),
    snapdomPost: retainBody(bodies, { id: `${id}:snapdom:post`, trialId: id, reader: 'snapdom', phase: 'post', mediaType: 'application/json', body: post.snapdom.body }),
  }
  const snapPreResult = pre.snapdom.reply.result
  const snapPostResult = post.snapdom.reply.result

  return {
    id,
    rowCount,
    rep,
    readOrder: { pre: preOrder, post: postOrder },
    oracle: { pre: oraclePre, post: oraclePost, contractPass: oracleContract },
    contracts: {
      aria: ariaContract,
      snapdom: snapdomContract,
    },
    aria: {
      baseline: metric(pre.aria, refs.ariaPre),
      warmPost: metric(post.aria, refs.ariaPost),
      coldPrePlusPost: combinedMetric(pre.aria, post.aria),
    },
    snapdom: {
      baseline: {
        ...metric(pre.snapdom, refs.snapdomPre),
        reportedWalkMs: snapPreResult.walkMs,
        actionables: snapPreResult.actionables,
        changed: snapPreResult.changed ?? null,
        changes: snapPreResult.changes?.length ?? 0,
        torn: snapPreResult.torn,
        unobservable: snapPreResult.unobservable,
      },
      warmPost: {
        ...metric(post.snapdom, refs.snapdomPost),
        reportedWalkMs: snapPostResult.walkMs,
        actionables: snapPostResult.actionables,
        changed: snapPostResult.changed,
        changes: snapPostResult.changes?.length ?? 0,
        torn: snapPostResult.torn,
        unobservable: snapPostResult.unobservable,
      },
      coldPrePlusPost: combinedMetric(pre.snapdom, post.snapdom),
    },
  }
}

async function runUncertaintyTrial({ page, clientWorker, fixturePort, regionCount, rep, bodies }) {
  const id = `uncertainty-${regionCount}-rep-${rep}`
  const url = `http://127.0.0.1:${fixturePort}/uncertainty?regions=${regionCount}&rep=${rep}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const ask = await makeAsk(page, clientWorker)
  const oracle = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    opaqueIframes: document.querySelectorAll('iframe[sandbox]').length,
    totalRegions: document.querySelectorAll('canvas,iframe[sandbox]').length,
  }))
  const observation = await readSnapdom(ask, `uncertainty-${String(regionCount).padStart(3, '0')}-${rep}`)
  validateSnapdomReply(observation.reply, { baseline: true })
  const result = observation.reply.result
  const details = Array.isArray(result.unobservableDetails) ? result.unobservableDetails : []
  const bySourceType = {}
  for (const detail of details) bySourceType[detail.sourceType || 'unspecified'] = (bySourceType[detail.sourceType || 'unspecified'] || 0) + 1
  const ref = retainBody(bodies, {
    id: `${id}:snapdom:baseline`,
    trialId: id,
    reader: 'snapdom',
    phase: 'uncertainty-baseline',
    mediaType: 'application/json',
    body: observation.body,
  })
  return {
    id,
    regionCount,
    rep,
    oracle,
    snapdom: {
      ...metric(observation, ref),
      reportedWalkMs: result.walkMs,
      changed: result.changed ?? null,
      torn: result.torn,
      unobservable: result.unobservable,
      unobservableDetails: details.length,
      bySourceType,
    },
  }
}

async function readOrdered(order, readers) {
  const output = {}
  for (const reader of order) output[reader] = await readers[reader]()
  return output
}

async function readSnapdom(ask, obsId) {
  const { value: reply, elapsedMs } = await timed(() => ask({ type: 'SNAPDOM_OBSERVE', obsId }))
  if (!reply || typeof reply !== 'object') throw new Error(`SnapDOM ${obsId} returned no reply object`)
  const body = JSON.stringify(reply)
  if (typeof body !== 'string') throw new Error(`SnapDOM ${obsId} reply could not be serialized`)
  return { reply, body, byteLength: utf8Bytes(body), wallMs: elapsedMs }
}

async function readAria(page) {
  const { value: body, elapsedMs } = await timed(() => page.locator('body').ariaSnapshot())
  if (typeof body !== 'string') throw new Error('ARIA snapshot did not return a string')
  return { body, byteLength: utf8Bytes(body), wallMs: elapsedMs }
}

function validateSnapdomReply(reply, { baseline }) {
  if (reply.error) throw new Error(`SnapDOM reply error: ${reply.error}`)
  if (reply.result?.contract !== 8) throw new Error(`unexpected SnapDOM contract: ${reply.result?.contract}`)
  if (baseline && reply.result.changed !== undefined) throw new Error('SnapDOM baseline was not cold')
  if (!baseline && reply.result.changed !== true) throw new Error(`SnapDOM post observation did not report changed:true: ${reply.result.changed}`)
}

function fixtureHandler(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/catalog') {
    const rowCount = Number(url.searchParams.get('rows'))
    if (!ROW_SCALES.includes(rowCount)) return notFound(response)
    return html(response, catalogFixture(rowCount))
  }
  if (url.pathname === '/uncertainty') {
    const regionCount = Number(url.searchParams.get('regions'))
    if (!UNCERTAINTY_SCALES.includes(regionCount)) return notFound(response)
    return html(response, uncertaintyFixture(regionCount))
  }
  return notFound(response)
}

function catalogFixture(rowCount) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Client-side egress fixture ${rowCount}</title>
<style>
  body{font:14px system-ui;margin:0}header{position:sticky;top:0;background:white;padding:12px;border-bottom:1px solid #ddd;z-index:2}
  main{padding:12px}.row{display:flex;align-items:center;gap:12px;min-height:34px}.row p{margin:0;color:#555}.row button{min-width:120px}
</style></head><body>
<header id="summary" role="banner" aria-label="Cart 0 | Ready"><button id="cart">Cart <span id="badge">0</span></button><span id="status" role="status">Ready</span></header>
<main aria-label="Catalog">
${Array.from({ length: rowCount }, (_, index) => `<article class="row"><h2>Item ${index}</h2><p>Catalog description ${index}</p><button ${index === 0 ? 'id="target"' : ''}>Add Item ${index}</button></article>`).join('')}
</main>
<script>
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('badge').textContent = '1';
    document.getElementById('status').textContent = 'Added Item 0';
    document.getElementById('summary').setAttribute('aria-label', 'Cart 1 | Added Item 0');
  });
</script></body></html>`
}

function uncertaintyFixture(regionCount) {
  const regions = Array.from({ length: regionCount }, (_, index) => index % 2 === 0
    ? `<canvas width="320" height="36" aria-label="Opaque canvas ${index}"></canvas>`
    : `<iframe sandbox="" title="Opaque frame ${index}" srcdoc="&lt;p&gt;opaque ${index}&lt;/p&gt;"></iframe>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Uncertainty boundary ${regionCount}</title>
<style>body{font:14px system-ui;margin:16px}.regions{display:grid;gap:4px}canvas,iframe{display:block;width:320px;height:36px;border:1px solid #aaa}</style>
</head><body><h1>Uncertainty boundary</h1><div class="regions">${regions}</div></body></html>`
}

function html(response, body) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function notFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
}

async function primitiveCatalogOracle(page) {
  return await page.evaluate(() => ({
    badge: document.querySelector('#badge')?.textContent?.trim() || null,
    status: document.querySelector('#status')?.textContent?.trim() || null,
    bannerLabel: document.querySelector('#summary')?.getAttribute('aria-label') || null,
    rows: document.querySelectorAll('main .row').length,
  }))
}

function primitiveContract(pre, post, expectedRows) {
  return pre.badge === '0' && pre.status === 'Ready' && pre.bannerLabel === 'Cart 0 | Ready' && pre.rows === expectedRows &&
    post.badge === '1' && post.status === 'Added Item 0' && post.bannerLabel === 'Cart 1 | Added Item 0' && post.rows === expectedRows
}

function ariaEvidenceContract(preBody, postBody) {
  const pre = String(preBody)
  const post = String(postBody)
  const checks = {
    preBanner: /^- banner "Cart 0 \| Ready":$/m.test(pre),
    preCart: /^ {2}- button "Cart 0"$/m.test(pre),
    preStatus: /^ {2}- status: Ready$/m.test(pre),
    postBanner: /^- banner "Cart 1 \| Added Item 0":$/m.test(post),
    postCart: /^ {2}- button "Cart 1"$/m.test(post),
    postStatus: /^ {2}- status: Added Item 0$/m.test(post),
    preHasNoPostState: !/^ {2}- button "Cart 1"$|^ {2}- status: Added Item 0$/m.test(pre),
    postHasNoPreState: !/^ {2}- button "Cart 0"$|^ {2}- status: Ready$/m.test(post),
  }
  return { ...checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function snapdomEvidenceContract(preReply, postReply) {
  const pre = preReply.result || {}
  const post = postReply.result || {}
  const mark = (result, name) => (result.digest?.marks || []).some((entry) => entry.role === 'banner' && entry.name === name)
  const cart = (result, name) => (result.digest?.top || []).some((entry) => entry.selector === '#cart' && entry.role === 'button' && entry.name === name)
  const transition = (role, beforeName, name) => (post.changes || []).some((change) =>
    change.role === role && change.beforeName === beforeName && change.name === name)
  const checks = {
    preIsBaseline: pre.changed === undefined,
    preBanner: mark(pre, 'Cart 0 | Ready'),
    preCart: cart(pre, 'Cart 0'),
    postChanged: post.changed === true,
    postBanner: mark(post, 'Cart 1 | Added Item 0'),
    postCart: cart(post, 'Cart 1'),
    bannerDirection: transition('banner', 'Cart 0 | Ready', 'Cart 1 | Added Item 0'),
    badgeDirection: transition('generic', '0', '1'),
    statusDirection: transition('status', 'Ready', 'Added Item 0'),
  }
  return { ...checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function retainBody(bodies, entry) {
  const byteLength = utf8Bytes(entry.body)
  const digest = sha256(entry.body)
  bodies.push({ ...entry, byteLength, sha256: digest })
  return { id: entry.id, byteLength, sha256: digest, mediaType: entry.mediaType }
}

function metric(observation, artifact) {
  return { bytes: observation.byteLength, wallMs: observation.wallMs, artifact }
}

function combinedMetric(pre, post) {
  return {
    bytes: pre.byteLength + post.byteLength,
    wallMs: round(pre.wallMs + post.wallMs),
  }
}

function summarizePrimary(trials) {
  return ROW_SCALES.map((rowCount) => {
    const rows = trials.filter((trial) => trial.rowCount === rowCount)
    return {
      rowCount,
      repetitions: rows.length,
      medianActionables: median(rows.map((trial) => trial.snapdom.baseline.actionables)),
      aria: summarizeReader(rows, 'aria'),
      snapdom: summarizeReader(rows, 'snapdom'),
      contractsExact: {
        aria: rows.every((trial) => trial.contracts.aria.exactPrePost),
        snapdom: rows.every((trial) => trial.contracts.snapdom.exactPrePost),
        primitiveOracle: rows.every((trial) => trial.oracle.contractPass),
      },
    }
  })
}

function summarizeReader(rows, reader) {
  return {
    medianBaselineBytes: median(rows.map((trial) => trial[reader].baseline.bytes)),
    medianBaselineWallMs: median(rows.map((trial) => trial[reader].baseline.wallMs)),
    medianWarmPostBytes: median(rows.map((trial) => trial[reader].warmPost.bytes)),
    medianWarmPostWallMs: median(rows.map((trial) => trial[reader].warmPost.wallMs)),
    medianColdPrePlusPostBytes: median(rows.map((trial) => trial[reader].coldPrePlusPost.bytes)),
    medianColdPrePlusPostWallMs: median(rows.map((trial) => trial[reader].coldPrePlusPost.wallMs)),
  }
}

function summarizeUncertainty(trials) {
  const summary = UNCERTAINTY_SCALES.map((regionCount) => {
    const rows = trials.filter((trial) => trial.regionCount === regionCount)
    return {
      regionCount,
      repetitions: rows.length,
      medianResponseBytes: median(rows.map((trial) => trial.snapdom.bytes)),
      medianWallMs: median(rows.map((trial) => trial.snapdom.wallMs)),
      medianUnobservableDetails: median(rows.map((trial) => trial.snapdom.unobservableDetails)),
      allCountsExact: rows.every((trial) => trial.oracle.totalRegions === trial.snapdom.unobservableDetails),
    }
  })
  const baselineBytes = summary.find((row) => row.regionCount === 0).medianResponseBytes
  for (const row of summary) {
    row.medianGrowthBytesVsZero = row.medianResponseBytes - baselineBytes
    row.medianGrowthBytesPerRegionVsZero = row.regionCount ? round(row.medianGrowthBytesVsZero / row.regionCount) : null
  }
  return {
    byRegionCount: summary,
    responseBytesMonotonicNonDecreasing: summary.every((row, index) => index === 0 || row.medianResponseBytes >= summary[index - 1].medianResponseBytes),
  }
}

function balancedOrder(trials, phase) {
  for (const rowCount of ROW_SCALES) {
    const rows = trials.filter((trial) => trial.rowCount === rowCount)
    const snapdomFirst = rows.filter((trial) => trial.readOrder[phase][0] === 'snapdom').length
    const ariaFirst = rows.filter((trial) => trial.readOrder[phase][0] === 'aria').length
    if (snapdomFirst !== REPS / 2 || ariaFirst !== REPS / 2) return false
  }
  return true
}

function collectArtifactIds(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, found)
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && typeof value.sha256 === 'string' && Number.isInteger(value.byteLength)) found.add(value.id)
    for (const item of Object.values(value)) collectArtifactIds(item, found)
  }
  return found
}

async function makeAsk(page, clientWorker) {
  const targetUrl = page.url()
  const tabId = await clientWorker.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url)?.id), targetUrl)
  if (!Number.isInteger(tabId)) throw new Error(`fixture tab not found by extension client: ${targetUrl}`)
  return async (request) => {
    const deadline = Date.now() + 5000
    for (;;) {
      const reply = await clientWorker.evaluate(
        ({ targetTabId, payload }) => globalThis.snapdomGateAsk(targetTabId, payload),
        { targetTabId: tabId, payload: request },
      )
      if (!/Receiving end does not exist/i.test(reply?.error || '') || Date.now() >= deadline) return reply
      await page.waitForTimeout(50)
    }
  }
}

async function wakeClient(context) {
  if (context.serviceWorkers().some((worker) => new URL(worker.url()).host === CLIENT_ID)) return
  const wake = await context.newPage()
  try {
    await wake.goto(`chrome-extension://${CLIENT_ID}/worker.js`).catch(() => {})
    await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null)
  } finally {
    await wake.close()
  }
}

async function listenOnExplicitRandomHighPort(server) {
  const attempted = new Set()
  for (let attempts = 1; attempts <= 64; attempts++) {
    let port
    do port = randomInt(HIGH_PORT_MIN, HIGH_PORT_MAX_EXCLUSIVE)
    while (port === FORBIDDEN_PORT || attempted.has(port))
    attempted.add(port)
    try {
      await listenExplicit(server, port)
      return { port, attempts }
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') throw error
    }
  }
  throw new Error('could not bind fixture on an explicit random high port after 64 attempts')
}

async function listenExplicit(server, port) {
  if (!Number.isInteger(port) || port === FORBIDDEN_PORT || port < HIGH_PORT_MIN || port >= HIGH_PORT_MAX_EXCLUSIVE) {
    throw new Error(`refusing invalid fixture port ${port}`)
  }
  await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

async function portClosed(port) {
  if (!Number.isInteger(port)) return false
  return await new Promise((resolveClosed) => {
    const request = get({ host: '127.0.0.1', port, path: '/', timeout: 300 }, () => {
      request.destroy()
      resolveClosed(false)
    })
    request.on('error', () => resolveClosed(true))
    request.on('timeout', () => {
      request.destroy()
      resolveClosed(false)
    })
  })
}

async function timed(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, elapsedMs: round(performance.now() - started) }
}

async function assertAbsent(path) {
  if (await exists(path)) throw new Error(`refusing to overwrite existing evidence: ${path}`)
}

async function exists(path) {
  return await stat(path).then(() => true, () => false)
}

function assertIntegrity(label, value, checks) {
  const failures = checks.filter(([, pass]) => !pass).map(([name]) => name)
  if (failures.length) throw new Error(`${label} integrity failed (${failures.join(', ')}): ${JSON.stringify(value)}`)
}

function argumentPath(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`)
  return resolve(process.cwd(), value)
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function median(values) {
  if (!values.length) throw new Error('median requires at least one value')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2)
}

function round(value) {
  return Math.round(value * 100) / 100
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
