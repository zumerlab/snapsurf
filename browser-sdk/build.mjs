/** Build the historical portable-receipt compatibility distribution. */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const BUNDLE = join(DIST, 'snapdom-receipt.js')
const MANIFEST = join(HERE, 'dist-manifest.json')
const CHECK = process.argv.includes('--check')

const entry = `export {
  observe,
  observeChunked,
  buildUi,
  probeCapabilities,
  redactString,
} from '../src/plugin.js'
export {
  BASELINE_CONTRACT,
  RECEIPT_CONTRACT,
  createBaseline,
  createReceipt,
} from './receipt.js'
`

const forbidden = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['node: import', /\bnode:/],
  ['Playwright', /(?:@playwright|\bplaywright\b)/i],
]

const esbuild = await import('esbuild')
const built = await esbuild.build({
  stdin: {
    contents: entry,
    resolveDir: HERE,
    sourcefile: 'snapdom-receipt-entry.js',
    loader: 'js',
  },
  bundle: true,
  charset: 'utf8',
  format: 'esm',
  legalComments: 'none',
  minify: true,
  platform: 'browser',
  target: ['es2022'],
  write: false,
})

if (!built.outputFiles?.[0]) throw new Error('[browser-sdk] esbuild produced no bundle')
const bundle = Buffer.from(built.outputFiles[0].contents)
const text = bundle.toString('utf8')
const matches = forbidden
  .filter(([, pattern]) => pattern.test(text))
  .map(([label]) => label)

if (matches.length) {
  throw new Error(`[browser-sdk] forbidden runtime/egress primitives in bundle: ${matches.join(', ')}`)
}

const sha256 = createHash('sha256').update(bundle).digest('hex')
const manifest = {
  schemaVersion: 1,
  package: '@zumer/snapdom-receipt',
  artifact: 'dist/snapdom-receipt.js',
  format: 'esm',
  platform: 'browser',
  exports: [
    'BASELINE_CONTRACT',
    'RECEIPT_CONTRACT',
    'buildUi',
    'createBaseline',
    'createReceipt',
    'observe',
    'observeChunked',
    'probeCapabilities',
    'redactString',
  ],
  bytes: bundle.byteLength,
  gzipBytes: gzipSync(bundle, { level: 9 }).byteLength,
  brotliBytes: brotliCompressSync(bundle).byteLength,
  sha256,
  dependencies: [],
  staticEvidence: {
    scope: 'generated browser bundle only',
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
    [currentBundle, currentManifest] = await Promise.all([
      readFile(BUNDLE),
      readFile(MANIFEST),
    ])
  } catch (error) {
    throw new Error(`[browser-sdk] checked-in distribution is missing: ${error.message}`)
  }
  if (!bundle.equals(currentBundle) || !manifestBytes.equals(currentManifest)) {
    throw new Error('[browser-sdk] checked-in distribution is stale; run node browser-sdk/build.mjs')
  }
  process.stdout.write(`[browser-sdk] fresh ${bundle.byteLength} bytes sha256:${sha256}\n`)
} else {
  await mkdir(DIST, { recursive: true })
  await Promise.all([
    writeFile(BUNDLE, bundle),
    writeFile(MANIFEST, manifestBytes),
  ])
  process.stdout.write(`[browser-sdk] built ${bundle.byteLength} bytes sha256:${sha256}\n`)
}
