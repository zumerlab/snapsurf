/**
 * WebVoyager dataset loading + the competitor's exact task selection.
 *
 * The point of this file is comparability: the stratified sampler (mulberry32 seeded
 * with 42) and the date-adaptation rules are a faithful JS port of lumen's
 * `evals/webvoyager/run.ts` (MIT, Om Labs — https://github.com/omxyz/lumen), so that
 * `sampleStratified(loadTasks(), 25)` yields the SAME 25 task ids lumen published, with
 * the SAME instruction text after date shifting. `node dataset.mjs` asserts that.
 *
 * Dataset: WebVoyager (Apache-2.0, He et al. 2024) — see data/NOTICE.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 * @module agent/experiment/webvoyager/dataset
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATA_PATH = join(HERE, 'data', 'WebVoyager_data.jsonl')

/** The 25 ids lumen ran (their published 25/25). Used as the equality check. */
export const LUMEN_25 = [
  'Google Flights--17', 'Allrecipes--22', 'BBC News--39', 'Allrecipes--42', 'Coursera--40',
  'Amazon--16', 'Wolfram Alpha--38', 'Wolfram Alpha--41', 'Cambridge Dictionary--31',
  'Google Flights--19', 'Huggingface--24', 'Amazon--31', 'Cambridge Dictionary--9',
  'Coursera--12', 'Google Map--31', 'GitHub--25', 'Booking--20', 'ESPN--7',
  'Google Search--27', 'Apple--17', 'BBC News--18', 'Booking--30', 'ArXiv--2',
  'Google Map--40', 'Apple--6',
]

// ── Date adaptation (port of lumen run.ts) ───────────────────────────────────────────
// WebVoyager instructions hardcode 2023/2024 dates that travel sites now reject; both
// harnesses shift them forward preserving relative gaps, so neither arm is handed a
// task that is impossible for calendar reasons.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ALL_MONTHS = `${MONTHS_FULL.join('|')}|${MONTH_ABBR.join('|')}`
const expandMonth = (m) => {
  const idx = MONTH_ABBR.findIndex((a) => a.toLowerCase() === m.replace('.', '').toLowerCase())
  return idx >= 0 ? MONTHS_FULL[idx] : m
}

