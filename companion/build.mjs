// Bundles content.src.js (+ the oracle) into content.bundle.js. Re-run after changes,
// and RELOAD the unpacked extension in chrome://extensions — a stale bundle answering a
// new protocol has burned several review rounds.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
const HERE = dirname(fileURLToPath(import.meta.url))
const esbuild = await import('esbuild')
const options = {
  entryPoints: [join(HERE, 'content.src.js')],
  bundle: true, minify: true, format: 'iife', platform: 'browser',
}

if (process.argv.includes('--check')) {
  const built = await esbuild.build({ ...options, write: false })
  const current = await readFile(join(HERE, 'content.bundle.js'))
  if (!built.outputFiles?.[0] || !Buffer.from(built.outputFiles[0].contents).equals(current)) {
    console.error('companion/content.bundle.js is stale; run node companion/build.mjs')
    process.exit(1)
  }
  console.log('companion bundle is fresh')
} else {
  await esbuild.build({ ...options, outfile: join(HERE, 'content.bundle.js') })
  console.log('companion bundled → content.bundle.js')
}
