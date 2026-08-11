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
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 */
import { join } from 'node:path'

/**
 * @param {string} REPO absolute path to the snapdom HOST repo (core sources + node_modules)
 * @param {string} [AGENT] absolute path to the agent sources root. Defaults to the legacy
 *   monorepo layout (HOST/packages/agent); pass it when the agent lives in its own repo,
 *   which is the case since the subtree split into zumerlab/snapdom-agent.
 * @returns {Promise<string>} IIFE bundle
 */
export async function buildSdk(REPO, AGENT = join(REPO, 'packages/agent')) {
  const { hostSnapdom } = await import('./host-repo.mjs')
  const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
  const contents = `import { observe, observeChunked, buildUi, agentOracle, redactString } from '${join(AGENT, 'src/plugin.js')}'
import { snapdom } from '${hostSnapdom(REPO)}'
import { videoExport } from '${join(REPO, 'packages/plugins/video-export.js')}'
import { gifExport } from '${join(REPO, 'packages/plugins/gif-export.js')}'
window.__agentObserve = observe
window.__agentObserveChunked = observeChunked
window.__agentBuildUi = buildUi
window.__agentOracle = agentOracle
window.__agentRedact = (s) => redactString(s, window.__SD_PRIVACY || null)
window.__snapdom = snapdom
window.__snapdomVideo = videoExport
window.__snapdomGif = gifExport
`
  const out = (await esbuild.build({
    stdin: { contents, resolveDir: REPO, loader: 'js' },
    bundle: true, minify: true, format: 'iife', write: false, platform: 'browser',
    // the official plugins import the published name; point it at the host's build, so
    // the whole bundle carries ONE copy of snapdom (aliasing to src would inline a second
    // one next to dist's, and the two would keep separate caches and plugin registries)
    alias: { '@zumer/snapdom': hostSnapdom(REPO) },
  })).outputFiles[0].text
  // A bundle missing one of these globals is a silent breakage: the daemon starts,
  // `open` may even work, and the verb that needs it throws in the page instead.
  for (const g of ['__agentObserveChunked', '__agentBuildUi', '__agentRedact', '__snapdom']) {
    if (!out.includes(g)) throw new Error(`[sdk-bundle] built bundle does not define window.${g}`)
  }
  return out
}
