// Formal benchmark — aggregator.
// Usage: node experiment/formal/report.mjs [resultsDir]
// Reads every *.judged.json in resultsDir (default: ./results), groups by arm,
// prints the paper tables as markdown: summary per arm + task×arm matrix.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = process.argv[2] || path.join(here, 'results')
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.judged.json')) : []
if (!files.length) {
  console.error(`no *.judged.json files in ${dir}`)
  process.exit(1)
}

const runs = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
const arms = [...new Set(runs.map((r) => r.arm))].sort()
const taskIds = [...new Set(runs.flatMap((r) => r.entries.map((e) => e.task)))]

const pct = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const fmtMs = (ms) => Number.isNaN(ms) ? 'n/a' : ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`

console.log('## Summary per arm\n')
console.log('| arm | reps | judged pass (per rep) | false greens | actions (median/task) | wall p50 | wall p95 | tokens obs. (median) |')
console.log('|---|---:|---|---:|---:|---:|---:|---:|')
for (const arm of arms) {
  const rs = runs.filter((r) => r.arm === arm)
  const perRep = rs.map((r) => `${r.entries.filter((e) => e.judge.verdict === 'pass').length}/${r.entries.length}`)
  const entries = rs.flatMap((r) => r.entries)
  const fg = entries.filter((e) => e.claimed === true && e.judge.verdict === 'fail').length
  const actions = entries.map((e) => e.actions).filter((n) => typeof n === 'number')
  const walls = entries.map((e) => e.wallMs).filter((n) => typeof n === 'number')
  const tokens = entries.map((e) => e.tokensObserved).filter((n) => typeof n === 'number')
  console.log(`| ${arm} | ${rs.length} | ${perRep.join(' · ')} | ${fg} | ${pct(actions, 50) ?? 'n/a'} | ${fmtMs(pct(walls, 50))} | ${fmtMs(pct(walls, 95))} | ${tokens.length ? pct(tokens, 50) : 'n/a (not exposed)'} |`)
}

console.log('\n## Task × arm (judged passes / reps)\n')
console.log(`| task | ${arms.join(' | ')} |`)
console.log(`|---|${arms.map(() => '---').join('|')}|`)
for (const t of taskIds) {
  const cells = arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm)
    const es = rs.flatMap((r) => r.entries.filter((e) => e.task === t))
    if (!es.length) return '—'
    return `${es.filter((e) => e.judge.verdict === 'pass').length}/${es.length}`
  })
  console.log(`| ${t} | ${cells.join(' | ')} |`)
}

const errs = runs.flatMap((r) => r.entries.filter((e) => e.judge.verdict === 'error').map((e) => `${r.arm}/${e.task}: ${e.judge.detail}`))
if (errs.length) {
  console.log('\n## Judge errors (re-run judge.mjs on these files)\n')
  for (const e of errs) console.log(`- ${e}`)
}
