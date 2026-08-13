#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, get } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from 'playwright'

/* global Blob, document */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREREG = join(ROOT, 'experiment/results/schema-drift-receipt-value.preregistration.json')
const OUTPUT = join(ROOT, 'experiment/results/schema-drift-receipt-value.json')
const MARKDOWN = join(ROOT, 'experiment/results/schema-drift-receipt-value.md')
const SDK = join(ROOT, 'browser-sdk')
const REPS = 3
const VARIANTS = [
  ['native-stable', 'stable semantics'],
  ['wrapper-stable', 'stable semantics'],
  ['remount-stable', 'stable semantics'],
  ['renamed-legitimate', 'legitimate semantic change'],
  ['switch-legitimate', 'legitimate semantic change'],
]

// HOST_RUNTIME_START
function installGenericHostReader() {
  const roleOf = (element) => element.getAttribute('role') || ({ BUTTON: 'button', INPUT: 'textbox' }[element.tagName] || 'generic')
  const nameOf = (element) => (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ')
  const stateOf = (element) => {
    if (element.hasAttribute('aria-pressed')) return { key: 'pressed', value: element.getAttribute('aria-pressed') === 'true' }
    if (element.hasAttribute('aria-checked')) return { key: 'checked', value: element.getAttribute('aria-checked') === 'true' }
    return null
  }
  const pathOf = (element, root) => {
    const parts = []
    for (let current = element; current && current !== root; current = current.parentElement) {
      parts.push([...current.parentElement.children].indexOf(current))
    }
    return parts.reverse().join('.')
  }
  const covered = (element) => {
    const rect = element.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return true
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return !(hit === element || element.contains(hit))
  }
  const capture = (root) => {
    const rows = [...root.querySelectorAll('*')].map((element) => ({
      path: pathOf(element, root),
      role: roleOf(element),
      name: nameOf(element),
      state: stateOf(element),
      interactive: roleOf(element) === 'button' || roleOf(element) === 'switch',
      covered: covered(element),
    }))
    return {
      rows,
      unobservable: {
        canvas: root.querySelectorAll('canvas').length,
        iframe: root.querySelectorAll('iframe').length,
      },
    }
  }
  globalThis.strongHostBaseline = (root) => capture(root)
  globalThis.strongHostReceipt = (root, before) => {
    const after = capture(root)
    const prior = new Map(before.rows.map((row) => [row.path, row]))
    const facts = []
    for (const row of after.rows) {
      const old = prior.get(row.path)
      if (row.state && old?.state && (row.state.key !== old.state.key || row.state.value !== old.state.value)) {
        facts.push(`state:${row.role}:${row.name}:${row.state.key}=${row.state.value}`)
      }
      if (['status', 'alert', 'log'].includes(row.role) && old && old.name !== row.name) {
        facts.push(`status:${row.role}:${row.name}`)
      }
      if (row.interactive && old && !old.covered && row.covered) facts.push(`covered:${row.role}:${row.name}`)
    }
    for (const [sourceType, count] of Object.entries(after.unobservable)) {
      if (count) facts.push(`unobservable:${sourceType}:${count}`)
    }
    return {
      contract: 'host.generic-action-telemetry/v1',
      version: 1,
      taskOutcome: 'NOT_ASSESSED',
      facts: [...new Set(facts)].sort(),
    }
  }
}
// HOST_RUNTIME_END

// SDK_RUNTIME_START
async function installSdkReader(page, source) {
  await page.evaluate(async (bundleSource) => {
    const url = URL.createObjectURL(new Blob([bundleSource], { type: 'text/javascript' }))
    globalThis.snapdomReceiptSdk = await import(url)
    globalThis.snapdomReceiptModuleUrl = url
  }, source)
}

async function sdkBaseline(page) {
  return page.evaluate(() => globalThis.snapdomReceiptSdk.createBaseline(document.querySelector('#fixture')))
}

async function sdkReceipt(page, baseline) {
  return page.evaluate((before) => globalThis.snapdomReceiptSdk.createReceipt(document.querySelector('#fixture'), {
    baseline: before,
    expected: { changed: true },
    limits: { changes: 24, actionability: 12, unobservable: 12 },
  }), baseline)
}
// SDK_RUNTIME_END

function fixture(variant) {
  const action = {
    'native-stable': '<button data-oracle="action" aria-label="Approve account" aria-pressed="false">Approve</button>',
    'wrapper-stable': '<div class="shell"><span><div data-oracle="action" role="button" tabindex="0" aria-label="Approve account" aria-pressed="false">Approve</div></span></div>',
    'remount-stable': '<div class="shell"><button data-oracle="action" aria-label="Approve account" aria-pressed="false">Approve</button></div>',
    'renamed-legitimate': '<button data-oracle="action" aria-label="Approve account" aria-pressed="false">Approve</button>',
    'switch-legitimate': '<button data-oracle="action" aria-label="Approve account" aria-pressed="false">Approve</button>',
  }[variant]
  const statusRole = 'status'
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:16px system-ui}.stage{position:relative;padding:32px;width:620px;min-height:220px}.row{display:flex;gap:24px;align-items:center}
  [role=button],button{padding:10px 16px}.shield{position:fixed;background:rgba(220,20,60,.15);z-index:9999;pointer-events:auto}
  </style><main id="fixture" class="stage"><div class="row">${action}<div data-oracle="status" role="${statusRole}">Ready</div><button data-oracle="protected" aria-label="Continue">Continue</button></div><canvas data-oracle="opaque" width="10" height="10"></canvas></main>
  <script>
  globalThis.applyAuthoredMutation = () => {
    const root=document.querySelector('#fixture'); let action=root.querySelector('[data-oracle=action]'); let status=root.querySelector('[data-oracle=status]');
    if (${JSON.stringify(variant)}==='remount-stable') { const next=action.cloneNode(true); action.replaceWith(next); action=next; const nextStatus=status.cloneNode(true); status.replaceWith(nextStatus); status=nextStatus; }
    if (${JSON.stringify(variant)}==='renamed-legitimate') { const next=document.createElement('button'); next.dataset.oracle='action'; next.setAttribute('aria-label','Authorize account'); next.setAttribute('aria-pressed','false'); next.textContent='Authorize'; action.replaceWith(next); action=next; status.setAttribute('role','alert'); }
    if (${JSON.stringify(variant)}==='switch-legitimate') { const next=document.createElement('div'); next.dataset.oracle='action'; next.setAttribute('role','switch'); next.setAttribute('tabindex','0'); next.setAttribute('aria-label','Automatic approval'); next.setAttribute('aria-checked','false'); next.textContent='Automatic'; action.replaceWith(next); action=next; status.setAttribute('role','log'); }
    if (action.hasAttribute('aria-pressed')) action.setAttribute('aria-pressed','true'); else action.setAttribute('aria-checked','true');
    status.textContent='Approved';
    const target=root.querySelector('[data-oracle=protected]'); const rect=target.getBoundingClientRect(); const shield=document.createElement('div'); shield.className='shield'; shield.style.left=rect.left+'px'; shield.style.top=rect.top+'px'; shield.style.width=rect.width+'px'; shield.style.height=rect.height+'px'; document.body.append(shield);
  };
  </script>`
}

function canonicalOracle(raw) {
  return [
    `state:${raw.action.role}:${raw.action.name}:${raw.action.state.key}=${raw.action.state.value}`,
    `status:${raw.status.role}:${raw.status.name}`,
    `covered:${raw.protected.role}:${raw.protected.name}`,
    `unobservable:canvas:${raw.canvasCount}`,
  ].sort()
}

function canonicalSdk(receipt) {
  const facts = []
  for (const change of receipt.observed.changes.items) {
    if (change.kind === 'state' && change.after) {
      for (const key of ['pressed', 'checked']) {
        if (Object.hasOwn(change.after, key)) facts.push(`state:${change.role}:${change.name}:${key}=${change.after[key]}`)
      }
    }
    if (['content', 'possible-replacement'].includes(change.kind) && ['status', 'alert', 'log'].includes(change.role) && change.name === 'Approved') {
      facts.push(`status:${change.role}:${change.name}`)
    }
  }
  for (const ref of receipt.observed.actionabilityDelta.becameCovered.items) facts.push(`covered:${ref.role}:${ref.name}`)
  const counts = new Map()
  for (const ref of receipt.observed.unobservable.items) counts.set(ref.sourceType, (counts.get(ref.sourceType) || 0) + 1)
  for (const [sourceType, count] of counts) facts.push(`unobservable:${sourceType}:${count}`)
  return [...new Set(facts)].sort()
}

async function rawOracle(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#fixture')
    const role = (element) => element.getAttribute('role') || (element.tagName === 'BUTTON' ? 'button' : 'generic')
    const name = (element) => (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ')
    const state = (element) => element.hasAttribute('aria-pressed')
      ? { key: 'pressed', value: element.getAttribute('aria-pressed') === 'true' }
      : { key: 'checked', value: element.getAttribute('aria-checked') === 'true' }
    const isCovered = (element) => { const r=element.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return !(hit===element||element.contains(hit)) }
    const action=root.querySelector('[data-oracle=action]'), status=root.querySelector('[data-oracle=status]'), protectedElement=root.querySelector('[data-oracle=protected]')
    return {
      action:{role:role(action),name:name(action),state:state(action)}, status:{role:role(status),name:name(status)},
      protected:{role:role(protectedElement),name:name(protectedElement),covered:isCovered(protectedElement)}, canvasCount:root.querySelectorAll('canvas').length,
    }
  })
}

const prereg = JSON.parse(await readFile(PREREG, 'utf8'))
assert.equal(prereg.status, 'PREREGISTERED_BEFORE_BROWSER_RUN')
assert.equal(await exists(OUTPUT), false, 'result already exists; refusing overwrite')
assert.equal(await exists(MARKDOWN), false, 'markdown result already exists; refusing overwrite')
const sourceText = await readFile(fileURLToPath(import.meta.url), 'utf8')
const hostBlock = between(sourceText, '// HOST_RUNTIME_START', '// HOST_RUNTIME_END')
const sdkBlock = between(sourceText, '// SDK_RUNTIME_START', '// SDK_RUNTIME_END')
for (const [id] of VARIANTS) {
  assert.equal(hostBlock.includes(id), false, `host runtime names variant ${id}`)
  assert.equal(sdkBlock.includes(id), false, `SDK runtime names variant ${id}`)
}

const temp = await mkdtemp(join(tmpdir(), 'snapdom-schema-drift-'))
let context
let server
let port
const rows = []
try {
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: SDK, encoding: 'utf8' }))[0]
  const install = join(temp, 'install'); await mkdir(install)
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temp, pack.filename)], { cwd: install, stdio: 'pipe' })
  const installed = join(install, 'node_modules/@zumer/snapdom-receipt')
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  for (const field of ['dependencies','optionalDependencies','peerDependencies','devDependencies']) assert.deepEqual(pkg[field] || {}, {})
  const bundlePath = join(installed, pkg.exports['.'].import)
  const bundle = await readFile(bundlePath, 'utf8')
  const bundleManifest = JSON.parse(await readFile(join(installed, 'dist-manifest.json'), 'utf8'))
  assert.equal(sha(bundle), bundleManifest.sha256)

  server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const variant = url.searchParams.get('variant')
    if (!VARIANTS.some(([id]) => id === variant)) { response.writeHead(404).end(); return }
    response.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'}).end(fixture(variant))
  })
  await listenSafe(server); port = server.address().port
  context = await chromium.launchPersistentContext(join(temp, 'chromium-profile'), { headless: true, viewport: { width: 900, height: 600 } })

  for (let variantIndex=0; variantIndex<VARIANTS.length; variantIndex++) {
    const [variant, variantClass] = VARIANTS[variantIndex]
    for (let rep=0; rep<REPS; rep++) {
      const page = await context.newPage()
      try {
        await page.goto(`http://127.0.0.1:${port}/fixture?variant=${encodeURIComponent(variant)}&rep=${rep}`, { waitUntil:'domcontentloaded' })
        await page.evaluate(installGenericHostReader)
        await installSdkReader(page, bundle)
        const order = (variantIndex + rep) % 2 ? ['R','H'] : ['H','R']
        const baseline = {}
        const baselineMs = {}
        for (const arm of order) {
          const started=performance.now()
          baseline[arm] = arm === 'H' ? await page.evaluate(() => globalThis.strongHostBaseline(document.querySelector('#fixture'))) : await sdkBaseline(page)
          baselineMs[arm] = round(performance.now()-started)
        }
        const beforeOracle = await rawOracle(page)
        assert.equal(beforeOracle.action.state.value, false); assert.equal(beforeOracle.status.name, 'Ready'); assert.equal(beforeOracle.protected.covered, false); assert.equal(beforeOracle.canvasCount, 1)
        await page.evaluate(() => globalThis.applyAuthoredMutation())
        const afterOracle = await rawOracle(page)
        assert.equal(afterOracle.action.state.value, true); assert.equal(afterOracle.status.name, 'Approved'); assert.equal(afterOracle.protected.covered, true); assert.equal(afterOracle.canvasCount, 1)
        const expected = canonicalOracle(afterOracle)
        const receipts = {}, postMs = {}
        for (const arm of [...order].reverse()) {
          const started=performance.now()
          receipts[arm] = arm === 'H' ? await page.evaluate((before) => globalThis.strongHostReceipt(document.querySelector('#fixture'), before), baseline.H) : await sdkReceipt(page, baseline.R)
          postMs[arm] = round(performance.now()-started)
        }
        const actual = { H: receipts.H.facts, R: canonicalSdk(receipts.R) }
        rows.push({ variant, variantClass, rep, order, expected, actual, exact:{H:same(expected,actual.H),R:same(expected,actual.R)}, baselineBytes:{H:bytes(baseline.H),R:bytes(baseline.R)}, postBytes:{H:bytes(receipts.H),R:bytes(receipts.R)}, baselineMs, postMs, receipts })
      } finally { await page.close() }
    }
  }

  await context.close(); context=null
  await new Promise((resolveClose) => server.close(resolveClose)); server=null
  assert.equal(await portClosed(port), true)
  await rm(temp, {recursive:true,force:true})
  assert.equal(await exists(temp), false)

  const byArm = Object.fromEntries(['H','R'].map((arm) => [arm, {
    exactTrials: rows.filter((row)=>row.exact[arm]).length,
    totalTrials: rows.length,
    exactVariants: VARIANTS.filter(([variant]) => rows.filter((row)=>row.variant===variant).every((row)=>row.exact[arm])).map(([variant])=>variant),
    medianBaselineBytes: median(rows.map((row)=>row.baselineBytes[arm])),
    medianPostBytes: median(rows.map((row)=>row.postBytes[arm])),
    medianCycleMs: median(rows.map((row)=>row.baselineMs[arm]+row.postMs[arm])),
    envelopeShapeHashes: [...new Set(rows.map((row)=>shapeHash(row.receipts[arm])))],
  }]))
  const metrics = {
    H:{initialRuntimeLoc:loc(hostBlock),variantSpecificReferences:variantRefs(hostBlock)},
    R:{initialRuntimeLoc:loc(sdkBlock),variantSpecificReferences:variantRefs(sdkBlock)},
  }
  const decision = byArm.R.exactTrials < byArm.H.exactTrials ? 'NO_MAINTENANCE_ADVANTAGE_SDK_LOST_TELEMETRY' :
    (metrics.H.variantSpecificReferences===0 && metrics.R.variantSpecificReferences===0 ? 'NO_DEMONSTRATED_MAINTENANCE_ADVANTAGE' : 'REVIEW_REQUIRED')
  const result = {
    schema:1, experimentId:prereg.experimentId, completedAt:new Date().toISOString(), decision,
    question:prereg.question, nonClaim:prereg.nonClaim,
    package:{name:pkg.name,bundleBytes:Buffer.byteLength(bundle),bundleSha256:sha(bundle),dependencies:[]},
    schedule:{variants:VARIANTS.length,repetitions:REPS,pairedTrials:rows.length}, byArm, authoringMetrics:metrics, rows,
    integrity:{exactScheduledTrials:rows.length===15,portAssignedByOs:true,portNot8377:port!==8377,portClosed:true,tempRemoved:true,personalChromeAccessed:false,allTaskOutcomeNotAssessed:rows.every((row)=>row.receipts.H.taskOutcome==='NOT_ASSESSED'&&row.receipts.R.taskOutcome==='NOT_ASSESSED')},
    provenance:{runnerSha256:sha(sourceText),preregistrationSha256:sha(await readFile(PREREG)),bundleSha256:sha(bundle)},
    interpretation: decision === 'NO_DEMONSTRATED_MAINTENANCE_ADVANTAGE' ? 'Both generic paths handled every variant with zero variant-specific adapters. The SDK reduces one-time implementation LOC only for a host that does not already own equivalent telemetry.' : 'The SDK receipt omitted at least one preregistered fact on semantic drift, so no maintenance advantage is supported.',
    caveats:['Synthetic authored variants are not a production holdout.','Physical LOC is a descriptive buy-versus-build proxy, not engineering effort.','Task success and commercial demand are not assessed.'],
  }
  await writeFile(OUTPUT, `${JSON.stringify(result,null,2)}\n`, {flag:'wx',mode:0o600})
  const md = `# Schema-drift receipt value\n\nDecision: **${decision}**\n\n| Arm | Exact trials | Exact variants | Runtime LOC | Variant-specific refs | Median post bytes |\n|---|---:|---:|---:|---:|---:|\n| Strong generic host | ${byArm.H.exactTrials}/15 | ${byArm.H.exactVariants.length}/5 | ${metrics.H.initialRuntimeLoc} | ${metrics.H.variantSpecificReferences} | ${byArm.H.medianPostBytes} |\n| Browser receipt SDK | ${byArm.R.exactTrials}/15 | ${byArm.R.exactVariants.length}/5 | ${metrics.R.initialRuntimeLoc} | ${metrics.R.variantSpecificReferences} | ${byArm.R.medianPostBytes} |\n\n${result.interpretation}\n\nThis does not assess task success, production generalization, demand, or willingness to pay. Chromium used a temporary profile; personal Chrome was not accessed.\n`
  await writeFile(MARKDOWN, md, {flag:'wx',mode:0o600})
  process.stdout.write(JSON.stringify({output:OUTPUT,decision,byArm,metrics,integrity:result.integrity},null,2)+'\n')
} finally {
  await context?.close().catch(()=>{})
  if (server) await new Promise((resolveClose)=>server.close(resolveClose)).catch(()=>{})
  await rm(temp,{recursive:true,force:true}).catch(()=>{})
}

