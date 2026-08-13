/**
 * The in-page SDK bundle (oracle + snapdom + export plugins), defined ONCE.
 *
 * Two consumers build it: the daemon in dev mode (from the repo tree) and
 * install-global (the prebuilt copy in ~/.claude/snapdom-agent). Each used to carry
 * its own copy of the entry source, and they drifted: the installer's copy never
 * exported `redactString`, so `window.__agentRedact` was undefined on every global
 * install and `find` / `text` / `assert` threw `is not a function` at the first
 * candidate. One definition means that class of bug cannot come back.
 *
 * Private development package; see the repository LICENSE.
 */
import { join } from 'node:path'

/**
 * @param {string} AGENT absolute path to this package's root
 * @returns {Promise<string>} IIFE bundle
 */
export async function buildSdk(AGENT) {
  const esbuild = await import('esbuild')
  const snapdomRuntime = join(AGENT, 'vendor', 'snapdom', 'dist', 'snapdom.mjs')
  const contents = `import { observe, observeChunked, buildUi, agentOracle, redactString } from '${join(AGENT, 'src/plugin.js')}'
import { snapdom } from '${snapdomRuntime}'
import { videoExport } from '${join(AGENT, 'vendor/snapdom/plugins/video-export.js')}'
import { gifExport } from '${join(AGENT, 'vendor/snapdom/plugins/gif-export.js')}'
window.__agentObserve = observe
window.__agentObserveChunked = observeChunked
window.__agentBuildUi = buildUi
window.__agentOracle = agentOracle
window.__agentRedact = (s) => redactString(s, window.__SD_PRIVACY || null)
window.__agentRedactUrl = (s) => {
  const raw = String(s || '')
  let decoded = raw
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch { break }
  }
  if (redactString(decoded, window.__SD_PRIVACY || null) !== decoded) return '[redacted]'
  return redactString(raw, window.__SD_PRIVACY || null)
}
window.__snapdom = snapdom
window.__snapdomVideo = videoExport
window.__snapdomGif = gifExport
`
  const out = (await esbuild.build({
    stdin: { contents, resolveDir: AGENT, loader: 'js' },
    bundle: true, minify: true, format: 'iife', write: false, platform: 'browser',
    // The official plugins import the published name; point it at the vendored build, so
    // the whole bundle carries ONE copy of snapdom (aliasing to src would inline a second
    // one next to dist's, and the two would keep separate caches and plugin registries)
    alias: { '@zumer/snapdom': snapdomRuntime },
  })).outputFiles[0].text
  // A bundle missing one of these globals is a silent breakage: the daemon starts,
  // `open` may even work, and the verb that needs it throws in the page instead.
  for (const g of ['__agentObserveChunked', '__agentBuildUi', '__agentRedact', '__agentRedactUrl', '__snapdom']) {
    if (!out.includes(g)) throw new Error(`[sdk-bundle] built bundle does not define window.${g}`)
  }
  return out
}
