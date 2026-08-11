// Vitest config for the STANDALONE agent repo (post subtree split).
//
// The suite runs in a real browser because the oracle measures layout, and it needs the
// snapdom core sources, which live in a sibling checkout — not in node_modules, since
// `@zumer/snapdom@^3.0.0` is a peer that is never published from here. So:
//
//   - `@zumer/snapdom` is aliased to the HOST repo's live source (same thing the old
//     monorepo did with a ../../../ relative import, minus the layout assumption),
//   - vitest itself is borrowed from the HOST repo's node_modules (see package.json).
//
// Point SNAPDOM_REPO at another checkout to test against it (e.g. main instead of v3).
// No imports from 'vitest/config' on purpose: this repo has no node_modules of its own,
// and defineConfig is only types — a plain object is the same config.
import { join } from 'node:path'
import { resolveHost, AGENT_ROOT as HERE } from './tools/host-repo.mjs'

const HOST = resolveHost()

export default {
  // node_modules is a symlink into the host checkout (see tools/run-vitest.mjs), so keep
  // vite's cache here instead of writing it into the tree the host repo also uses.
  cacheDir: join(HERE, '.vite-cache'),
  resolve: {
    alias: { '@zumer/snapdom': join(HOST, 'src', 'api', 'snapdom.js') },
  },
  // The host tree is outside this root; vite must be allowed to serve it.
  server: { fs: { allow: [HERE, HOST] } },
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