function between(text,start,end){const a=text.indexOf(start),b=text.indexOf(end);assert.ok(a>=0&&b>a);return text.slice(a+start.length,b)}
function loc(text){return text.split('\n').filter((line)=>{const t=line.trim();return t&&!t.startsWith('//')}).length}
function variantRefs(text){return VARIANTS.reduce((n,[id])=>n+(text.includes(id)?1:0),0)}
function bytes(value){return Buffer.byteLength(JSON.stringify(value))}
function sha(value){return createHash('sha256').update(value).digest('hex')}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function round(n){return Math.round(n*100)/100}
function median(values){const sorted=[...values].sort((a,b)=>a-b);const m=Math.floor(sorted.length/2);return sorted.length%2?round(sorted[m]):round((sorted[m-1]+sorted[m])/2)}
function shape(value){if(Array.isArray(value))return ['array',...new Set(value.map((item)=>JSON.stringify(shape(item))))].sort();if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,shape(value[key])]));return typeof value}
function shapeHash(value){return sha(JSON.stringify(shape(value))).slice(0,16)}
async function exists(path){try{await stat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
async function listenSafe(target){for(;;){await new Promise((ok,bad)=>{target.once('error',bad);target.listen(0,'127.0.0.1',ok)});if(target.address().port!==8377)return;await new Promise((ok)=>target.close(ok))}}
async function portClosed(port){return new Promise((resolveClosed)=>{const req=get({host:'127.0.0.1',port,path:'/',timeout:300},()=>{req.destroy();resolveClosed(false)});req.on('error',()=>resolveClosed(true));req.on('timeout',()=>{req.destroy();resolveClosed(false)})})}
