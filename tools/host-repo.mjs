/**
 * Where the snapdom HOST repo lives, resolved in ONE place.
 *
 * Since the subtree split (github.com/zumerlab/snapdom-agent) this repo carries only the
 * oracle: snapdom itself and the toolchain (esbuild, playwright, vitest) come from a
 * sibling checkout, because `@zumer/snapdom@^3.0.0` is a peer that is never published
 * from here. Several consumers need that path (the SDK bundle, the installer, the test
 * runner, every experiment), and copies of the search order are how they drift apart.
 *
 * Order: $SNAPDOM_REPO, then ../snapdom-v3 (the 3.x line this peer-depends on), then
 * ../snapdom (2.x, buildable but not what the oracle was developed against).
 *
 * We consume the host's BUILT bundle (`dist/snapdom.mjs`), not its src tree: that is the
 * artifact users get, so the oracle is measured against the same code they run. Rebuild
 * the host (`npm run compile` there) after touching its sources, or this keeps testing
 * the previous build.
 *
 * NOT FOR PUBLICATION — private repo.
 */
import { join, resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The host's built ESM bundle: what every consumer here imports as `@zumer/snapdom`. */
export const hostSnapdom = (host) => join(host, 'dist', 'snapdom.mjs')

/**
 * @param {{ needsNodeModules?: boolean }} [opts] also require node_modules (bundling/running)
 * @returns {string} absolute path to the host repo
 * @throws if no candidate qualifies — silence here surfaces as a broken install later
 */
export function resolveHost({ needsNodeModules = true } = {}) {
  const candidates = [
    process.env.SNAPDOM_REPO && resolve(process.env.SNAPDOM_REPO),
    join(AGENT_ROOT, '..', 'snapdom-v3'),
    join(AGENT_ROOT, '..', 'snapdom'),
  ].filter(Boolean)
  const ok = (c) => existsSync(hostSnapdom(c)) &&
    (!needsNodeModules || existsSync(join(c, 'node_modules', 'esbuild')))
  const found = candidates.find(ok)
  if (!found) {
    // A checkout with sources but no dist is the likely case, so name that cure too.
    const unbuilt = candidates.filter((c) => existsSync(join(c, 'src', 'api', 'snapdom.js')) && !existsSync(hostSnapdom(c)))
    throw new Error(`no snapdom host repo found (needs dist/snapdom.mjs${needsNodeModules ? ' + node_modules' : ''}). Tried:\n  ${candidates.join('\n  ')}` +
      (unbuilt.length ? `\nThese are checkouts with no build yet, run \`npm run compile\` there:\n  ${unbuilt.join('\n  ')}` : '') +
      '\nSet SNAPDOM_REPO=/path/to/snapdom to point at one.')
  }
  return found
}
