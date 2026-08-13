/**
 * Proves the repository is self-contained: copy only tracked files, install from the
 * lockfile, install Chromium into an empty task-owned cache, then run tests, lint,
 * bundle drift and package-artifact gates. No sibling checkout, global install or
 * developer node_modules/browser cache may participate.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP = mkdtempSync(join(tmpdir(), 'snapdom-agent-cold-'))
const BROWSERS = mkdtempSync(join(tmpdir(), 'snapdom-agent-browsers-'))
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS }

try {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: ROOT })
    .toString('utf8').split('\0').filter(Boolean)
  const archive = execFileSync('tar', ['-cf', '-', ...tracked], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
  const tarFile = join(TEMP, 'repo.tar')
  writeFileSync(tarFile, archive)
  execFileSync('tar', ['-xf', tarFile, '-C', TEMP])
  rmSync(tarFile)
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: TEMP, stdio: 'inherit', env })
  // A cold proof must not borrow a developer's global Playwright cache. Install into
  // an empty, task-owned path and propagate it through every browser-backed check.
  execFileSync(process.execPath, [join(TEMP, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { cwd: TEMP, stdio: 'inherit', env })
  execFileSync('npm', ['test'], { cwd: TEMP, stdio: 'inherit', env })
  execFileSync('npm', ['run', 'test:lint'], { cwd: TEMP, stdio: 'inherit', env })
  execFileSync('npm', ['run', 'test:bundles'], { cwd: TEMP, stdio: 'inherit', env })
  execFileSync('npm', ['run', 'test:pack'], { cwd: TEMP, stdio: 'inherit', env })
  execFileSync('npm', ['run', 'test:install'], { cwd: TEMP, stdio: 'inherit', env })
  // A generated bundle is expected to be byte-for-byte reproducible.
  const built = readFileSync(join(TEMP, 'companion', 'content.bundle.js'))
  if (!built.length) throw new Error('cold build produced an empty companion bundle')
  console.log(`cold install PASS (${TEMP})`)
} finally {
  rmSync(TEMP, { recursive: true, force: true })
  rmSync(BROWSERS, { recursive: true, force: true })
}
