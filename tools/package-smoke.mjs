/** Verify the distributable archive, not only the repository tree. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP = mkdtempSync(join(tmpdir(), 'snapsurf-pack-'))

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
    if (unpacked.name !== '@zumer/snapsurf' || unpacked.private || unpacked.license !== 'MIT' || unpacked.publishConfig?.access !== 'public') {
      throw new Error('release metadata must describe the public MIT SnapSurf package')
    }
    // The official MCP Registry verifies the npm package against server.json: the
    // package must carry mcpName and both manifests must name the same version.
    if (unpacked.mcpName !== 'io.github.zumerlab/snapsurf') {
      throw new Error('package.json must declare mcpName io.github.zumerlab/snapsurf for the MCP Registry')
    }
    const registry = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'))
    if (registry.name !== unpacked.mcpName || registry.version !== unpacked.version || registry.packages?.[0]?.identifier !== unpacked.name || registry.packages?.[0]?.version !== unpacked.version) {
      throw new Error(`server.json must name ${unpacked.mcpName} ${unpacked.version} (npm ${unpacked.name}@${unpacked.version})`)
    }
    const documents = ['README.md', 'CHANGELOG.md', 'docs/USAGE.md', 'docs/INTEGRATIONS.md', 'docs/PRIVACY.md', 'docs/RELEASING.md']
    const required = [
      unpacked.main,
      unpacked.bin?.['snapsurf'],
      unpacked.bin?.['snapsurf-mcp'],
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
      'LICENSE', 'vendor/snapdom/LICENSE', 'vendor/snapdom/manifest.json',
      ...documents,
    ].filter(Boolean)
    for (const relative of required) readFileSync(join(unpackedRoot, relative))
    for (const file of info.files) {
      if (/^(logs|scratchpad|test|experiment|packages|browser-sdk)\//.test(file.path) || /(?:^|\/)\.env(?:\.|$)|\.(?:token|pem|key)$/.test(file.path)) {
        throw new Error(`unexpected development/private artifact in npm archive: ${file.path}`)
      }
    }
    // A reader of the installed README must be able to open its local documentation.
    // Links to repository-only evidence use full GitHub URLs instead.
    for (const relative of documents) {
      const document = readFileSync(join(unpackedRoot, relative), 'utf8')
      for (const match of document.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1]
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue
        const path = resolve(dirname(join(unpackedRoot, relative)), decodeURIComponent(target.split(/[?#]/)[0]))
        if (!path.startsWith(unpackedRoot + sep)) throw new Error(`${relative}: documentation link leaves the package: ${target}`)
        try { statSync(path) } catch { throw new Error(`${relative}: documentation link missing from archive: ${target}`) }
      }
    }

    // Install the tarball with production dependencies only. This catches the common
    // failure where a shipped CLI imports a package left in devDependencies.
    const installDir = join(TEMP, 'install')
    mkdirSync(installDir)
    execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], {
      cwd: installDir,
      stdio: 'inherit',
    })
    const pkgRoot = join(installDir, 'node_modules', '@zumer', 'snapsurf')
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
    execFileSync(process.execPath, ['--check', join(pkgRoot, pkg.bin['snapsurf'])], { stdio: 'inherit' })
    execFileSync(process.execPath, ['--check', join(pkgRoot, pkg.bin['snapsurf-mcp'])], { stdio: 'inherit' })

    // Exercise the global installer from the production-only, npm-hoisted layout and
    // start the resulting daemon on an OS-assigned port. Running the repository copy
    // cannot catch a missing packed installer or a nested-node_modules assumption.
    execFileSync(process.execPath, ['--test', join(ROOT, 'test', 'global-install-smoke.test.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        SNAPSURF_INSTALLER: join(pkgRoot, 'tools', 'install-global.mjs'),
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
