/**
 * The oracle in its REAL environment: an MV3 content script's isolated world, page CSP
 * fully enforced (no bypassCSP anywhere). Builds sdk.js, loads the extension with a
 * persistent Chromium context, and collects the driver's console report per site.
 *
 *   node experiment/mv3/run.mjs
 */
import { chromium } from 'playwright'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { resolveHost, AGENT_ROOT: AGENT } = await import('../../tools/host-repo.mjs')
const REPO = resolveHost()
const PROFILE = join(HERE, 'profile')
const SITES = ['https://github.com/', 'https://stripe.com/', 'https://es.wikipedia.org/wiki/Buenos_Aires']

{
  const esbuild = await import('esbuild')
  const entry = join(HERE, 'sdk-entry.mjs')
  await writeFile(entry, `import { inspect } from '${join(AGENT, 'src/index.js')}'
import { probeCapabilities } from '${join(AGENT, 'src/plugin.js')}'
window.__agentInspect = inspect
window.__agentCaps = probeCapabilities
`)
  await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', platform: 'browser', outfile: join(HERE, 'sdk.js'), absWorkingDir: REPO })
}

await rm(PROFILE, { recursive: true, force: true })
await mkdir(PROFILE, { recursive: true })
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${HERE}`, `--load-extension=${HERE}`],
})

const results = []
for (const url of SITES) {
  const page = await ctx.newPage()
  const hit = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ href: url, ok: false, error: 'no report within 40s' }), 40000)
    page.on('console', (msg) => {
      const t = msg.text()
      if (t.startsWith('__MV3_ORACLE__')) { clearTimeout(timer); resolve(JSON.parse(t.slice(14))) }
    })
  })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } catch (e) {
    results.push({ href: url, ok: false, error: 'goto: ' + String(e).slice(0, 120) })
    await page.close()
    continue
  }
  results.push(await hit)
  await page.close()
}
await ctx.close()
await mkdir(join(HERE, '..', 'results'), { recursive: true })
await writeFile(join(HERE, '..', 'results', 'mv3.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 1))
