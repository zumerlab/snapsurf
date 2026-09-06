import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { checkDistributionManifest } from '../tools/distribution-manifest.mjs'

const expected = {
  schemaVersion: 1,
  bytes: 1000,
  gzipBytes: 500,
  brotliBytes: 400,
  compressionEnvironment: { zlib: '1.3.1-e00f703', brotli: '1.1.0' },
  sha256: 'exact-bundle-hash',
  exports: ['observe'],
  staticEvidence: { matches: [] },
}
const wire = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

test('distribution manifests enforce sizes when the recorded codec versions match', () => {
  assert.deepEqual(checkDistributionManifest(wire(expected), expected), [])
  for (const field of ['gzipBytes', 'brotliBytes']) {
    assert.throws(() => checkDistributionManifest(wire({ ...expected, [field]: expected[field] + 1 }), expected), /stale/)
  }
})

test('different codecs retain their measured sizes with explicit comparison limits', () => {
  const recorded = {
    ...expected,
    gzipBytes: 498,
    compressionEnvironment: { ...expected.compressionEnvironment, zlib: '1.2.12' },
  }
  const limits = checkDistributionManifest(wire(recorded), expected)
  assert.deepEqual(limits, ['gzipBytes: recorded 498 with zlib 1.2.12; local 500 with zlib 1.3.1-e00f703'])
  assert.throws(() => checkDistributionManifest(wire({ ...recorded, brotliBytes: 399 }), expected), /stale/,
    'a differing gzip codec cannot relax the unchanged Brotli codec check')
  for (const mutation of [
    { bytes: 1001 }, { sha256: 'different-hash' }, { exports: ['other'] },
    { staticEvidence: { matches: ['fetch('] } }, { unexpectedField: true },
  ]) {
    assert.throws(() => checkDistributionManifest(wire({ ...recorded, ...mutation }), expected), /stale/,
      'codec variation cannot relax deterministic metadata checks')
  }
})

test('compression provenance and sizes cannot be missing, invalid or silently unchecked', () => {
  for (const compressionEnvironment of [undefined, null, {}, [], { zlib: 'unknown', brotli: '1.1.0' }, { zlib: 42, brotli: '1.1.0' }]) {
    assert.throws(() => checkDistributionManifest(wire({ ...expected, compressionEnvironment }), expected), /compression versions/)
  }
  for (const field of ['gzipBytes', 'brotliBytes']) {
    for (const value of [undefined, null, 0, -1, 1.5, '500', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => checkDistributionManifest(wire({
        ...expected,
        compressionEnvironment: { zlib: '9.9.9', brotli: '9.9.9' },
        [field]: value,
      }), expected), /positive safe integer/)
    }
  }
  assert.throws(() => checkDistributionManifest(wire({
    ...expected,
    compressionEnvironment: { ...expected.compressionEnvironment, extra: 'ignored?' },
  }), expected), /stale/)
})
