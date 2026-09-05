/** Build the standard SnapDOM sensor plugin. */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'src', 'index.js')
const DIST = join(HERE, 'dist')
const BUNDLE = join(DIST, 'snapdom-sensor.js')
const MANIFEST = join(HERE, 'dist-manifest.json')
const CHECK = process.argv.includes('--check')

const forbidden = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['node: import', /['"`]node:[^'"`]+['"`]/],
  ['Playwright', /(?:@playwright|\bplaywright\b)/i],
]

const esbuild = await import('esbuild')
const built = await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  charset: 'utf8',
  format: 'esm',
  legalComments: 'none',
  minify: true,
  platform: 'browser',
  target: ['es2022'],
  treeShaking: true,
  metafile: true,
  write: false,
})

if (!built.outputFiles?.[0]) throw new Error('[sensor] esbuild produced no bundle')
const bundle = Buffer.from(built.outputFiles[0].contents)
const text = bundle.toString('utf8')
const matches = forbidden
  .filter(([, pattern]) => pattern.test(text))
  .map(([label]) => label)

if (matches.length) {
  throw new Error(`[sensor] forbidden runtime/egress primitives in bundle: ${matches.join(', ')}`)
}

const externalImports = Object.values(built.metafile.outputs)
  .flatMap((output) => output.imports || [])
  .filter((entry) => entry.external)
  .map((entry) => entry.path)
if (externalImports.length) {
  throw new Error(`[sensor] unexpected external imports: ${externalImports.join(', ')}`)
}

const sha256 = createHash('sha256').update(bundle).digest('hex')
const manifest = {
  schemaVersion: 1,
  package: '@zumer/snapdom-sensor',
  artifact: 'dist/snapdom-sensor.js',
  format: 'esm',
  platform: 'browser',
  exports: ['SENSOR_PLUGIN_NAME', 'SENSOR_REPORT_CONTRACT', 'sensor'],
  bytes: bundle.byteLength,
  gzipBytes: gzipSync(bundle, { level: 9 }).byteLength,
  brotliBytes: brotliCompressSync(bundle).byteLength,
  sha256,
  peerDependencies: { '@zumer/snapdom': '>=3.0.0-beta.0 <4' },
  externalImports,
  buildInputs: {
    semanticKernel: '../../src/',
    interpretation: 'The browser artifact bundles the semantic projection used by the plugin. It uses SnapDOM standard capture and export hooks, observing the prepared clone frame. The host supplies the @zumer/snapdom peer; Playwright, MCP and a browser controller are not imported.',
  },
  staticEvidence: {
    scope: 'generated sensor bundle only',
    checkedPatterns: forbidden.map(([label]) => label),
    matches: [],
    interpretation: 'No references to the enumerated egress primitives or Node/Playwright imports were found. This is not an exhaustive network-capability audit and does not constrain the host page.',
  },
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)

if (CHECK) {
  let currentBundle
  let currentManifest
  try {
    ;[currentBundle, currentManifest] = await Promise.all([
      readFile(BUNDLE),
      readFile(MANIFEST),
    ])
  } catch (error) {
    throw new Error(`[sensor] checked-in distribution is missing: ${error.message}`)
  }
  if (!bundle.equals(currentBundle) || !manifestBytes.equals(currentManifest)) {
    throw new Error('[sensor] checked-in distribution is stale; run node packages/sensor/build.mjs')
  }
  process.stdout.write(`[sensor] fresh ${bundle.byteLength} bytes sha256:${sha256}\n`)
} else {
  await mkdir(DIST, { recursive: true })
  await Promise.all([
    writeFile(BUNDLE, bundle),
    writeFile(MANIFEST, manifestBytes),
  ])
  process.stdout.write(`[sensor] built ${bundle.byteLength} bytes sha256:${sha256}\n`)
}
