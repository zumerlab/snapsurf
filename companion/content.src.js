/**
 * Companion content script (source — bundled into content.bundle.js).
 *
 * Runs in the ISOLATED WORLD: immune to page CSP (what killed page-world injection:
 * CSP on wikipedia/ebay + Private Network Access toward localhost), with a shared
 * DOM. The oracle lives here; the page world (and any agent with a javascript tool,
 * like the Claude extension) talks to it via postMessage and reads the result from
 * a DOM node:
 *
 *   window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId }, '*')
 *   // await SNAPDOM_DIGEST_READY (echoes obsId), then:
 *   JSON.parse(document.getElementById('__snapdom_digest').textContent)
 *
 * The digest includes the DIFF against the previous observation of the same
 * document — the Claude extension stops paying screenshots to know what changed.
 */
import { observeChunked, buildUi } from '../src/plugin.js'

const NODE_ID = '__snapdom_digest'
let prev = null

// CSS selector the READER can act with (its own click tools) — feedback from the
// Claude-extension panel: our n_xxx ids aren't actionable from outside the oracle.
// Read-only: no DOM stamping, no self-inflicted diff noise.
// UNIQUE or ABSENT — never a selector that resolves to a different element (panel
// round 6: 3/6 relative selectors matched 24-134 elements and querySelector returned
// the WRONG headline; acting on that clicks the wrong thing). Full nth-of-type path
// up to the nearest #id ancestor or the root, then VERIFIED against the element.
function selectorOf(el) {
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
function sectionOf(el) {
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
          const t = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
          if (t && t !== ownText) return t
        }
        const al = cur.getAttribute('aria-label')
        if (al && al.slice(0, 60) !== ownText) return al.slice(0, 60)
      }
    }
    cur = cur.parentElement
    depth++
  }
  return undefined
}

function digestOf(ui, topN, headsN) {
  const marks = []
  const heads = []
  const LANDMARKS = { navigation: 1, main: 1, banner: 1, contentinfo: 1, search: 1, form: 1, complementary: 1 }
  for (const id of ui.__snapshot.order) {
    const n = ui.__snapshot.nodes.get(id)
    if (!n) continue
    if (n.role === 'heading' && heads.length < headsN) {
      const el = ui.__snapshot.elements.get(id)
      heads.push({ id, text: (n.name || n.text || '').slice(0, 120), section: sectionOf(el) })
    } else if (LANDMARKS[n.role] && marks.length < 10) marks.push({ id, role: n.role, name: (n.name || '').slice(0, 60), bbox: n.bbox })
  }
  const top = ui.agentMap.map.slice(0, topN).map((e) => {
    const el = ui.__snapshot.elements.get(e.id)
    // href: the panel's read_page gave hrefs without names, our digest names without
    // hrefs — neither sufficed alone (lanacion buscador). Together the digest does.
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = ((u.origin === location.origin ? '' : u.origin) + u.pathname + u.search).slice(0, 300) }
    } catch { /* noop */ }
    const v = vboxOf(e.b)
    return {
      id: e.id, role: e.r, name: (e.n || '').slice(0, 120),
      bbox: e.b, vbox: v, inView: inViewOf(v),
      selector: selectorOf(el),
      href: href || undefined,
      section: sectionOf(el),
      covered: e.covered ? (e.coveredBy && (e.coveredBy.name || e.coveredBy.label || e.coveredBy.role)) || true : undefined,
    }
  })
  return { marks, heads, top }
}

