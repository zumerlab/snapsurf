/**
 * Runs a pinned local dev tool (vitest, eslint) — the `npm test` path. A clean clone uses
 * this package's lockfile and node_modules; no sibling checkout is consulted.
 *
 *   node tools/run-bin.mjs vitest run              # npm test
 *   node tools/run-bin.mjs vitest run test/api.test.js
 *   node tools/run-bin.mjs eslint src test         # npm run test:lint
 */
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const AGENT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const BINS = {
  vitest: ['vitest', 'vitest.mjs'],
  eslint: ['eslint', 'bin', 'eslint.js'],
}

const [name, ...args] = process.argv.slice(2)
if (!BINS[name]) {
  console.error(`usage: node tools/run-bin.mjs <${Object.keys(BINS).join('|')}> [args…]`)
  process.exit(2)
}

const LINK = join(AGENT_ROOT, 'node_modules')

const child = spawn(process.execPath, [join(LINK, ...BINS[name]), ...args], {
  cwd: AGENT_ROOT,
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
