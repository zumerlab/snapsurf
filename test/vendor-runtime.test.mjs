import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { URL } from 'node:url'

const root = new URL('../vendor/snapdom/', import.meta.url)
test('vendored runtime and transitive plugins match their pinned artifact manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
  assert.match(manifest.commit, /^[a-f0-9]{40}$/)
  assert.equal(manifest.version, '3.0.0-beta.0')
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
    'dist/snapdom.mjs', 'plugins/capture-frames.js', 'plugins/gif-export.js',
    'plugins/privacy-policy.js', 'plugins/redact-clone.js', 'plugins/redact-inputs.js',
    'plugins/video-export.js',
  ])
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const bytes = await readFile(new URL(name, root))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name)
    if (name.startsWith('plugins/')) {
      const source = bytes.toString('utf8')
      for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
        assert.ok(match[1].startsWith('.'), `${name}: external engine import ${match[1]}`)
        await readFile(new URL(match[1], new URL(name, root)))
      }
    }
  }
})
