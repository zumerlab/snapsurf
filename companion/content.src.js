/**
 * Companion content script (source — bundled into content.bundle.js).
 *
 * Runs in the ISOLATED WORLD: immune to page CSP (what killed page-world injection:
 * CSP on wikipedia/ebay + Private Network Access toward localhost). The shared DOM
 * is observed but is never a transport or authority boundary. Requests arrive only
 * through chrome.runtime from this extension's service worker; replies travel back
 * over the same private extension channel. A page or iframe cannot spoof a reply,
 * clear privacy, or race an observation by writing DOM/postMessage traffic.
 *
 * The digest includes the DIFF against the previous observation of the same
 * document — the Claude extension stops paying screenshots to know what changed.
 */
import { observeChunked, buildUi, redactString } from '../src/plugin.js'

// The service worker owns the sticky per-tab privacy policy in storage.session and
// attaches the authoritative policy to EVERY request. This local copy is set only
// from an internal runtime message; page-world traffic can never reach this code.
let PRIVACY = null
let PRIVACY_KEY = null
const priv = (s) => redactString(s, PRIVACY)
// URLs can carry a literal privacy term through percent-encoding. Check a few
// decode layers, but preserve the original URL when no rule matches so callers
// do not accidentally navigate with a normalized/decoded value.
const privateUrl = (value) => {
  const raw = String(value)
  const direct = priv(raw)
  if (direct !== raw) return direct
  let decoded = raw
  for (let depth = 0; depth < 3; depth++) {
    let next
    try { next = decodeURIComponent(decoded) } catch { break }
    if (next === decoded) break
    if (priv(next) !== next) return '[redacted]'
    decoded = next
  }
  return raw
}
// Evidence for URL assertions must show the SPA hash that made the predicate true,
// without publishing query payloads. Opaque documents remain collapsed to their scheme,
// and a literal or percent-encoded privacy match anywhere in the URL fails closed.
const privateUrlEvidence = (value) => {
  const raw = String(value)
  let parsed
  try { parsed = new URL(raw) } catch { return privateUrl(raw) }
  const opaque = raw.match(/^(data|javascript|blob|filesystem):/i)
  if (opaque) {
    const hash = parsed.hash || ''
    const payloadLength = (hash && raw.endsWith(hash) ? raw.length - hash.length : raw.length) - opaque[0].length
    const safeHash = privateUrl(hash)
    return `${opaque[1].toLowerCase()}:«${payloadLength} chars»${safeHash === hash ? hash : '#[redacted]'}`
  }
  const visible = parsed.origin === 'null'
    ? raw
    : parsed.origin + parsed.pathname + (parsed.search ? `?«${parsed.search.length - 1} chars»` : '') + parsed.hash
  return privateUrl(visible)
}
const privateError = (error) => privateUrl(String(error))
// Defense in depth for hand-built result fields (assert matcher echoes, selectors,
// error metadata): the structured result itself is the final privacy boundary.
const privateValue = (value) => {
  if (!PRIVACY) return value
  if (typeof value === 'string') return privateUrl(value)
  if (Array.isArray(value)) return value.map(privateValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateValue(item)]))
  }
  return value
}
// Detailed hit counts are useful inside the trusted reader, but exposing them turns
// redaction into a presence/frequency oracle. External callers get only proof that the
// policy ran and how many rules they themselves supplied.
const publicPrivacy = (ui) => {
  const rulesActive = ui?.privacy?.rulesActive ?? PRIVACY?.redact?.length ?? 0
  return rulesActive ? { rulesActive, applied: true } : undefined
}
const privacyOpts = () => (PRIVACY ? { privacy: PRIVACY } : {})
const viewOf = (ui) => ui.__view || ui.__snapshot
import { makeSlicer } from '../src/snapshot.js'
import { inflateCheckpointChunked } from '../src/checkpoint.js'

/* global chrome */

let prev = null
// Same baseline, inflated ONCE and cached: inflation re-derives three hashes per
// node (480ms on wikipedia in the panel's env) and used to run again on every
// observe AND every assert retry attempt. The matcher/differ never mutate it.
let prevInflated = null
// URL the baseline was taken on (origin+pathname, same sanitization as `url`):
// after a soft/SPA navigation the document — and therefore the baseline — survives,
// and a cross-page diff reads as a confusing changed:false while content is still
// mounting (panel field round on github). `navigated: true` in the result makes
// that explicit instead of a deduction the reader has to make.
let prevUrl = null
const setBaseline = (cp) => { prev = cp; prevInflated = null; prevUrl = location.origin + location.pathname }
const clearBaseline = () => { prev = null; prevInflated = null; prevUrl = null }
const inflatedBaseline = async () =>
  prev ? (prevInflated || (prevInflated = await inflateCheckpointChunked(prev, makeSlicer(40)))) : null

