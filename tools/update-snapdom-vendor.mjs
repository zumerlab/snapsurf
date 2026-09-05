/** Refresh the pinned engine and its dependency-closed capture plugins from a clean source revision. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw new Error('usage: node tools/update-snapdom-vendor.mjs /path/to/snapdom')
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/snapdom')
const plugins = ['gif-export.js', 'video-export.js', 'capture-frames.js', 'redact-inputs.js', 'privacy-policy.js', 'redact-clone.js']
execFileSync('git', ['-C', source, 'diff', '--exit-code', 'HEAD', '--', 'src', 'package.json', 'esbuild.config.mjs', ...plugins.map(name => `packages/plugins/${name}`)])
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
const runtime = await build({
  entryPoints: [join(source, 'src/index.js')], bundle: true, format: 'esm',
  minify: true, splitting: false, sourcemap: false, write: false,
  define: { __SNAPDOM_CANVAS_ENGINE__: 'false', __SNAPDOM_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `/*\n* SnapDOM\n* v${pkg.version}\n* License: MIT\n*/` },
})
const files = { 'dist/snapdom.mjs': runtime.outputFiles[0].contents }
for (const name of plugins) {
  const original = await readFile(join(source, 'packages/plugins', name), 'utf8')
  files[`plugins/${name}`] = original.replaceAll("from '@zumer/snapdom'", "from '../dist/snapdom.mjs'")
}
const artifacts = {}
for (const [name, bytes] of Object.entries(files)) {
  await mkdir(dirname(join(target, name)), { recursive: true })
  await writeFile(join(target, name), bytes)
  artifacts[name] = createHash('sha256').update(bytes).digest('hex')
}
await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ source: 'https://github.com/zumerlab/snapdom', commit, version: pkg.version, artifacts }, null, 2)}\n`)
console.log(`Vendored SnapDOM ${pkg.version} at ${commit}; ${Object.keys(files).length} artifacts.`)
