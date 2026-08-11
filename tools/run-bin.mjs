/**
 * Runs a dev tool (vitest, eslint) with the HOST repo's toolchain — the `npm test` path.
 *
 * This repo deliberately has no dependencies of its own: the oracle is a plugin layer on
 * snapdom, and the versions that matter (vitest, @vitest/browser and playwright must
 * match each other) are the ones the host checkout already pins. So node_modules here is
 * a symlink to the host's, created on demand — the same pattern snapdom-v3 already uses
 * to share snapdom's tree on this machine.
 *
 * A symlink rather than borrowing the host's binary in place, because vitest's BROWSER
 * mode resolves its client (`vitest/internal/browser`) from the PROJECT root: with no
 * node_modules next to the tests, every test file dies inside the tester with a resolve
 * error, long after the run looks like it started.
 *
 *   node tools/run-bin.mjs vitest run              # npm test
 *   node tools/run-bin.mjs vitest run test/api.test.js
 *   node tools/run-bin.mjs eslint src test         # npm run test:lint
 *   SNAPDOM_REPO=../snapdom node tools/run-bin.mjs vitest run   # against the 2.x line
 *
 * NOT FOR PUBLICATION — private repo.
 */
import { join } from 'node:path'
import { existsSync, symlinkSync, lstatSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveHost, AGENT_ROOT } from './host-repo.mjs'

const BINS = {
  vitest: ['vitest', 'vitest.mjs'],
  eslint: ['eslint', 'bin', 'eslint.js'],
}

const [name, ...args] = process.argv.slice(2)
if (!BINS[name]) {
  console.error(`usage: node tools/run-bin.mjs <${Object.keys(BINS).join('|')}> [args…]`)
  process.exit(2)
}

const HOST = resolveHost()
const LINK = join(AGENT_ROOT, 'node_modules')
if (!existsSync(LINK)) {
  symlinkSync(join(HOST, 'node_modules'), LINK, 'dir')
  console.log(`linked node_modules → ${join(HOST, 'node_modules')}`)
} else if (!lstatSync(LINK).isSymbolicLink()) {
  // A real node_modules here means someone installed deps: respect it, but say so — a
  // vitest/playwright mismatch against the host tree fails in confusing ways. (It also
  // happens by accident: an aborted `npm install`, or vite writing its cache.)
  console.warn(`note: ${LINK} is a real directory, not a link to ${HOST} — versions may diverge`)
}

const child = spawn(process.execPath, [join(LINK, ...BINS[name]), ...args], {
  cwd: AGENT_ROOT,
  stdio: 'inherit',
  env: { ...process.env, SNAPDOM_REPO: HOST },
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