// CSS selector the READER can act with (its own click tools) — feedback from the
// Claude-extension panel: our n_xxx ids aren't actionable from outside the oracle.
// Read-only: no DOM stamping, no self-inflicted diff noise.
// UNIQUE or ABSENT — never a selector that resolves to a different element (panel
// round 6: 3/6 relative selectors matched 24-134 elements and querySelector returned
// the WRONG headline; acting on that clicks the wrong thing). Full nth-of-type path
// up to the nearest #id ancestor or the root, then VERIFIED against the element.
// prof detail (panel ask): selectorOf/sectionOf are the digest's per-entry live-DOM
// reads — accumulate them separately so a supra-linear digest is attributable.
const timed = (fn, key) => (...a) => {
  const P = window.__SD_PROF
  if (!P) return fn(...a)
  const t = performance.now()
  try { return fn(...a) } finally { P[key] = (P[key] || 0) + (performance.now() - t) }
}

function selectorOfRaw(el) {
  if (!el) return null
  if (el.id) return '#' + CSS.escape(el.id)
  const parts = []
  let cur = el
  while (cur && cur !== document.documentElement) {
    if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break }
    let p = cur.localName
    const parent = cur.parentElement
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.localName === cur.localName)
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(cur) + 1})`
    }
    parts.unshift(p)
    cur = parent
  }
  const sel = parts.join(' > ')
  try { if (document.querySelector(sel) === el) return sel } catch { /* invalid sel */ }
  return null
}

const vboxOf = (b) => b ? [b[0] - Math.round(scrollX), b[1] - Math.round(scrollY), b[2], b[3]] : undefined
// out-of-viewport vbox is numerically valid but useless for clicking — flag it
const inViewOf = (v) => !!v && v[0] < innerWidth && v[0] + v[2] > 0 && v[1] < innerHeight && v[1] + v[3] > 0

// Parent-section context ("belongs to MÁS LEÍDAS") — panel feedback on lanacion:
// without it, placing a heading required an extra DOM query. Climbs to the nearest
// sectioning ancestor and returns its own heading text (or aria-label). If that
// heading IS the element we're describing, keep climbing.
function sectionOfRaw(el) {
  const ownText = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  let cur = el && el.parentElement
  let depth = 0
  while (cur && cur !== document.body && depth < 12) {
    if (/^(section|article|aside|nav|main|header|footer)$/.test(cur.localName) || cur.getAttribute('role') === 'region') {
      // page-wide wrappers make EVERYTHING report the lead story as its section
      // (lanacion) — a real section box ("MÁS LEÍDAS") is bounded; keep climbing
      // past huge ancestors without taking their heading.
      const tall = cur.getBoundingClientRect().height > 8000
      if (!tall) {
        const hs = cur.querySelectorAll('h1,h2,h3,h4,[role="heading"]')
        // flat result LISTS are heading collections, not titled sections — taking
        // their first heading labeled every item with the previous item's title
        // (panel, lanacion buscador). Ambiguous container → absent beats wrong.
        const isFlatList = hs.length > 3
        const h = hs[0]
        if (!isFlatList && h && h !== el && !h.contains(el) && !el.contains(h)) {
          const t = priv((h.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60)
          if (t && t !== ownText) return t
        }
        const al = cur.getAttribute('aria-label')
        if (al && al.slice(0, 60) !== ownText) return priv(al).slice(0, 60)
      }
    }
    cur = cur.parentElement
    depth++
  }
  return undefined
}

const selectorOf = timed(selectorOfRaw, 'selectorOf')
const sectionOf = timed(sectionOfRaw, 'sectionOf')

// async + time-sliced: selectorOf/sectionOf are live-DOM reads (querySelector per
// entry) and used to run as one task — on 3.5k-node pages the digest alone was a
// main-thread block the walk's own slicing never covered (panel probe round).
async function digestOf(ui, topN, headsN) {
  const pause = makeSlicer(40)
  const marks = []
  const heads = []
  const LANDMARKS = { navigation: 1, main: 1, banner: 1, contentinfo: 1, search: 1, form: 1, complementary: 1 }
  for (const id of ui.__snapshot.order) {
    const p = pause()
    if (p) await p
    const n = viewOf(ui).nodes.get(id)
    if (!n) continue
    if (n.role === 'heading' && heads.length < headsN) {
      const el = ui.__snapshot.elements.get(id)
      heads.push({ id, text: (n.name || n.text || '').slice(0, 120), section: sectionOf(el) })
    } else if (LANDMARKS[n.role] && marks.length < 10) marks.push({ id, role: n.role, name: (n.name || '').slice(0, 60), bbox: n.bbox })
  }
  const top = []
  for (const e of ui.agentMap.map.slice(0, topN)) {
    const p = pause()
    if (p) await p
    const el = ui.__snapshot.elements.get(e.id)
    // href: the panel's read_page gave hrefs without names, our digest names without
    // hrefs — neither sufficed alone (lanacion buscador). Together the digest does.
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = privateUrl((u.origin === location.origin ? '' : u.origin) + u.pathname + u.search).slice(0, 300) }
    } catch { /* noop */ }
    const v = vboxOf(e.b)
    top.push({
      id: e.id, role: e.r, name: (e.n || '').slice(0, 120),
      bbox: e.b, vbox: v, inView: inViewOf(v),
      selector: selectorOf(el),
      href: href || undefined,
      section: sectionOf(el),
      covered: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined,
    })
  }
  return { marks, heads, top }
}

// match: the in-page find — searches the WHOLE snapshot (names + text), not the
// top-N window. Panel round 5: lanacion's front page outran top:100/heads:60 (38kB
// and still not found) while a text match is one call and ~2kB. Full text up to
// 300 chars — its native find and read_page both truncate at 100.
async function findMatches(ui, query) {
  const pause = makeSlicer(40)
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const q = norm(query)
  const out = new Map()
  const add = (id, role, name) => {
    if (!name || out.has(id) || !norm(name).includes(q)) return
    const el = ui.__snapshot.elements.get(id)
    const n = viewOf(ui).nodes.get(id)
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      // navigable, not a teaser: 100 chars cut "…nid28072026/" mid-id (panel round 6)
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = privateUrl((u.origin === location.origin ? '' : u.origin) + u.pathname + u.search).slice(0, 500) }
    } catch { /* noop */ }
    // snapshot name/text arrive pre-truncated (~80c) — take the LONGER of snapshot
    // vs live DOM text so the 300c contract holds (the h2 was 127c, arrived 80c)
    const fromSnap = ((n && (n.name || n.text)) || name || '').replace(/\s+/g, ' ').trim()
    const fromDom = el ? priv((el.textContent || '').replace(/\s+/g, ' ').trim()) : ''
    const full = (fromDom.length > fromSnap.length ? fromDom : fromSnap).slice(0, 300)
    const v = vboxOf(n && n.bbox)
    out.set(id, {
      id, role, text: full, href: href || undefined,
      selector: selectorOf(el), section: sectionOf(el),
      bbox: n && n.bbox, vbox: v, inView: inViewOf(v),
    })
  }
  for (const e of ui.agentMap.map) {
    const p = pause()
    if (p) await p
    add(e.id, e.r, e.n)
  }
  for (const id of ui.__snapshot.order) {
    if (out.size >= 20) break
    const p = pause()
    if (p) await p
    const n = viewOf(ui).nodes.get(id)
    add(id, n.role, n.name || n.text)
  }
  return [...out.values()].slice(0, 20)
}

async function runObserve(opts = {}) {
  const t0 = performance.now()
  if (opts.prof) window.__SD_PROF = {}
  const pacc = (k, t) => { const p = window.__SD_PROF; if (opts.prof && p) p[k] = (p[k] || 0) + (performance.now() - t) }
  let t = performance.now()
  const baseline = await inflatedBaseline()
  pacc('inflate', t)
  // capture BEFORE setBaseline overwrites them: these describe the baseline the
  // diff below actually ran against
  const baseUrl = baseline ? prevUrl : null
  const obs = await observeChunked(document.body, {
    ...(baseline ? { previous: baseline } : {}),
    ...privacyOpts(),
  })
  const pause = makeSlicer(40)
  t = performance.now()
  const ui = buildUi(obs, privacyOpts())
  pacc('buildUi', t)
  let p = pause()
  if (p) await p
  t = performance.now()
  setBaseline(ui.checkpoint())
  pacc('checkpoint', t)
  p = pause()
  if (p) await p
  // Every change carries a readable label: name, else the node's own text, else the
  // subtree text — 29/30 anonymous `generic` changes made the panel's first diff
  // useless. Named changes sort first.
  const labelOfChange = (c) => {
    let label = c.name && String(c.name).slice(0, 60)
    if (!label && c.id) {
      const n = viewOf(ui).nodes.get(c.id)
      if (n) label = ((n.name || n.text || '')).slice(0, 60) || undefined
      if (!label) {
        const el = ui.__snapshot.elements.get(c.id)
        if (el) label = priv((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)) || undefined
      }
    }
    return label
  }
  // walkMs keeps its field meaning (walk + diff + checkpoint); change labeling and
  // the digest were never inside it.
  const walkMs = Math.round(performance.now() - t0)
  let changes
  if (ui.changes) {
    t = performance.now()
    // label first (cheap), THEN sort, THEN cut to 40, and only those 40 pay
    // selectorOf — the old path ran a verified querySelector for EVERY change
    // before the cut, which on a big diff was its own main-thread monolith.
    const labeled = []
    for (const c of ui.changes) {
      const p = pause()
      if (p) await p
      labeled.push({ c, label: labelOfChange(c) })
    }
    labeled.sort((a, b) => (b.label ? 1 : 0) - (a.label ? 1 : 0))
    changes = []
    for (const { c, label } of labeled.slice(0, 40)) {
      const p = pause()
      if (p) await p
      changes.push({
        kind: c.kind,
        role: c.role,
        name: label,
        beforeName: c.beforeName,
        id: c.id,
        selector: selectorOf(ui.__snapshot.elements.get(c.id)) || undefined,
      })
    }
    pacc('changeLabels', t)
  }
  t = performance.now()
  const matches = opts.match ? await findMatches(ui, opts.match) : undefined
  const digest = opts.match ? undefined : await digestOf(ui, Math.min(100, opts.top || 25), Math.min(60, opts.heads || 15))
  pacc('digest', t)
  const out = {
    // contract marker: readers verify the loaded bundle matches the documented
    // protocol (four consumer rounds bitten by stale bundles — result-in-message,
    // ignore, chunked walk all "missing" because the extension was never reloaded)
    // v7: navigated/baselineUrl signal for SPA soft navigations (panel field ask)
    contract: 8,
    // origin+pathname only: the Claude extension's sanitizer redacts URLs carrying
    // query strings ("[BLOCKED: Cookie/query string data]")
    url: privateUrl(location.origin + location.pathname),
    // opt-in full URL (query included): the default stays sanitized because the
    // Claude-extension sanitizer redacts query-bearing urls, but on a search-results
    // page the query IS the meaning — the reader decides.
    urlFull: opts.fullUrl ? privateUrl(location.href) : undefined,
    ts: Date.now(),
    // obsId, NOT "token": the panel's JS bridge censors any key literally named
    // token ("[BLOCKED: Sensitive key]") — the echo was unverifiable from its side.
    obsId: opts.obsId ?? undefined,
    // Coordinate contract (panel round 3): vbox is CSS px of THIS viewport; readers
    // whose screenshots are scaled (dpr) compute scale = screenshotWidth / viewport.width.
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
    walkMs,
    // Public attestation only. Detailed hit counts stay inside the trusted reader.
    privacy: publicPrivacy(ui),
    // chunked walk: the tab stays responsive; torn counts DOM mutations that landed
    // WHILE the walk was parked — a non-zero torn means re-observe if it matters
    torn: obs.torn || 0,
    prof: opts.prof ? Object.fromEntries(Object.entries(window.__SD_PROF || {}).map(([k, v]) => [k, Math.round(v)])) : undefined,
    actionables: ui.agentMap.map.length,
    unobservable: ui.unobservable.length,
    unobservableDetails: ui.unobservable,
    // navigated: the URL moved since the baseline was taken (SPA soft nav) — the
    // diff below spans two "pages" of one document; re-baseline on settled content
    // before trusting change-based checks (see the prompt's SPA guidance)
    baselineUrl: baseUrl ? privateUrl(baseUrl) : undefined,
    navigated: baseUrl ? (location.origin + location.pathname) !== baseUrl : undefined,
    changed: ui.changed,
    changes,
    actionabilityDelta: ui.actionabilityDelta,
    // match present → matches only (~2kB); digest only otherwise (a 38kB top:100
    // digest that still misses the target is the wrong tool for long front pages)
    matches,
    digest,
  }
  return privateValue(out)
}

// SNAPDOM_ASSERT — the QA vocabulary in the user's own tabs (same contract as the
// MCP browser_assert): deterministic checks built on the diff. The panel's
// adversarial round rewrote this contract: FAILURE MODES MUST NEVER POINT GREEN.
// Unknown keys, empty specs, missing baselines and malformed specs are all hard
// pass:false with a reason; retry ({retry:{budgetMs}}) re-walks against the SAME
// baseline until pass or budget (CSS transitions land mid-flight); evidence (the
// diff, with selector and state from/to) travels with every result that ran a diff.
const CHECK_KEYS = new Set(['urlIncludes', 'changed', 'mustInclude', 'mustNotInclude', 'only', 'maxChanges', 'exists', 'notCovered', 'becameVisible', 'becameCovered'])
const MOD_KEYS = new Set(['settleMs', 'retry', 'keepBaseline', 'ignore'])
const ENTRY_FIELDS = new Set(['kind', 'role', 'name', 'nameExact', 'selector', 'to'])
const KINDS = new Set(['added', 'removed', 'content', 'state', 'style', 'moved', 'resized', 'possible-replacement'])
const STATE_KEYS = new Set(['disabled', 'checked', 'expanded', 'pressed', 'selected', 'open', 'value', 'hasValue'])

// profFlag rides at MESSAGE level ({type:'SNAPDOM_ASSERT', spec, prof:true}), never
// inside spec: the strict spec validator must keep rejecting unknown keys.
async function runAssert(spec, obsId, profFlag) {
  const t0 = performance.now()
  if (profFlag) window.__SD_PROF = {}
  const pacc = (k, t) => { const p = window.__SD_PROF; if (profFlag && p) p[k] = (p[k] || 0) + (performance.now() - t) }
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const preChecks = []
  const push = (arr, type, expected, actual, pass) => arr.push({ type, expected, actual, pass })
  const typeOf = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const plainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
  const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
  const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

  if (spec === undefined) spec = {}
  else if (!plainObject(spec)) {
    push(preChecks, 'spec', 'assert spec is an object', typeOf(spec), false)
    spec = {}
  }

  // strict spec, ALL levels: a typo must never look like success — round 1 fixed the
  // top level, round 2 found entry fields, kind values, retry shapes and empty
  // matcher arrays all still failing OPEN. Everything validates now.
  for (const k of Object.keys(spec)) {
    if (!CHECK_KEYS.has(k) && !MOD_KEYS.has(k)) push(preChecks, 'spec', 'known key', `unknown key "${k}"`, false)
  }
  for (const k of ['urlIncludes', 'exists', 'notCovered', 'becameVisible']) {
    if (spec[k] !== undefined && !nonEmptyString(spec[k])) push(preChecks, 'spec', `${k} is a non-empty string`, typeOf(spec[k]), false)
  }
  if (spec.changed !== undefined && typeof spec.changed !== 'boolean') push(preChecks, 'spec', 'changed is boolean', typeOf(spec.changed), false)
  if (spec.maxChanges !== undefined && (!finiteNonNegative(spec.maxChanges) || !Number.isInteger(spec.maxChanges))) {
    push(preChecks, 'spec', 'maxChanges is a non-negative integer', typeOf(spec.maxChanges), false)
  }
  if (spec.settleMs !== undefined && !finiteNonNegative(spec.settleMs)) push(preChecks, 'spec', 'settleMs is a non-negative number', typeOf(spec.settleMs), false)
  if (spec.keepBaseline !== undefined && typeof spec.keepBaseline !== 'boolean') push(preChecks, 'spec', 'keepBaseline is boolean', typeOf(spec.keepBaseline), false)
  if (spec.becameCovered !== undefined) {
    if (nonEmptyString(spec.becameCovered)) {
      // shorthand: "button name"
    } else if (plainObject(spec.becameCovered)) {
      for (const key of Object.keys(spec.becameCovered)) {
        if (key !== 'name' && key !== 'by') push(preChecks, 'spec', 'becameCovered fields are name/by', `unknown field "${key}"`, false)
      }
      if (!nonEmptyString(spec.becameCovered.name)) push(preChecks, 'spec', 'becameCovered.name is a non-empty string', typeOf(spec.becameCovered.name), false)
      if (spec.becameCovered.by !== undefined && !nonEmptyString(spec.becameCovered.by)) push(preChecks, 'spec', 'becameCovered.by is a non-empty string', typeOf(spec.becameCovered.by), false)
    } else {
      push(preChecks, 'spec', 'becameCovered is a non-empty string or {name[, by]}', typeOf(spec.becameCovered), false)
    }
  }
  for (const k of ['mustInclude', 'mustNotInclude', 'only']) {
    if (spec[k] === undefined) continue
    if (!Array.isArray(spec[k])) { push(preChecks, 'spec', `${k} is an array`, typeof spec[k], false); continue }
    if (!spec[k].length) push(preChecks, 'spec', `${k} is non-empty`, 'empty array', false)
    for (const m of spec[k]) {
      if (!plainObject(m)) { push(preChecks, 'spec', `${k} entries are objects`, typeOf(m), false); continue }
      if (!Object.keys(m).length) push(preChecks, 'spec', `${k} entries contain a matcher`, 'empty object', false)
      for (const f of Object.keys(m)) if (!ENTRY_FIELDS.has(f)) push(preChecks, 'spec', 'known entry field', `unknown field "${f}" in ${k}`, false)
      if (m.kind !== undefined && !KINDS.has(m.kind)) push(preChecks, 'spec', `kind ∈ ${[...KINDS].join('/')}`, 'invalid value', false)
      for (const f of ['role', 'name', 'nameExact', 'selector']) {
        if (m[f] !== undefined && !nonEmptyString(m[f])) push(preChecks, 'spec', `${f} is a non-empty string`, typeOf(m[f]), false)
      }
      if (m.to !== undefined) {
        if (!plainObject(m.to) || !Object.keys(m.to).length) {
          push(preChecks, 'spec', 'to is a non-empty state object', typeOf(m.to), false)
        } else {
          for (const [stateKey, stateValue] of Object.entries(m.to)) {
            if (!STATE_KEYS.has(stateKey)) push(preChecks, 'spec', 'known to state field', `unknown field "${stateKey}"`, false)
            if (!['string', 'boolean'].includes(typeof stateValue)) push(preChecks, 'spec', 'to state values are string/boolean', typeOf(stateValue), false)
          }
        }
      }
    }
  }
  if (spec.retry !== undefined) {
    if (!plainObject(spec.retry)) {
      push(preChecks, 'spec', 'retry is {budgetMs[, intervalMs]}', typeOf(spec.retry), false)
    } else {
      for (const key of Object.keys(spec.retry)) {
        if (key !== 'budgetMs' && key !== 'intervalMs') push(preChecks, 'spec', 'retry fields are budgetMs/intervalMs', `unknown field "${key}"`, false)
      }
      if (!finiteNonNegative(spec.retry.budgetMs)) push(preChecks, 'spec', 'retry.budgetMs is a non-negative number', typeOf(spec.retry.budgetMs), false)
      if (spec.retry.intervalMs !== undefined && !finiteNonNegative(spec.retry.intervalMs)) push(preChecks, 'spec', 'retry.intervalMs is a non-negative number', typeOf(spec.retry.intervalMs), false)
    }
  }
  if (spec.ignore !== undefined && (!Array.isArray(spec.ignore) || spec.ignore.some((x) => !nonEmptyString(x)))) {
    push(preChecks, 'spec', 'ignore is an array of non-empty CSS selectors', typeOf(spec.ignore), false)
  }
  if (![...CHECK_KEYS].some((key) => spec[key] !== undefined)) {
    push(preChecks, 'spec', 'at least one assertion check', 'none', false)
  }
  const invalidSpec = preChecks.some((check) => check.type === 'spec' && !check.pass)

  const hasBaseline = !!prev
  const baseUrl = hasBaseline ? prevUrl : null
  if (invalidSpec) {
    return privateValue({
      type: 'assert', contract: 8, obsId, ts: Date.now(), attempts: 0,
      privacy: publicPrivacy(), hasBaseline,
      baselineUrl: baseUrl ? privateUrl(baseUrl) : undefined,
      navigated: baseUrl ? (location.origin + location.pathname) !== baseUrl : undefined,
      pass: false, checks: preChecks, unobservable: 0, unobservableDetails: [],
    })
  }
  const pause = makeSlicer(40)
  const tInf = performance.now()
  const baseline = await inflatedBaseline()
  pacc('inflate', tInf)
  const needsDiff = !invalidSpec && (spec.changed !== undefined || spec.mustInclude || spec.mustNotInclude ||
    spec.only || spec.maxChanges !== undefined || spec.becameVisible || spec.becameCovered
  )
  // no baseline → every diff check fails LOUDLY (panel 3a: the post-reload vacuous pass)
  if (needsDiff && !hasBaseline) push(preChecks, 'baseline', 'established (send SNAPDOM_OBSERVE first)', 'missing', false)

  const labelOf = (ui, c) => {
    if (c.name) return String(c.name)
    const n = c.id && ui.__snapshot.nodes.get(c.id)
    if (n && (n.name || n.text)) return String(n.name || n.text)
    const el = c.id && ui.__snapshot.elements.get(c.id)
    return el ? priv((el.textContent || '').replace(/\s+/g, ' ').trim()) : ''
  }
  const matchChange = (ui, c, m) =>
    (!m.kind || c.kind === m.kind) &&
    (!m.role || c.role === m.role) &&
    (!m.selector || selectorOf(ui.__snapshot.elements.get(c.id)) === m.selector) &&
    (!m.name || norm(labelOf(ui, c)).includes(norm(m.name))) &&
    (!m.nameExact || norm(labelOf(ui, c)) === norm(m.nameExact)) &&
    (!m.to || (c.after && Object.entries(m.to).every(([k, v]) => c.after[k] === v)))

  const inIgnored = (ui, id) => {
    if (!Array.isArray(spec.ignore) || !spec.ignore.length || !id) return false
    const el = ui.__snapshot.elements.get(id)
    if (!el || !el.closest) return false
    return spec.ignore.some((sel) => { try { return !!el.closest(sel) } catch { return false } })
  }
  const privacyKey = (value) => {
    let out = String(value || '')
    for (let depth = 0; depth < 3; depth++) {
      try { const next = decodeURIComponent(out); if (next === out) break; out = next } catch { break }
    }
    return out.toLowerCase()
  }
  const privacyBlocks = (query) => !!(query && PRIVACY && PRIVACY.redact && PRIVACY.redact.some((rule) => {
    const r = privacyKey(rule)
    const q = privacyKey(query)
    return q.includes(r) || r.includes(q)
  }))
  const evaluate = async (ui, torn = 0) => {
    const checks = [...preChecks]
    if (invalidSpec) return { checks, changes: [], pass: false }
    // ignore: the measuring apparatus must be excludable — the panel caught the
    // Claude toolbar's own show/hide transition contaminating changed:false
    const changes = (ui.changes || []).filter((c) => !inIgnored(ui, c.id))
    const uncertainty = [
      ui.unobservable.length ? `${ui.unobservable.length} unobservable region(s)` : null,
      torn ? `observation torn by ${torn} concurrent mutation(s)` : null,
    ].filter(Boolean).join('; ')
    if (spec.urlIncludes !== undefined) {
      if (privacyBlocks(spec.urlIncludes)) {
        push(checks, 'urlIncludes', '[redacted]', 'blocked by privacy rule', false)
      } else {
        const here = location.href
        push(checks, 'urlIncludes', spec.urlIncludes, privateUrlEvidence(here), here.includes(spec.urlIncludes))
      }
    }
    if (spec.changed !== undefined) {
      if (!hasBaseline) push(checks, 'changed', spec.changed, 'no-baseline', false)
      else {
        const eff = changes.length > 0
        // A blind region can change without producing a semantic diff. It invalidates a
        // negative, and makes an empty positive result UNKNOWN rather than false. A real
        // semantic diff remains sufficient evidence for changed:true.
        if (uncertainty && (!spec.changed || !eff)) {
          push(checks, 'changed', spec.changed, `unknown: ${uncertainty}`, false)
        } else {
          push(checks, 'changed', spec.changed, eff, eff === spec.changed)
        }
      }
    }
    if (Array.isArray(spec.mustInclude)) {
      for (const m of spec.mustInclude) {
        const hit = hasBaseline && changes.some((c) => matchChange(ui, c, m))
        push(checks, 'mustInclude', m, hasBaseline ? (hit ? 'found' : 'absent') : 'no-baseline', hit)
      }
    }
    if (Array.isArray(spec.mustNotInclude)) {
      for (const m of spec.mustNotInclude) {
        const hit = hasBaseline && changes.some((c) => matchChange(ui, c, m))
        const blind = hasBaseline && !hit && !!uncertainty
        push(checks, 'mustNotInclude', m,
          hit ? 'found' : blind ? `unknown: ${uncertainty}` : (hasBaseline ? 'absent' : 'no-baseline'),
          hasBaseline && !hit && !blind)
      }
    }
    if (Array.isArray(spec.only) && spec.only.length) {
      // causal scoping: EVERY (non-ignored) change must match one of the matchers
      const offender = hasBaseline ? changes.find((c) => !spec.only.some((m) => matchChange(ui, c, m))) : null
      const blind = hasBaseline && !offender && !!uncertainty
      push(checks, 'only', spec.only,
        offender ? `unmatched: ${offender.kind} "${labelOf(ui, offender).slice(0, 40)}"` : blind ? `unknown: ${uncertainty}` : (hasBaseline ? 'all matched' : 'no-baseline'),
        hasBaseline && !offender && !blind)
    }
    if (spec.maxChanges !== undefined) {
      const over = hasBaseline && changes.length > spec.maxChanges
      const blind = hasBaseline && !over && !!uncertainty
      push(checks, 'maxChanges', spec.maxChanges,
        over ? changes.length : blind ? `unknown: ${uncertainty}; observed ${changes.length}` : changes.length,
        hasBaseline && !over && !blind)
    }
    if (spec.becameVisible) {
      const hit = hasBaseline && (ui.actionabilityDelta?.becameVisible || []).some((r) => norm(r.name || r.role).includes(norm(spec.becameVisible)))
      push(checks, 'becameVisible', spec.becameVisible, hit ? 'found' : 'absent', hit)
    }
    if (spec.becameCovered) {
      const want = typeof spec.becameCovered === 'string' ? { name: spec.becameCovered } : spec.becameCovered
      const hit = hasBaseline && (ui.actionabilityDelta?.becameCovered || []).some((r) => {
        if (!norm(r.name || r.role).includes(norm(want.name || ''))) return false
        if (!want.by) return true
        const e = ui.agentMap.map.find((x) => norm(x.n).includes(norm(want.name || '')))
        const by = e && e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)
        return norm(by || '').includes(norm(want.by))
      })
      push(checks, 'becameCovered', spec.becameCovered, hit ? 'found' : 'absent', hit)
    }
    if (privacyBlocks(spec.exists)) {
      // a text predicate touching a redact rule would confirm the hidden term's
      // presence (1-bit probe) — fail loud instead of answering
      push(checks, 'exists', '[redacted]', 'blocked by privacy rule', false)
    } else if (spec.exists) {
      // accessible names AND page text (panel 3i: paragraph prose must be findable).
      // innerText arrives with line breaks — collapse whitespace on BOTH sides or a
      // query spanning a wrap point reads absent ("Switch branches/tags", github round)
      const ms = await findMatches(ui, spec.exists)
      const inProse = !ms.length && norm((document.body.innerText || '').replace(/\s+/g, ' ')).includes(norm(String(spec.exists).replace(/\s+/g, ' ')))
      push(checks, 'exists', spec.exists, ms.length ? `${ms.length} match(es)` : (inProse ? 'in page text' : 'absent'), ms.length > 0 || inProse)
    }
    if (privacyBlocks(spec.notCovered)) {
      // Answering found/covered/clear would reveal a hidden term through a one-bit
      // presence and actionability side channel.
      push(checks, 'notCovered', '[redacted]', 'blocked by privacy rule', false)
    } else if (spec.notCovered) {
      const q = norm(spec.notCovered)
      // match by accessible name OR visible text (panel: the visible label failed)
      const e = ui.agentMap.map.find((x) => {
        if (norm(x.n).includes(q)) return true
        const el = ui.__snapshot.elements.get(x.id)
        return el && norm((el.textContent || '').replace(/\s+/g, ' ')).includes(q)
      })
      const matchesAll = ui.agentMap.map.filter((x) => {
        if (norm(x.n).includes(q)) return true
        const el = ui.__snapshot.elements.get(x.id)
        return el && norm((el.textContent || '').replace(/\s+/g, ' ')).includes(q)
      })
      const v = e && vboxOf(ui.__snapshot.nodes.get(e.id)?.bbox && ui.__snapshot.nodes.get(e.id).bbox)
      const off = e && v && !inViewOf(v)
      // offscreen is NOT clickable: clear·offscreen now FAILS (round 2: a 1-char
      // substring matching something 400px below the fold returned green)
      const count = matchesAll.length > 1 ? ` (${matchesAll.length} matches, first by DOM order)` : ''
      push(checks, 'notCovered', spec.notCovered, e ? ((e.covered ? 'covered' : 'clear') + (off ? '·offscreen' : '') + count) : 'absent', !!(e && !e.covered && !off))
    }
    // zero-check guard: a spec whose checks all validated away must not pass —
    // {mustInclude: []} returned green with 0 checks (round 2)
    if (!checks.some((c) => c.type !== 'spec')) push(checks, 'spec', 'at least one check emitted', 'none', false)
    return { checks, changes, pass: checks.every((c) => c.pass) }
  }

  // settle + retry against the SAME baseline (panel 3g: transitions land mid-flight;
  // single-shot snapshotting made correctness a race with the CSS timeline)
  if (!invalidSpec && spec.settleMs) await new Promise((r) => setTimeout(r, Math.min(10000, spec.settleMs)))
  const budget = invalidSpec ? 0 : Math.min(15000, spec.retry?.budgetMs || 0)
  const interval = invalidSpec ? 250 : Math.max(100, spec.retry?.intervalMs || 250)
  let ui, lastObs, result, attempts = 0
  for (;;) {
    attempts++
    lastObs = await observeChunked(document.body, {
      ...(baseline ? { previous: baseline } : {}),
      ...privacyOpts(),
    })
    pause.reset()
    let t = performance.now()
    ui = buildUi(lastObs, privacyOpts())
    pacc('buildUi', t)
    const p = pause()
    if (p) await p
    t = performance.now()
    result = await evaluate(ui, lastObs.torn || 0)
    pause.reset()
    pacc('evaluate', t)
    if (result.pass || performance.now() - t0 >= budget) break
    await new Promise((r) => setTimeout(r, interval))
  }
  {
    const p = pause()
    if (p) await p
  }
  let t = performance.now()
  if (!spec.keepBaseline) setBaseline(ui.checkpoint())
  pacc('checkpoint', t)

  const ranDiff = hasBaseline && needsDiff
  const effective = result.changes || []
  let evidence
  if (ranDiff) {
    t = performance.now()
    evidence = []
    for (const c of effective.slice(0, 60)) {
      const p = pause()
      if (p) await p
      evidence.push({
        kind: c.kind, role: c.role, name: labelOf(ui, c).slice(0, 60) || undefined,
        selector: selectorOf(ui.__snapshot.elements.get(c.id)) || undefined,
        from: c.before, to: c.after,
      })
    }
    pacc('evidence', t)
  }
  return privateValue({
    type: 'assert', contract: 8, obsId, ts: Date.now(),
    walkMs: Math.round(performance.now() - t0), attempts,
    privacy: publicPrivacy(ui),
    torn: (lastObs && lastObs.torn) || 0,
    unobservable: ui ? ui.unobservable.length : 0,
    unobservableDetails: ui ? ui.unobservable : [],
    hasBaseline,
    baselineUrl: baseUrl ? privateUrl(baseUrl) : undefined,
    navigated: baseUrl ? (location.origin + location.pathname) !== baseUrl : undefined,
    pass: result.pass,
    checks: result.checks,
    // the panel's profiling round could not break down the assert pipeline because
    // prof came back null here — same shape as the observe prof, per stage
    prof: profFlag ? Object.fromEntries(Object.entries(window.__SD_PROF || {}).map(([k, v]) => [k, Math.round(v)])) : undefined,
    changesTotal: ranDiff ? effective.length : undefined,
    evidenceCap: 60,
    changes: evidence,
  })
}

function normalizePolicy(value) {
  if (value === null) return { ok: true, policy: null, key: 'none' }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'redact') || !Array.isArray(value.redact) ||
      value.redact.some((rule) => typeof rule !== 'string')) {
    return { ok: false, error: 'invalid privacy policy' }
  }
  const redact = value.redact.map((rule) => rule.trim()).filter(Boolean)
  if (!redact.length) return { ok: false, error: 'invalid privacy policy: no effective rules' }
  const policy = { redact }
  // Matching is case-insensitive. Avoid discarding a trustworthy baseline for a policy
  // update that differs only in casing/outer whitespace, while still treating order or
  // rule-count changes conservatively as a new observation boundary.
  return { ok: true, policy, key: JSON.stringify(redact.map((rule) => rule.toLowerCase())) }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the service worker of THIS extension can reach onMessage. External clients
  // reach onMessageExternal in worker.js and never talk to a content script directly.
  // Top-frame only is enforced both by the manifest and by the worker's frameId: 0.
  if (!message || message.channel !== 'snapdom-companion-internal-v1') return false
  const request = message.request || {}
  const obsId = request.obsId ?? request.token ?? null
  const normalized = normalizePolicy(message.policy)
  if (!normalized.ok) {
    sendResponse({ contract: 8, obsId, error: normalized.error })
    return false
  }
  if (normalized.key !== PRIVACY_KEY) {
    // A checkpoint contains privacy-derived identities and hashes. Comparing it against
    // a snapshot produced under another policy creates changes out of policy mechanics,
    // not DOM mutations. Establish a fresh baseline on OBSERVE; ASSERT will honestly
    // report a missing baseline for diff predicates.
    clearBaseline()
    PRIVACY_KEY = normalized.key
  }
  PRIVACY = normalized.policy
  ;(async () => {
    if (request.type === 'SNAPDOM_ASSERT') {
        try { return await runAssert(request.spec, obsId, request.prof) } catch (err) {
        const error = privateError(err)
        return { type: 'assert', contract: 8, obsId, ts: Date.now(), pass: false, checks: [{ type: 'error', expected: 'valid spec/execution', actual: error, pass: false }], error }
      }
    }
    if (request.type === 'SNAPDOM_OBSERVE') {
      try { return await runObserve({ top: request.top, heads: request.heads, fullUrl: request.fullUrl, match: request.match, prof: request.prof, obsId }) } catch (err) {
        return { contract: 8, error: privateError(err), url: privateUrl(location.origin + location.pathname), ts: Date.now(), obsId }
      }
    }
    return { contract: 8, obsId, error: `unsupported request type: ${String(request.type)}` }
  })().then(sendResponse, (err) => sendResponse({ contract: 8, obsId, error: privateError(err) }))
  return true
})
