import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'
import { hash } from '../src/hash.js'

function mount(attributes, value) {
  const root = document.createElement('main')
  root.style.cssText = 'position:relative;width:400px'
  root.innerHTML = `<label for="secret">Secret</label><input id="secret" data-testid="secret" ${attributes}>`
  root.querySelector('input').value = value
  document.body.appendChild(root)
  return root
}

function formerStateDigest(value) {
  return hash('s', JSON.stringify({ hasValue: true }), hash('v', value)).slice(0, 8)
}

describe('sensitive input checkpoint privacy', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it.each([
    ['password type', 'type="password"'],
    ['email type', 'type="email"'],
    ['telephone type', 'type="tel"'],
    ['password autocomplete', 'autocomplete="section-login current-password"'],
    ['email autocomplete', 'autocomplete="email"'],
    ['credit-card autocomplete', 'autocomplete="billing cc-number"'],
  ])('does not persist a digest derived from the raw value for %s', async (_label, attributes) => {
    const value = 'guessable-secret-1234'
    const ui = await inspect(mount(attributes, value))
    const wire = JSON.stringify(ui.checkpoint())

    // This is the exact deterministic oracle older checkpoints exposed.
    expect(wire).not.toContain(formerStateDigest(value))
    expect(wire).not.toContain(value)
    expect(ui.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'sensitive-input-value',
        scope: 'value-change-detection',
        semanticsAvailable: true,
      }),
    ]))
  })

  it('detects a sensitive value crossing a coarse length bucket', async () => {
    const root = mount('type="password"', 'tiny')
    const before = await inspect(root)
    root.querySelector('input').value = 'a-much-longer-password'

    const after = await inspect(root, { previous: before.checkpoint() })

    expect(after.changed).toBe(true)
    expect(after.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'state' }),
    ]))
  })

  it('declares when a same-length sensitive edit cannot be detected', async () => {
    const root = mount('type="password"', 'alpha-bravo')
    const before = await inspect(root)
    const beforeCheckpoint = before.checkpoint()
    root.querySelector('input').value = 'delta-echo!'

    const after = await inspect(root, { previous: beforeCheckpoint })

    expect(after.changed).toBe(false)
    expect(after.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'sensitive-input-value',
        detection: 'presence-and-coarse-length-bucket',
        uncertainty: expect.stringMatching(/same-length edits.*may be missed/),
      }),
    ]))
    // Same-bucket values produce the same persisted signal, not a secret verifier.
    expect(after.checkpoint().rootHash).toBe(beforeCheckpoint.rootHash)
  })
})
