// Formal benchmark — external judges, one per task id in TASKS.md.
// Anti-circularity: judges never touch any arm under test (no oracle, no browser
// extension, no Codex tooling) — plain fetch + constants only.

const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const bigNumber = (s) => {
  const m = (s || '').replace(/[.,\s]/g, ' ').replace(/(\d) (?=\d)/g, '$1').match(/\d{3,}/)
  return m ? parseInt(m[0], 10) : NaN
}

const pass = (detail, expected = '') => ({ verdict: 'pass', expected, detail })
const fail = (detail, expected = '') => ({ verdict: 'fail', expected, detail })

async function getJson (url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

async function getText (url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.text()
}

export const tasks = {

  'hn-top': async (e) => {
    const ids = (await getJson('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 10)
    const titles = (await Promise.all(
      ids.map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
    )).map((it) => it.title)
    const reported = norm((e.answer || '').split('|')[0])
    if (!reported) return fail('empty answer', 'a title in the live top 10')
    const hit = titles.find((t) => {
      const nt = norm(t)
      return nt === reported || nt.includes(reported) || reported.includes(nt)
    })
    return hit
      ? pass(`matches live top-10 story: "${hit}"`)
      : fail(`"${reported}" not in live top-10`, titles.join(' · '))
  },

  'gh-version': async (e) => {
    const pkg = await getJson('https://raw.githubusercontent.com/zumerlab/snapdom/main/package.json')
    return (e.answer || '').includes(pkg.version)
      ? pass(`version ${pkg.version} confirmed against raw.githubusercontent`)
      : fail(`answer "${e.answer}" does not contain live version`, pkg.version)
  },

  'wiki-deeplink': async (e) => {
    const url = e.finalUrl || e.answer || ''
    return /\/wiki\/Mar_del_Plata/.test(decodeSafe(url))
      ? pass('landed on /wiki/Mar_del_Plata')
      : fail(`finalUrl "${url}"`, '…/wiki/Mar_del_Plata')
  },

  'npm-downloads': async (e) => {
    const live = (await getJson('https://api.npmjs.org/downloads/point/last-week/preact')).downloads
    const reported = bigNumber(e.answer)
    if (Number.isNaN(reported)) return fail(`no number in answer "${e.answer}"`, String(live))
    const ratio = reported / live
    return ratio > 0.75 && ratio < 1.25
      ? pass(`${reported} within ±25% of live API value ${live}`)
      : fail(`${reported} vs live ${live} (ratio ${ratio.toFixed(2)})`, `${live} ±25%`)
  },

  'ebay-first': async (e) => {
    const url = e.finalUrl || ''
    return /\/itm\/\d+/.test(url)
      ? pass(`landed on a listing: ${url.match(/\/itm\/\d+/)[0]}`)
      : fail(`finalUrl "${url}" is not an /itm/ listing`, '…/itm/<digits>')
  },

  'pydocs-lru': async (e) => {
    const onPage = /\/library\/functools/.test(e.finalUrl || '')
    const has128 = /\b128\b/.test(e.answer || '')
    if (onPage && has128) return pass('functools page + maxsize default 128')
    return fail(`finalUrl "${e.finalUrl}" (functools: ${onPage}) · answer "${e.answer}" (128: ${has128})`,
      'finalUrl …/library/functools + answer containing 128')
  },

  'wiki-partido': async (e) => {
    return norm(e.answer).includes('general pueyrredon')
      ? pass('partido General Pueyrredón')
      : fail(`answer "${e.answer}"`, 'General Pueyrredón')
  },

  'demoqa-add': async (e) => {
    const items = (e.answer || '').split(/[,\n]/).map(norm).filter(Boolean)
    const expected = ['bread', 'buy milk']
    const ok = items.length === expected.length && expected.every((x, i) => items[i] === x)
    return ok
      ? pass('list is exactly [Bread, Buy milk] in DOM order')
      : fail(`reported [${items.join(', ')}]`, expected.join(', '))
  },

  'demoqa-noop': async (e) => {
    const a = norm(e.answer)
    if (a.startsWith('no-change') || a === 'no change') return pass('correctly reported no semantic change')
    return fail(`answer "${e.answer}" — the Refresh click is a no-op; reporting a change is a false green`,
      'no-change')
  },

  'wiki-search': async (e) => {
    const url = decodeSafe(e.finalUrl || e.answer || '')
    return /\/wiki\/Obelisco/i.test(url)
      ? pass('landed on the Obelisco article')
      : fail(`finalUrl "${url}"`, '…/wiki/Obelisco_de_Buenos_Aires')
  },
}

function decodeSafe (u) {
  try { return decodeURIComponent(u) } catch { return u }
}
