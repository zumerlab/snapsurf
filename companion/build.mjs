// Bundlea content.src.js (+ oráculo) a content.bundle.js. Re-correr tras cambios.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
await esbuild.build({
  entryPoints: [join(HERE, 'content.src.js')],
  outfile: join(HERE, 'content.bundle.js'),
  bundle: true, minify: true, format: 'iife', platform: 'browser',
})
console.log('companion bundleada → content.bundle.js')
