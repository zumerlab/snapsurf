/** Verify the distributable archive, not only the repository tree. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP = mkdtempSync(join(tmpdir(), 'snapdom-agent-pack-'))

try {
  const info = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  }))[0]
  const archive = join(ROOT, info.filename)
  try {
    execFileSync('tar', ['-xzf', archive, '-C', TEMP])
    const unpackedRoot = join(TEMP, 'package')
    const unpacked = JSON.parse(readFileSync(join(unpackedRoot, 'package.json'), 'utf8'))
    const required = [
      unpacked.main,
      unpacked.bin?.['snapdom-agent'],
      unpacked.bin?.['snapdom-agent-mcp'],
      'tools/install-global.mjs',
      'tools/sdk-bundle.mjs',
      'tools/daemon-client.mjs',
      'companion/build.mjs',
      'companion/content.src.js',
      'companion/gate.mjs',
      'companion/gate-client/manifest.json',
      'companion/gate-client/worker.js',
      'companion/manifest.json',
      'companion/worker.js',
      'companion/content.bundle.js',
      'companion/PROMPT-extension.md',
    ].filter(Boolean)
    for (const relative of required) readFileSync(join(unpackedRoot, relative))

    // Install the tarball with production dependencies only. This catches the common
    // failure where a shipped CLI imports a package left in devDependencies.
    const installDir = join(TEMP, 'install')
    mkdirSync(installDir)
    execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], {
      cwd: installDir,
      stdio: 'inherit',
    })
    const pkgRoot = join(installDir, 'node_modules', '@zumer', 'snapdom-agent')
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    const api = await import(pathToFileURL(join(pkgRoot, pkg.main)))
    if (typeof api.agent?.inspect !== 'function') throw new Error('packed library does not export agent.inspect')
    const { buildSdk } = await import(pathToFileURL(join(pkgRoot, 'tools', 'sdk-bundle.mjs')))
    const sdk = await buildSdk(pkgRoot)
    if (!sdk.includes('__agentObserveChunked')) throw new Error('packed runtime cannot build its in-page SDK')
    execFileSync(process.execPath, [join(pkgRoot, 'companion', 'build.mjs'), '--check'], {
      cwd: pkgRoot,
      stdio: 'inherit',
    })
    execFileSync(process.execPath, ['--check', join(pkgRoot, pkg.bin['snapdom-agent'])], { stdio: 'inherit' })
    execFileSync(process.execPath, ['--check', join(pkgRoot, pkg.bin['snapdom-agent-mcp'])], { stdio: 'inherit' })

    // Exercise the global installer from the production-only, npm-hoisted layout and
    // start the resulting daemon on an OS-assigned port. Running the repository copy
    // cannot catch a missing packed installer or a nested-node_modules assumption.
    execFileSync(process.execPath, ['--test', join(ROOT, 'test', 'global-install-smoke.test.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        SNAPDOM_AGENT_INSTALLER: join(pkgRoot, 'tools', 'install-global.mjs'),
      },
      stdio: 'inherit',
    })
  } finally {
    rmSync(archive, { force: true })
  }
  console.log(`package smoke PASS (${info.entryCount} files, ${info.size} bytes)`)
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}
