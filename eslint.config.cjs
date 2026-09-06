// Lint config for the standalone agent repo. Keeps the established snapDOM style,
// including the
// no-inner-declarations rule, which exists because esbuild lowers block-level function
// declarations to a hoisted `var` and two same-named ones silently clobber each other.
// eslint and its globals are pinned in this package's lockfile.
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  {
    ignores: [
      'node_modules/**', 'companion/content.bundle.js', 'packages/**/dist/**',
      'logs/**', 'experiment/results/**',
    ],
  },
  js.configs.recommended,
  {
    files: [
      'src/**/*.js', 'test/**/*.js', 'tools/**/*.{js,mjs}', 'mcp/**/*.mjs',
      'companion/**/*.{js,mjs}', 'packages/**/*.{js,mjs}', 'experiment/multisite-pilot.mjs',
      'experiment/multisite-review-score.mjs', 'experiment/multisite/**/*.{js,mjs}',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'eol-last': ['error', 'always'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'arrow-spacing': ['error', { before: true, after: true }],
      'no-trailing-spaces': 'error',
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'disallow' }],
    },
  },
  {
    // Fixture markup/scripts are kept as template literals so their nested HTML and
    // JavaScript remain reviewable without layers of escaping.
    files: ['experiment/multisite/cases.mjs'],
    rules: {
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    },
  },
]
