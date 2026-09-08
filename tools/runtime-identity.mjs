/** The daemon's immutable code identity, shared by npm and standalone installs. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RUNTIME_CAPABILITIES = Object.freeze([
  'runtime.identity.v1',
  'digest.absolute-hrefs.v1',
  'diff.retained-evidence.v1',
  'text.continuation.v1',
  'actions.native-select.v1',
  'session.environment.v1',
  'diff.semantic-summary.v1',
])

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// Hash source inputs instead of their paths, mtimes or a package version alone. A
// checkout can change without a version bump, and copying a package must not alter
// its identity. Standalone installs retain this source hash beside the built SDK.
export async function engineSourceHash(root) {
  const files = ['tools/sdk-bundle.mjs', 'vendor/snapdom/manifest.json', 'vendor/snapdom/dist/snapdom.mjs']
  const visit = async (relative) => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else if (/\.(?:m?js)$/.test(entry.name)) files.push(path)
    }
  }
  await visit('src')
  await visit('vendor/snapdom/plugins')
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0')
  return hash.digest('hex')
}

export async function runtimeIdentity(browseFile) {
  const directory = dirname(browseFile)
  let installed
  try { installed = JSON.parse(await readFile(join(directory, 'paths.json'), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let version, engineHash
  if (installed) {
    version = installed.version
    engineHash = installed.engineSourceHash
    const sdkHash = sha256(await readFile(join(directory, 'sdk.js')))
    if (!/^[a-f0-9]{64}$/.test(engineHash || '') || installed.sdkHash !== sdkHash) {
      throw new Error('standalone runtime identity is missing or its SDK changed — run tools/install-global.mjs again')
    }
  } else {
    const root = join(directory, '..')
    version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
    engineHash = await engineSourceHash(root)
  }
  if (typeof version !== 'string' || !version) throw new Error('runtime package version is missing')
  const hash = createHash('sha256')
  hash.update(version).update('\0').update(engineHash).update('\0')
  hash.update(await readFile(browseFile)).update('\0')
  hash.update(await readFile(fileURLToPath(import.meta.url)))
  return Object.freeze({ protocolVersion: 1, version, build: hash.digest('hex'), capabilities: RUNTIME_CAPABILITIES })
}

export function runtimeMismatch(expected, actual) {
  if (!actual || typeof actual !== 'object') return 'the running daemon does not report a runtime identity (pre-upgrade daemon)'
  if (actual.protocolVersion !== expected.protocolVersion) return `runtime protocol ${actual.protocolVersion ?? 'unknown'} differs from ${expected.protocolVersion}`
  if (actual.version !== expected.version) return `daemon version ${actual.version || 'unknown'} differs from client version ${expected.version}`
  const missing = expected.capabilities.filter((capability) => !Array.isArray(actual.capabilities) || !actual.capabilities.includes(capability))
  if (missing.length) return `daemon lacks required capabilities: ${missing.join(', ')}`
  if (actual.build !== expected.build) return `daemon build ${String(actual.build || 'unknown').slice(0, 12)} differs from client build ${expected.build.slice(0, 12)}`
  return null
}
