// Formal benchmark — external judge CLI.
// Usage: node experiment/formal/judge.mjs <results-file.json>
// Reads a run file (schema in README.md), judges every entry against tasks.mjs,
// writes <file>.judged.json next to it and prints a verdict table.
// A FALSE GREEN is an entry the runner claimed successful that the judge fails.

import fs from 'node:fs'
import { tasks } from './tasks.mjs'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: node judge.mjs <results-file.json>')
  process.exit(1)
}

const run = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!run.arm || !Array.isArray(run.entries)) {
  console.error('malformed run file: needs { arm, entries: [...] }')
  process.exit(1)
}

const judged = []
for (const entry of run.entries) {
  const judge = tasks[entry.task]
  let result
  if (!judge) {
    result = { verdict: 'error', expected: '', detail: `unknown task id "${entry.task}"` }
  } else {
    try {
      result = await judge(entry)
    } catch (err) {
      result = { verdict: 'error', expected: '', detail: `judge error: ${err.message}` }
    }
  }
  judged.push({ ...entry, judge: result })
}

const out = { ...run, judgedAt: new Date().toISOString(), entries: judged }
const outFile = file.replace(/\.json$/, '') + '.judged.json'
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n')

const passN = judged.filter((e) => e.judge.verdict === 'pass').length
const falseGreens = judged.filter((e) => e.claimed === true && e.judge.verdict === 'fail')
const falseReds = judged.filter((e) => e.claimed === false && e.judge.verdict === 'pass')

console.log(`\n${run.arm} (rep ${run.rep ?? '?'}) — ${file}`)
console.log('task            claimed  judged  detail')
for (const e of judged) {
  const mark = e.judge.verdict === 'pass' ? '✓' : e.judge.verdict === 'fail' ? '✗' : '!'
  console.log(
    `${e.task.padEnd(15)} ${String(e.claimed).padEnd(8)} ${mark} ${e.judge.verdict.padEnd(5)} ${e.judge.detail}`
  )
}
console.log(`\njudged pass: ${passN}/${judged.length}`)
if (falseGreens.length) console.log(`FALSE GREENS: ${falseGreens.length} — ${falseGreens.map((e) => e.task).join(', ')}`)
if (falseReds.length) console.log(`false reds (claimed fail, judged pass): ${falseReds.map((e) => e.task).join(', ')}`)
console.log(`written: ${outFile}`)