export function adaptDatesInInstruction(instruction, now = new Date()) {
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 86400000)
  const yearPattern = /\b(20(?:23|24|25))\b/g
  const yearsFound = new Set()
  let match
  while ((match = yearPattern.exec(instruction)) !== null) {
    const year = parseInt(match[1])
    const context = instruction.slice(Math.max(0, match.index - 50), Math.min(instruction.length, match.index + 50))
    if (new RegExp(ALL_MONTHS, 'i').test(context)) yearsFound.add(year)
  }

  const shiftYearsOnly = () => {
    const minYear = Math.min(...yearsFound)
    const yearShift = twoWeeksFromNow.getFullYear() - minYear
    if (yearShift <= 0) return instruction
    return instruction
      .replace(/\b(20(?:23|24|25))\b/g, (y) => (yearsFound.has(parseInt(y)) ? String(parseInt(y) + yearShift) : y))
      .replace(/today\s*\([^)]*\)/gi, 'today')
  }

  if (yearsFound.size > 0) {
    const fullDateRe = new RegExp(`(${ALL_MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?`, 'gi')
    const dayFirstRe = new RegExp(`(\\d{1,2})\\s+(${ALL_MONTHS})\\.?(?:\\s+(20\\d{2}))?`, 'gi')
    const parsedDates = []
    const coveredRanges = []

    while ((match = dayFirstRe.exec(instruction)) !== null) {
      const day = parseInt(match[1])
      if (day < 1 || day > 31) continue
      const year = match[3] ? parseInt(match[3]) : Math.min(...yearsFound)
      parsedDates.push({ month: expandMonth(match[2]), day, year, fullMatch: match[0], index: match.index })
      coveredRanges.push([match.index, match.index + match[0].length])
    }
    while ((match = fullDateRe.exec(instruction)) !== null) {
      const mi = match.index
      const me = mi + match[0].length
      if (coveredRanges.some(([s, e]) => mi >= s && mi < e)) continue
      const day = parseInt(match[2])
      if (day > 31) continue
      let year = match[3] ? parseInt(match[3]) : 0
      if (!year) {
        const yearMatch = instruction.slice(me, me + 20).match(/^,?\s*(20\d{2})/)
        if (yearMatch) year = parseInt(yearMatch[1])
      }
      if (!year) year = Math.min(...yearsFound)
      parsedDates.push({ month: expandMonth(match[1]), day, year, fullMatch: match[0], index: match.index })
      coveredRanges.push([mi, me])
    }

    if (parsedDates.length === 0) return shiftYearsOnly()

    const earliest = parsedDates.reduce((min, d) =>
      new Date(`${d.month} ${d.day}, ${d.year}`) < new Date(`${min.month} ${min.day}, ${min.year}`) ? d : min)
    const earliestDate = new Date(`${earliest.month} ${earliest.day}, ${earliest.year}`)
    const targetDate = new Date(now.getTime() + 45 * 86400000)
    const dayDelta = Math.round((targetDate.getTime() - earliestDate.getTime()) / 86400000)
    if (dayDelta <= 0) return instruction

    const maxFuture = new Date(now.getTime() + 300 * 86400000)
    const shiftedDates = parsedDates.map((d) => ({
      ...d, shifted: new Date(new Date(`${d.month} ${d.day}, ${d.year}`).getTime() + dayDelta * 86400000),
    }))
    if (!shiftedDates.every((d) => d.shifted >= twoWeeksFromNow && d.shifted <= maxFuture)) {
      const minYear = Math.min(...yearsFound)
      const yearShift = now.getFullYear() - minYear
      if (yearShift <= 0) return instruction
      return instruction
        .replace(/\b(20(?:23|24|25))\b/g, (y) => (yearsFound.has(parseInt(y)) ? String(parseInt(y) + yearShift) : y))
        .replace(/today\s*\([^)]*\)/gi, 'today')
    }

    let result = instruction
    for (const d of [...shiftedDates].sort((a, b) => b.index - a.index)) {
      const origSlice = result.slice(d.index, d.index + d.fullMatch.length + 10)
      const hasYear = /^,?\s*20\d{2}/.test(origSlice.slice(d.fullMatch.length))
      const endPos = hasYear
        ? d.index + origSlice.match(new RegExp(`^${escapeRegex(d.fullMatch)},?\\s*20\\d{2}`))[0].length
        : d.index + d.fullMatch.length
      result = result.slice(0, d.index) +
        `${MONTHS_FULL[d.shifted.getMonth()]} ${d.shifted.getDate()}, ${d.shifted.getFullYear()}` +
        result.slice(endPos)
    }
    const yearShift = Math.round(dayDelta / 365)
    return result
      .replace(/\b(20(?:23|24|25))\b/g, (y) => (yearsFound.has(parseInt(y)) ? String(parseInt(y) + (yearShift || 1)) : y))
      .replace(/today\s*\([^)]*\)/gi, 'today')
  }

  // No year anywhere: shift bare "March 15"-style dates that already passed this year.
  const yearlessDates = []
  const yearlessRe = new RegExp(`(${ALL_MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'gi')
  while ((match = yearlessRe.exec(instruction)) !== null) {
    const day = parseInt(match[2])
    if (day > 31) continue
    yearlessDates.push({ month: match[1], day, index: match.index, fullMatch: match[0] })
  }
  const yearlessDayFirstRe = new RegExp(`(\\d{1,2})\\s+(${ALL_MONTHS})\\.?`, 'gi')
  while ((match = yearlessDayFirstRe.exec(instruction)) !== null) {
    const day = parseInt(match[1])
    if (day < 1 || day > 31) continue
    const m = match
    if (yearlessDates.some((d) => m.index >= d.index && m.index < d.index + d.fullMatch.length)) continue
    yearlessDates.push({ month: match[2], day, index: match.index, fullMatch: match[0] })
  }
  if (yearlessDates.length === 0) return instruction

  const currentYear = now.getFullYear()
  const needsShift = yearlessDates.some((d) =>
    new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`) < twoWeeksFromNow)
  if (!needsShift) return instruction

  const earliest = yearlessDates.reduce((min, d) =>
    new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`) < new Date(`${expandMonth(min.month)} ${min.day}, ${currentYear}`) ? d : min)
  const earliestDate = new Date(`${expandMonth(earliest.month)} ${earliest.day}, ${currentYear}`)
  const dayDelta = Math.round((new Date(now.getTime() + 45 * 86400000).getTime() - earliestDate.getTime()) / 86400000)
  if (dayDelta <= 0) return instruction

  const maxFuture = new Date(now.getTime() + 300 * 86400000)
  let result = instruction
  for (const d of [...yearlessDates].sort((a, b) => b.index - a.index)) {
    const shifted = new Date(new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`).getTime() + dayDelta * 86400000)
    if (shifted < twoWeeksFromNow || shifted > maxFuture) continue
    const end = d.index + d.fullMatch.length
    if (/^,?\s*20\d{2}/.test(result.slice(end, end + 10).trim())) continue
    result = result.slice(0, d.index) +
      `${MONTHS_FULL[shifted.getMonth()]} ${shifted.getDate()}, ${shifted.getFullYear()}` + result.slice(end)
  }
  return result.replace(/today\s*\([^)]*\)/gi, 'today')
}