// match: the in-page find — searches the WHOLE snapshot (names + text), not the
// top-N window. Panel round 5: lanacion's front page outran top:100/heads:60 (38kB
// and still not found) while a text match is one call and ~2kB. Full text up to
// 300 chars — its native find and read_page both truncate at 100.
function findMatches(ui, query) {
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const q = norm(query)
  const out = new Map()
  const add = (id, role, name) => {
    if (!name || out.has(id) || !norm(name).includes(q)) return
    const el = ui.__snapshot.elements.get(id)
    const n = ui.__snapshot.nodes.get(id)
    let href = null
    try {
      const raw = el && el.getAttribute && el.getAttribute('href')
      // navigable, not a teaser: 100 chars cut "…nid28072026/" mid-id (panel round 6)
      if (raw && !raw.startsWith('#')) { const u = new URL(raw, location.href); href = ((u.origin === location.origin ? '' : u.origin) + u.pathname + u.search).slice(0, 500) }
    } catch { /* noop */ }
    // snapshot name/text arrive pre-truncated (~80c) — take the LONGER of snapshot
    // vs live DOM text so the 300c contract holds (the h2 was 127c, arrived 80c)
    const fromSnap = ((n && (n.name || n.text)) || name || '').replace(/\s+/g, ' ').trim()
    const fromDom = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const full = (fromDom.length > fromSnap.length ? fromDom : fromSnap).slice(0, 300)
    const v = vboxOf(n && n.bbox)
    out.set(id, {
      id, role, text: full, href: href || undefined,
      selector: selectorOf(el), section: sectionOf(el),
      bbox: n && n.bbox, vbox: v, inView: inViewOf(v),
    })
  }
  for (const e of ui.agentMap.map) add(e.id, e.r, e.n)
  for (const id of ui.__snapshot.order) {
    if (out.size >= 20) break
    const n = ui.__snapshot.nodes.get(id)
    add(id, n.role, n.name || n.text)
  }
  return [...out.values()].slice(0, 20)
}

async function runObserve(opts = {}) {
  const t0 = performance.now()
  const obs = await observeChunked(document.body, prev ? { previous: prev } : {})
  const ui = buildUi(obs, {})
  prev = ui.checkpoint()
  // Every change carries a readable label: name, else the node's own text, else the
  // subtree text — 29/30 anonymous `generic` changes made the panel's first diff
  // useless. Named changes sort first.
  const describeChange = (c) => {
    let label = c.name && String(c.name).slice(0, 60)
    if (!label && c.id) {
      const n = ui.__snapshot.nodes.get(c.id)
      if (n) label = ((n.name || n.text || '')).slice(0, 60) || undefined
      if (!label) {
        const el = ui.__snapshot.elements.get(c.id)
        if (el) label = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined
      }
    }
    return { kind: c.kind, role: c.role, name: label, id: c.id, selector: selectorOf(ui.__snapshot.elements.get(c.id)) || undefined }
  }
  const out = {
    // origin+pathname only: the Claude extension's sanitizer redacts URLs carrying
    // query strings ("[BLOCKED: Cookie/query string data]")
    url: location.origin + location.pathname,
    // opt-in full URL (query included): the default stays sanitized because the
    // Claude-extension sanitizer redacts query-bearing urls, but on a search-results
    // page the query IS the meaning — the reader decides.
    urlFull: opts.fullUrl ? location.href : undefined,
    ts: Date.now(),
    // obsId, NOT "token": the panel's JS bridge censors any key literally named
    // token ("[BLOCKED: Sensitive key]") — the echo was unverifiable from its side.
    obsId: opts.obsId ?? undefined,
    // Coordinate contract (panel round 3): vbox is CSS px of THIS viewport; readers
    // whose screenshots are scaled (dpr) compute scale = screenshotWidth / viewport.width.
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
    walkMs: Math.round(performance.now() - t0),
    // chunked walk: the tab stays responsive; torn counts DOM mutations that landed
    // WHILE the walk was parked — a non-zero torn means re-observe if it matters
    torn: obs.torn || 0,
    actionables: ui.agentMap.map.length,
    unobservable: ui.unobservable.length,
    changed: ui.changed,
    changes: ui.changes
      ? ui.changes.map(describeChange).sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0)).slice(0, 40)
      : undefined,
    actionabilityDelta: ui.actionabilityDelta,
    // match present → matches only (~2kB); digest only otherwise (a 38kB top:100
    // digest that still misses the target is the wrong tool for long front pages)
    matches: opts.match ? findMatches(ui, opts.match) : undefined,
    digest: opts.match ? undefined : digestOf(ui, Math.min(100, opts.top || 25), Math.min(60, opts.heads || 15)),
  }
  let node = document.getElementById(NODE_ID)
  if (!node) {
    node = document.createElement('script')
    node.type = 'application/json'
    node.id = NODE_ID
    document.documentElement.appendChild(node)
  }
  node.textContent = JSON.stringify(out)
  return out
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

