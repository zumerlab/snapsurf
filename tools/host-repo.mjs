/**
 * Where the snapdom HOST repo lives, resolved in ONE place.
 *
 * Since the subtree split (github.com/zumerlab/snapdom-agent) this repo carries only the
 * oracle: snapdom's own sources and the toolchain (esbuild, playwright, vitest) come from
 * a sibling checkout, because `@zumer/snapdom@^3.0.0` is a peer that is never published
 * from here. Three consumers need that path — the SDK bundle, the installer and the test
 * runner — and three copies of the search order is how they drift apart.
 *
 * Order: $SNAPDOM_REPO, then ../snapdom-v3 (the 3.x line this peer-depends on), then
 * ../snapdom (2.x, buildable but not what the oracle was developed against).
 *
 * NOT FOR PUBLICATION — private repo.
 */
import { join, resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  const ok = (c) => existsSync(join(c, 'src', 'api', 'snapdom.js')) &&
    (!needsNodeModules || existsSync(join(c, 'node_modules', 'esbuild')))
  const found = candidates.find(ok)
  if (!found) {
    throw new Error(`no snapdom host repo found (needs src/api/snapdom.js${needsNodeModules ? ' + node_modules' : ''}). Tried:\n  ${candidates.join('\n  ')}\nSet SNAPDOM_REPO=/path/to/snapdom to point at one.`)
  }
  return found
}
