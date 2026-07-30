/**
 * Scores BLIND judge verdicts against the ground truth the judges never saw.
 *
 *   node packages/agent/experiment/score.mjs <verdicts.json>
 *
 * verdicts.json: [{scenario, arm, userVisibleChange, nowUnclickable, understandable, summary}]
 *
 * Each arm is scored on the question ITS stratum poses, not on a generic
 * changed/unchanged boolean (see EXPERIMENT.md for why that distinction matters).
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const EV = join(dirname(fileURLToPath(import.meta.url)), 'results', 'evidence')
const verdicts = JSON.parse(await readFile(process.argv[2], 'utf8'))

const truths = {}
for (const dir of await readdir(EV)) {
  truths[dir] = JSON.parse(await readFile(join(EV, dir, '_truth.json'), 'utf8'))
}

const rows = verdicts.map((v) => {
  const t = truths[v.scenario]
  if (!t) return null
  const r = { scenario: v.scenario, stratum: t.stratum, arm: v.arm }
  // Q1 — did anything user-visible change?
  r.changeCorrect = v.userVisibleChange === t.truth.userVisibleChange
  // Q2 — occlusion: which elements stopped being clickable? (only where it applies)
  if (t.truth.mustReportCovered) {
    // Scored on IDENTIFICATION: the judge must single out the right number of
    // previously-clickable elements. Whether it names them or cites opaque ids is a
    // separate usability axis, tracked as `namedThem` (a bare-id answer is technically
    // correct but useless to a caller — the finding that drove the actionability fix).
    const said = (v.nowUnclickable || [])
    const lower = said.join(' ').toLowerCase()
    r.occlusionCorrect = said.length >= t.truth.mustReportCovered.length
    // Each expected element may be cited by any of its accepted identifiers.
    r.namedThem = t.truth.mustReportCovered.every((alts) =>
      (Array.isArray(alts) ? alts : [alts]).some((n) => lower.includes(String(n).toLowerCase())))
  }
  // Q3 — canvas honesty: the evidence must ADMIT a region is not understandable.
  if (t.truth.onlyPixels) r.canvasHonest = v.understandable === false
  return r
}).filter(Boolean)

const arms = ['A', 'B', 'C']
const pct = (n, d) => (d ? +(n / d).toFixed(2) : null)
const summary = {}
for (const arm of arms) {
  const mine = rows.filter((r) => r.arm === arm)
  const occl = mine.filter((r) => r.occlusionCorrect !== undefined)
  const canv = mine.filter((r) => r.canvasHonest !== undefined)
  summary[arm] = {
    n: mine.length,
    changeAccuracy: pct(mine.filter((r) => r.changeCorrect).length, mine.length),
    falsePositives: mine.filter((r) => !r.changeCorrect && truths[r.scenario].truth.userVisibleChange === false).length,
    falseNegatives: mine.filter((r) => !r.changeCorrect && truths[r.scenario].truth.userVisibleChange === true).length,
    occlusionAccuracy: pct(occl.filter((r) => r.occlusionCorrect).length, occl.length),
    occlusionNamed: pct(occl.filter((r) => r.namedThem).length, occl.length),
    canvasHonesty: pct(canv.filter((r) => r.canvasHonest).length, canv.length),
  }
}
const byStratum = {}
for (const r of rows) {
  const s = (byStratum[r.stratum] ||= {})
  const a = (s[r.arm] ||= { correct: 0, n: 0 })
  a.n++
  // The stratum's own question: occlusion → who is covered; canvas → honesty; else change.
  const ok = r.occlusionCorrect !== undefined ? r.occlusionCorrect
    : r.canvasHonest !== undefined ? r.canvasHonest
      : r.changeCorrect
  if (ok) a.correct++
}
console.log(JSON.stringify({ summary, byStratum, rows }, null, 1))
