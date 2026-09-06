import { Buffer } from 'node:buffer'

// Compression estimates depend on the native codecs bundled with Node. Preserve
// their provenance while keeping every deterministic manifest field byte-checked.
export function checkDistributionManifest(currentBytes, expected) {
  const current = JSON.parse(currentBytes.toString('utf8'))
  const recorded = current?.compressionEnvironment
  const version = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded) ||
      !['zlib', 'brotli'].every((key) => typeof recorded[key] === 'string' && version.test(recorded[key]))) {
    throw new Error('distribution manifest requires valid zlib/brotli compression versions')
  }
  for (const field of ['gzipBytes', 'brotliBytes']) {
    if (!Number.isSafeInteger(current[field]) || current[field] <= 0) {
      throw new Error(`distribution manifest requires a positive safe integer ${field}`)
    }
  }
  const comparable = {
    ...expected,
    compressionEnvironment: { zlib: recorded.zlib, brotli: recorded.brotli },
  }
  const notCompared = []
  for (const [field, codec] of [['gzipBytes', 'zlib'], ['brotliBytes', 'brotli']]) {
    if (recorded[codec] !== expected.compressionEnvironment[codec]) {
      comparable[field] = current[field]
      notCompared.push(`${field}: recorded ${current[field]} with ${codec} ${recorded[codec]}; local ${expected[field]} with ${codec} ${expected.compressionEnvironment[codec]}`)
    }
  }
  if (!Buffer.from(`${JSON.stringify(comparable, null, 2)}\n`).equals(currentBytes)) {
    throw new Error('distribution manifest is stale; deterministic metadata or same-codec compression bytes differ')
  }
  return notCompared
}
