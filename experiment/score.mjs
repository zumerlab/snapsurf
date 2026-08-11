/**
 * Scores BLIND judge verdicts against the ground truth the judges never saw.
 *
 *   node experiment/score.mjs <verdicts.json>
 *
 * verdicts.json: [{scenario, arm, userVisibleChange, nowUnclickable, understandable, summary}]
 *
 * Each arm is scored on the question ITS stratum poses, not on a generic
 * changed/unchanged boolean (see EXPERIMENT.md for why that distinction matters).
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { scoreVerdict } from './verdict.mjs'

const EV = join(dirname(fileURLToPath(import.meta.url)), 'results', 'evidence')
const verdicts = JSON.parse(await readFile(process.argv[2], 'utf8'))

const truths = {}
for (const dir of await readdir(EV)) {
  truths[dir] = JSON.parse(await readFile(join(EV, dir, '_truth.json'), 'utf8'))
}

const rows = verdicts.map((v) => {
  const t = truths[v.scenario]
  if (!t) return null
  return { scenario: v.scenario, stratum: t.stratum, arm: v.arm, ...scoreVerdict(v, t.truth) }
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
  if (r.stratumCorrect) a.correct++
}
console.log(JSON.stringify({ summary, byStratum, rows }, null, 1))
