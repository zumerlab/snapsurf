/**
 * Compatibility resolver used by the historical experiment harnesses.
 *
 * Production and tests are self-contained: the pinned snapDOM runtime lives under
 * vendor/snapdom and the toolchain lives in this package's node_modules. An explicit
 * SNAPDOM_REPO can still point experiments at another built checkout, but there is no
 * implicit sibling-directory search.
 */
import { join, resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const hostSnapdom = (host = AGENT_ROOT) => {
  const vendored = join(host, 'vendor', 'snapdom', 'dist', 'snapdom.mjs')
  return existsSync(vendored) ? vendored : join(host, 'dist', 'snapdom.mjs')
}

/**
 * @param {{ needsNodeModules?: boolean }} [opts]
 * @returns {string} root that contains the selected runtime and toolchain
 */
export function resolveHost({ needsNodeModules = true } = {}) {
  const explicit = process.env.SNAPDOM_REPO && resolve(process.env.SNAPDOM_REPO)
  const candidates = [explicit, AGENT_ROOT].filter(Boolean)
  const found = candidates.find((candidate) =>
    existsSync(hostSnapdom(candidate)) &&
    (!needsNodeModules || existsSync(join(candidate, 'node_modules', 'esbuild'))))
  if (found) return found
  throw new Error(`no usable snapDOM runtime found. Tried:\n  ${candidates.join('\n  ')}\nRun npm ci in ${AGENT_ROOT}, or set SNAPDOM_REPO to an explicit built checkout.`)
}
