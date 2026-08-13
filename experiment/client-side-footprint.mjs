/**
 * Reproducible footprint inventory for the client-side product hypothesis.
 *
 * This does not launch a browser or use the network. It deliberately separates:
 *   1. the semantic observer that can be embedded in an existing extension/webview,
 *   2. the ready-to-load companion extension runtime,
 *   3. the optional visual SDK, and
 *   4. the current all-in-one development package (which still includes Playwright).
 */
import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import { buildSdk } from '../tools/sdk-bundle.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const outputArg = process.argv.indexOf('--output')
const OUTPUT = outputArg >= 0
  ? resolve(process.cwd(), process.argv[outputArg + 1])
  : join(ROOT, 'experiment', 'results', 'client-side-footprint.json')

const compressed = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
})

const bundle = async (entry) => {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    metafile: true,
  })
  const bytes = Buffer.from(result.outputFiles[0].contents)
  const inputs = Object.keys(result.metafile.inputs).sort()
  return {
    ...compressed(bytes),
    inputCount: inputs.length,
    inputs,
    selfContainedBrowserCode: inputs.every((path) => !path.includes('node_modules/') && !path.startsWith('vendor/')),
  }
}

const treeSize = async (path) => {
  let bytes = 0
  let files = 0
  const walk = async (current) => {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    await Promise.all(entries.map(async (entry) => {
      const target = join(current, entry.name)
      if (entry.isDirectory()) return walk(target)
      const info = await stat(target).catch(() => null)
      if (info) { bytes += info.size; files++ }
    }))
  }
  await walk(path)
  return { bytes, files }
}

const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(ROOT, 'companion', 'manifest.json'), 'utf8'))
const companionFiles = await Promise.all([
  'content.bundle.js', 'worker.js', 'manifest.json',
].map((name) => readFile(join(ROOT, 'companion', name))))
const visualSdk = Buffer.from(await buildSdk(ROOT))
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
}))[0]

const playwrightPackages = {}
for (const name of ['playwright', 'playwright-core']) {
  playwrightPackages[name] = await treeSize(join(ROOT, 'node_modules', name))
}

const browserCache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
const cachedChromium = []
for (const entry of await readdir(browserCache, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory() || !/^chromium(?:_headless_shell)?-/.test(entry.name)) continue
  cachedChromium.push({ name: basename(entry.name), ...await treeSize(join(browserCache, entry.name)) })
}

const result = {
  schema: 1,
  productQuestion: 'Can SnapDOM be shipped as a lightweight client-side perception and verification layer without shipping Playwright?',
  surfaces: {
    semanticObserver: {
      entry: 'src/plugin.js',
      runtime: 'browser JavaScript embedded by the host application, extension, or webview',
      requiresNodeAtRuntime: false,
      requiresBrowserDownload: false,
      requiresCdpOrDebugger: false,
      bytes: await bundle('src/plugin.js'),
    },
    companionExtension: {
      files: ['companion/content.bundle.js', 'companion/worker.js', 'companion/manifest.json'],
      runtime: 'MV3 extension worker plus isolated content script in an existing Chromium tab',
      requiresNodeAtRuntime: false,
      requiresBrowserDownload: false,
      requiresCdpOrDebugger: false,
      bytes: compressed(Buffer.concat(companionFiles)),
      permissions: manifest.permissions || [],
      matches: manifest.content_scripts?.flatMap((entry) => entry.matches || []) || [],
      contentScriptWorlds: manifest.content_scripts?.map((entry) => entry.world || 'ISOLATED') || [],
      externallyConnectableIds: manifest.externally_connectable?.ids?.length || 0,
    },
    visualSdk: {
      runtime: 'browser JavaScript with semantic observer plus vendored snapDOM raster export',
      requiresNodeAtRuntime: false,
      requiresBrowserDownload: false,
      requiresCdpOrDebugger: false,
      bytes: compressed(visualSdk),
    },
    currentDevelopmentPackage: {
      runtime: 'all-in-one Node package for library, CLI, daemon, MCP, and companion workflows',
      package: `${pack.name}@${pack.version}`,
      tarballBytes: pack.size,
      unpackedBytes: pack.unpackedSize,
      fileCount: pack.files.length,
      dependencies: packageJson.dependencies,
      requiresNodeAtRuntimeForDaemonOrMcp: true,
      requiresPlaywrightBrowserForDaemonOrMcp: true,
    },
  },
  localReferenceOnly: {
    caveat: 'Machine-local installed footprints are context, not a portable benchmark or product requirement.',
    playwrightPackages,
    cachedChromium,
  },
  interpretationGuardrails: [
    'Compare the semantic observer or companion runtime with a browser-control stack only when the buyer already has a browser session and needs an embedded observer.',
    'Do not describe the current all-in-one npm package as Playwright-free; its daemon and MCP modes intentionally depend on Playwright.',
    'The companion avoids debugger/CDP, but its current <all_urls> content-script match and tabs permission still create extension trust friction.',
    'Footprint alone is not commercial value; adoption also requires a measurable workflow improvement.',
  ],
}

await writeFile(OUTPUT, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