async function runAssert(spec, obsId) {
  const t0 = performance.now()
  spec = spec || {}
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const preChecks = []
  const push = (arr, type, expected, actual, pass) => arr.push({ type, expected, actual, pass })

  // strict spec, ALL levels: a typo must never look like success — round 1 fixed the
  // top level, round 2 found entry fields, kind values, retry shapes and empty
  // matcher arrays all still failing OPEN. Everything validates now.
  for (const k of Object.keys(spec)) {
    if (!CHECK_KEYS.has(k) && !MOD_KEYS.has(k)) push(preChecks, 'spec', 'known key', `unknown key "${k}"`, false)
  }
  for (const k of ['mustInclude', 'mustNotInclude', 'only']) {
    if (spec[k] === undefined) continue
    if (!Array.isArray(spec[k])) { push(preChecks, 'spec', `${k} is an array`, typeof spec[k], false); continue }
    if (!spec[k].length) push(preChecks, 'spec', `${k} is non-empty`, 'empty array', false)
    for (const m of spec[k]) {
      if (typeof m !== 'object' || !m) { push(preChecks, 'spec', `${k} entries are objects`, typeof m, false); continue }
      for (const f of Object.keys(m)) if (!ENTRY_FIELDS.has(f)) push(preChecks, 'spec', 'known entry field', `unknown field "${f}" in ${k}`, false)
      if (m.kind !== undefined && !KINDS.has(m.kind)) push(preChecks, 'spec', `kind ∈ ${[...KINDS].join('/')}`, `"${m.kind}"`, false)
    }
  }
  if (spec.retry !== undefined && (typeof spec.retry !== 'object' || !spec.retry || typeof spec.retry.budgetMs !== 'number')) {
    push(preChecks, 'spec', 'retry is {budgetMs[, intervalMs]}', JSON.stringify(spec.retry), false)
  }
  if (spec.ignore !== undefined && (!Array.isArray(spec.ignore) || spec.ignore.some((x) => typeof x !== 'string'))) {
    push(preChecks, 'spec', 'ignore is an array of CSS selectors', JSON.stringify(spec.ignore), false)
  }

  const hasBaseline = !!prev
  const baseline = prev
  const needsDiff = spec.changed !== undefined || spec.mustInclude || spec.mustNotInclude ||
    spec.only || spec.maxChanges !== undefined || spec.becameVisible || spec.becameCovered
  // no baseline → every diff check fails LOUDLY (panel 3a: the post-reload vacuous pass)
  if (needsDiff && !hasBaseline) push(preChecks, 'baseline', 'established (send SNAPDOM_OBSERVE first)', 'missing', false)

  const labelOf = (ui, c) => {
    if (c.name) return String(c.name)
    const n = c.id && ui.__snapshot.nodes.get(c.id)
    if (n && (n.name || n.text)) return String(n.name || n.text)
    const el = c.id && ui.__snapshot.elements.get(c.id)
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''
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
  const evaluate = (ui) => {
    const checks = [...preChecks]
    // ignore: the measuring apparatus must be excludable — the panel caught the
    // Claude toolbar's own show/hide transition contaminating changed:false
    const changes = (ui.changes || []).filter((c) => !inIgnored(ui, c.id))
    if (spec.urlIncludes !== undefined) {
      const here = location.origin + location.pathname + location.search
      push(checks, 'urlIncludes', spec.urlIncludes, location.origin + location.pathname, here.includes(spec.urlIncludes))
    }
    if (spec.changed !== undefined) {
      if (!hasBaseline) push(checks, 'changed', spec.changed, 'no-baseline', false)
      else {
        const eff = changes.length > 0
        push(checks, 'changed', spec.changed, eff, eff === spec.changed)
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
        push(checks, 'mustNotInclude', m, hit ? 'found' : 'absent', hasBaseline && !hit)
      }
    }
    if (Array.isArray(spec.only) && spec.only.length) {
      // causal scoping: EVERY (non-ignored) change must match one of the matchers
      const offender = hasBaseline ? changes.find((c) => !spec.only.some((m) => matchChange(ui, c, m))) : null
      push(checks, 'only', spec.only, offender ? `unmatched: ${offender.kind} "${labelOf(ui, offender).slice(0, 40)}"` : (hasBaseline ? 'all matched' : 'no-baseline'), hasBaseline && !offender)
    }
    if (spec.maxChanges !== undefined) {
      push(checks, 'maxChanges', spec.maxChanges, changes.length, hasBaseline && changes.length <= spec.maxChanges)
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
    if (spec.exists) {
      // accessible names AND page text (panel 3i: paragraph prose must be findable)
      const ms = findMatches(ui, spec.exists)
      const inProse = !ms.length && norm(document.body.innerText || '').includes(norm(spec.exists))
      push(checks, 'exists', spec.exists, ms.length ? `${ms.length} match(es)` : (inProse ? 'in page text' : 'absent'), ms.length > 0 || inProse)
    }
    if (spec.notCovered) {
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
  if (spec.settleMs) await new Promise((r) => setTimeout(r, Math.min(10000, spec.settleMs)))
  const budget = Math.min(15000, spec.retry?.budgetMs || 0)
  const interval = Math.max(100, spec.retry?.intervalMs || 250)
  let ui, lastObs, result, attempts = 0
  for (;;) {
    attempts++
    lastObs = await observeChunked(document.body, baseline ? { previous: baseline } : {})
    ui = buildUi(lastObs, {})
    result = evaluate(ui)
    if (result.pass || performance.now() - t0 >= budget) break
    await new Promise((r) => setTimeout(r, interval))
  }
  if (!spec.keepBaseline) prev = ui.checkpoint()

  const ranDiff = hasBaseline && needsDiff
  const effective = result.changes || []
  const evidence = ranDiff ? effective.slice(0, 60).map((c) => ({
    kind: c.kind, role: c.role, name: labelOf(ui, c).slice(0, 60) || undefined,
    selector: selectorOf(ui.__snapshot.elements.get(c.id)) || undefined,
    from: c.before, to: c.after,
  })) : undefined
  return {
    type: 'assert', obsId, ts: Date.now(),
    walkMs: Math.round(performance.now() - t0), attempts,
    torn: (lastObs && lastObs.torn) || 0,
    hasBaseline,
    pass: result.pass,
    checks: result.checks,
    changesTotal: ranDiff ? effective.length : undefined,
    evidenceCap: 60,
    changes: evidence,
  }
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SNAPDOM_ASSERT') {
    const obsId = e.data.obsId ?? null
    ;(async () => {
      let out
      try { out = await runAssert(e.data.spec || {}, obsId) } catch (err) {
        // a malformed spec is STILL a failed assertion with a pass field — a result
        // without pass reads as success to `if (r.pass === false)` harnesses (panel 3f)
        out = { type: 'assert', obsId, ts: Date.now(), pass: false, checks: [{ type: 'error', expected: 'valid spec/execution', actual: String(err), pass: false }], error: String(err) }
      }
      const node = document.getElementById(NODE_ID) || Object.assign(document.documentElement.appendChild(document.createElement('script')), { type: 'application/json', id: NODE_ID })
      node.textContent = JSON.stringify(out)
      // The result rides IN the ready message: the shared DOM slot is a race the
      // obsId handshake never protected (round 2: reader A consumed reader B's
      // verdict through the documented boilerplate). The node stays for compat.
      window.postMessage({ type: 'SNAPDOM_DIGEST_READY', obsId, result: out }, '*')
    })()
    return
  }
  if (e.data && e.data.type === 'SNAPDOM_OBSERVE') {
    const obsId = e.data.obsId ?? e.data.token ?? null // token kept for old snippets
    ;(async () => {
      let out
      try { out = await runObserve({ top: e.data.top, heads: e.data.heads, fullUrl: e.data.fullUrl, match: e.data.match, obsId }) } catch (err) {
        out = { error: String(err), url: location.origin + location.pathname, ts: Date.now(), obsId }
        const node = document.getElementById(NODE_ID) || Object.assign(document.documentElement.appendChild(document.createElement('script')), { type: 'application/json', id: NODE_ID })
        node.textContent = JSON.stringify(out)
      }
      // The result rides IN the ready message (shared-slot race, round 2); the node
      // write above stays for backward compat.
      window.postMessage({ type: 'SNAPDOM_DIGEST_READY', obsId, result: out }, '*')
    })()
  }
})

// Presence marker: agents check this before requesting observations.
const marker = document.createElement('meta')
marker.name = '__snapdom_companion'
marker.content = '0.1.0'
document.documentElement.appendChild(marker)
