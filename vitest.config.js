// Vitest config for the STANDALONE agent repo (post subtree split).
//
// The suite runs in a real browser because the oracle measures layout. The exact
// snapDOM runtime under test is pinned under vendor/snapdom so a clean clone has no
// hidden sibling-checkout dependency.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SNAPDOM = join(HERE, 'vendor', 'snapdom', 'dist', 'snapdom.mjs')

export default {
  // Keep generated Vite state out of source and out of the packaged artifact.
  cacheDir: join(HERE, '.vite-cache'),
  resolve: {
    // Test the exact vendored build shipped by this package, not an adjacent source tree.
    alias: { '@zumer/snapdom': SNAPDOM },
  },
  server: { fs: { allow: [HERE] } },
  test: {
    include: ['test/**/*.test.js', 'experiment/signal.test.js'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }],
    },
  },
}
