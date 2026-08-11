// Lint config for the standalone agent repo. Mirrors the host repo's rules (snapdom's
// eslint.config.cjs) so code moving between the two keeps one style — including the
// no-inner-declarations rule, which exists because esbuild lowers block-level function
// declarations to a hoisted `var` and two same-named ones silently clobber each other.
// eslint itself is resolved from the host's node_modules (see tools/run-vitest.mjs).
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  {
    ignores: ['node_modules/**', 'companion/content.bundle.js', 'logs/**', 'experiment/results/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
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
]
