// Bundles content.src.js (+ the oracle) into content.bundle.js. Re-run after changes,
// and RELOAD the unpacked extension in chrome://extensions — a stale bundle answering a
// new protocol has burned several review rounds.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveHost } from '../tools/host-repo.mjs'
const HERE = dirname(fileURLToPath(import.meta.url))
// esbuild comes from the host checkout: this repo has no dependencies of its own.
const esbuild = await import(join(resolveHost(), 'node_modules/esbuild/lib/main.js'))
await esbuild.build({
  entryPoints: [join(HERE, 'content.src.js')],
  outfile: join(HERE, 'content.bundle.js'),
  bundle: true, minify: true, format: 'iife', platform: 'browser',
})
console.log('companion bundleada → content.bundle.js')