export function adaptTimeSensitiveInstruction(instruction, now = new Date()) {
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const seasonStart = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1
  return instruction
    .replace(/\byesterday\b/gi, fmt(new Date(now.getTime() - 86400000)))
    .replace(/\btoday(?:'s date)?\b/gi, fmt(now))
    .replace(/\b2023-24\b/g, `${seasonStart}-${String(seasonStart + 1).slice(2)}`)
}

// ── Selection (port of lumen run.ts) ─────────────────────────────────────────────────

/** mulberry32 — deterministic sampling shared across frameworks. */
function seededRng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleStratified(tasks, total, seed = 42) {
  const rng = seededRng(seed)
  const shuffle = (arr) => {
    const copy = arr.slice()
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp
    }
    return copy
  }
  const bySite = new Map()
  for (const t of tasks) {
    const list = bySite.get(t.web_name) ?? []
    list.push(t)
    bySite.set(t.web_name, list)
  }
  const perSite = Math.max(1, Math.ceil(total / bySite.size))
  const result = []
  for (const site of [...bySite.keys()].sort()) result.push(...shuffle(bySite.get(site)).slice(0, perSite))
  return result.length > total ? shuffle(result).slice(0, total) : result
}

/** @returns {{web_name:string,id:string,ques:string,web:string,quesRaw:string}[]} */
export function loadTasks({ adapt = true, now = new Date() } = {}) {
  return readFileSync(DATA_PATH, 'utf-8').split('\n').filter(Boolean).map((line) => {
    const task = JSON.parse(line)
    task.quesRaw = task.ques
    if (adapt) task.ques = adaptTimeSensitiveInstruction(adaptDatesInInstruction(task.ques, now), now)
    return task
  })
}

/** The comparison set: the exact 25 tasks lumen published, in their order. */
export function lumenTasks() {
  const byId = new Map(loadTasks().map((t) => [t.id, t]))
  return LUMEN_25.map((id) => {
    const t = byId.get(id)
    if (!t) throw new Error(`task ${id} missing from dataset`)
    return t
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sampled = sampleStratified(loadTasks(), 25).map((t) => t.id)
  const same = sampled.length === LUMEN_25.length && sampled.every((id, i) => id === LUMEN_25[i])
  console.log(JSON.stringify({ sampled, lumen: LUMEN_25, sameSetAndOrder: same, sameSet: [...sampled].sort().join() === [...LUMEN_25].sort().join() }, null, 1))
  if (!same) process.exitCode = 1
}
