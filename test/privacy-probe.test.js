/**
 * Dynamic verification of Codex's privacy feature (2026-07-30).
 * Three questions, each answered by running the real pipeline:
 *   1. Round-trip: does a privacy checkpoint produce spurious changes on an unchanged page?
 *   2. Leak: does ui.changes / toChanges() expose content the caller asked to redact?
 *   3. Over-redaction: does the sensitive-looking heuristic nuke innocent text?
 */
import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'
import { hash } from '../src/hash.js'
import { observe, buildUi } from '../src/plugin.js'

const PRIVACY = { redact: ['delete account', 'email'] }

function mount(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('privacy probe', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('round-trip: privacy checkpoint against an unchanged page reports no changes', async () => {
    const root = mount('<button>Delete account</button><p>Contact: agent@example.com</p><input aria-label="Email" value="x">')
    const before = await inspect(root, { privacy: PRIVACY })
    const previous = before.checkpoint()
    const after = await inspect(root, { previous, privacy: PRIVACY })
    expect(after.changed).toBe(false)
    expect(after.changes).toEqual([])
  })

  it('round-trip: selecting privacy at buildUi time uses the canonical safe signatures', async () => {
    const root = mount(
      '<button data-testid="email">Email</button>' +
      '<input type="text" value="agent@example.com">'
    )
    // Some plugin consumers choose output policy after the observation. This path must
    // produce the same checkpoint as selecting privacy before the walk.
    const before = buildUi(observe(root), { privacy: PRIVACY })
    const previous = before.checkpoint()
    const after = await inspect(root, { previous, privacy: PRIVACY })

    expect(after.changed).toBe(false)
    expect(after.changes).toEqual([])
    expect(JSON.stringify(previous)).not.toContain('agent@example.com')
  })

  it('round-trip: matching survives redaction (mutation lands on the right node, match not degraded to removed+added)', async () => {
    const root = mount('<button id="b">Delete account</button><button>Save</button>')
    const before = await inspect(root, { privacy: PRIVACY })
    const previous = before.checkpoint()
    root.querySelector('#b').disabled = true
    const after = await inspect(root, { previous, privacy: PRIVACY })
    expect(after.changed).toBe(true)
    const kinds = after.changes.map(c => c.kind)
    expect(kinds).toContain('state')
    expect(kinds).not.toContain('removed')
    expect(kinds).not.toContain('added')
  })

  it('leak check: the change report does not expose redacted content', async () => {
    const root = mount('<button id="b">Delete account</button>')
    const before = await inspect(root, { privacy: PRIVACY })
    const previous = before.checkpoint()
    root.querySelector('#b').disabled = true
    const after = await inspect(root, { previous, privacy: PRIVACY })
    const wire = JSON.stringify({ changes: after.changes, delta: after.actionabilityDelta })
    expect(wire).not.toContain('Delete account')
  })

  it('leak check: added-node names in the change report are redacted', async () => {
    const root = mount('<button>Save</button>')
    const before = await inspect(root, { privacy: PRIVACY })
    const previous = before.checkpoint()
    const btn = document.createElement('button')
    btn.textContent = 'Delete account'
    root.appendChild(btn)
    const after = await inspect(root, { previous, privacy: PRIVACY })
    const wire = JSON.stringify(after.changes)
    expect(wire).not.toContain('Delete account')
  })

  it('leak check: query matches and compatibility snapshot use the redacted view', async () => {
    const root = mount('<button>Delete account</button>')
    const ui = await inspect(root, { privacy: PRIVACY })
    const match = ui.getByRole('button')

    expect(match.name).toBe('[redacted]')
    expect(JSON.stringify(ui.__snapshot, (_key, value) => value instanceof Map ? [...value] : value))
      .not.toContain('Delete account')
  })

  it('leak check: percent-encoded forms of a rule are redacted too', async () => {
    const root = mount('<a href="/users/alice%40corp.test">alice%40corp.test</a>')
    const ui = await inspect(root, { privacy: { redact: ['alice@corp.test'] } })
    expect(ui.getByRole('link').name).toBe('[redacted]')
    expect(JSON.stringify(ui.checkpoint())).not.toContain('alice%40corp.test')
  })

  it('leak check: test ids and every secret-derived checkpoint signature are non-verifiable', async () => {
    const secret = 'alice@example.com'
    const root = mount(
      `<button data-testid="${secret}">${secret}</button>` +
      `<input data-testid="ordinary" type="text" value="${secret}">`
    )
    const raw = await inspect(root)
    const safe = await inspect(root, { privacy: { redact: [secret] } })
    const rawButton = raw.__snapshot.nodes.get(raw.getByTestId(secret).id)
    const rawInput = raw.__snapshot.nodes.get(raw.getByTestId('ordinary').id)
    const safeButton = [...safe.__snapshot.nodes.values()].find((node) => node.role === 'button')
    const safeInput = safe.__snapshot.nodes.get(safe.getByTestId('ordinary').id)
    const wire = JSON.stringify(safe.checkpoint())

    expect(safe.context).not.toContain(secret)
    expect(safe.getByTestId(secret)).toBeNull()
    expect(safeButton.testid).toBeNull()
    expect(wire).not.toContain(secret)

    // The old values are exact offline-guessing probes. Check both the known formulas
    // and every raw node signature that can inherit the protected text/value.
    for (const probe of [
      hash('nm', secret),
      hash('f', secret),
      rawButton.nameFp,
      rawButton.textFp,
      rawButton.textHash,
      rawButton.rawTextHash,
      rawButton.contentHash,
      rawButton.subtreeHash,
      rawInput.stateHash,
      rawInput.contentHash,
      rawInput.subtreeHash,
      raw.rootHash,
    ]) {
      expect(wire, `raw secret-derived probe ${probe.slice(0, 8)} must not persist`)
        .not.toContain(probe.slice(0, 8))
    }
    expect(safeButton.nameFp).not.toBe(rawButton.nameFp)
    expect(safeButton.textFp).not.toBe(rawButton.textFp)
    expect(safeButton.textHash).not.toBe(rawButton.textHash)
    expect(safeInput.stateHash).not.toBe(rawInput.stateHash)
    expect(safe.rootHash).not.toBe(raw.rootHash)
  })

  it('leak check: a protected ordinary input exposes neither exact length nor a value-derived hash', async () => {
    const root = mount('<input data-testid="ordinary" style="width:200px" type="text">')
    const input = root.querySelector('input')
    const privacy = { redact: ['secret'] }

    input.value = 'secret-a'
    const short = await inspect(root, { privacy })
    const shortNode = short.__snapshot.nodes.get(short.getByTestId('ordinary').id)
    const shortWire = JSON.stringify(short.checkpoint())
    const formerShort = hash(
      's', JSON.stringify({ value: '•'.repeat(8), hasValue: true }), hash('v', 'secret-a')
    ).slice(0, 8)

    input.value = 'secret-is-much-longer'
    const long = await inspect(root, { privacy })
    const longNode = long.__snapshot.nodes.get(long.getByTestId('ordinary').id)
    const longWire = JSON.stringify(long.checkpoint())
    const formerLong = hash(
      's', JSON.stringify({ value: '•'.repeat(12), hasValue: true }), hash('v', 'secret-is-much-longer')
    ).slice(0, 8)

    expect(shortNode.state).toEqual({ hasValue: true })
    expect(longNode.state).toEqual({ hasValue: true })
    expect(shortNode.stateHash).toBe(longNode.stateHash)
    expect(short.rootHash).toBe(long.rootHash)
    expect(shortWire).not.toContain('•')
    expect(longWire).not.toContain('•')
    expect(shortWire).not.toContain(formerShort)
    expect(longWire).not.toContain(formerLong)
    expect(short.unobservable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'privacy-redacted-input-value',
        detection: 'presence-only',
      }),
    ]))
  })

  it('over-redaction: innocent text with digit runs survives when rules do not match it', async () => {
    const root = mount('<p>Order ref 2026-07-30 1234</p><p>Call 555-0100 today</p>')
    const ui = await inspect(root, { privacy: PRIVACY })
    expect(ui.context).toContain('Order ref')
  })

  // ── F3: auditable redaction report ─────────────────────────────────────────────

  it('report: counts hits by rule index and field, never exposing rule text or content', async () => {
    const root = mount('<button>Delete account</button><p>Reach us: email us anytime</p><button>Save</button>')
    const ui = await inspect(root, { privacy: PRIVACY })
    expect(ui.privacy).toBeDefined()
    expect(ui.privacy.rulesActive).toBe(2)
    expect(ui.privacy.nodesRedacted).toBeGreaterThan(0)
    // rule identifiers are indexes, and neither rule text nor redacted content leaks
    const wire = JSON.stringify(ui.privacy)
    for (const { rule } of ui.privacy.hitsByRule) expect(rule).toMatch(/^#\d+$/)
    expect(wire.toLowerCase()).not.toContain('delete account')
    expect(wire.toLowerCase()).not.toContain('email')
    // both rules matched something on this page
    const indexes = ui.privacy.hitsByRule.map((h) => h.rule)
    expect(indexes).toContain('#0')
    expect(indexes).toContain('#1')
  })

  it('report: absent when no rules are configured, and empty-hit when rules match nothing', async () => {
    const root = mount('<button>Save</button>')
    const none = await inspect(root)
    expect(none.privacy).toBeUndefined()
    const miss = await inspect(root, { privacy: { redact: ['nothing-here-xyz'] } })
    expect(miss.privacy).toBeDefined()
    expect(miss.privacy.rulesActive).toBe(1)
    expect(miss.privacy.hitsByRule).toEqual([])
    expect(miss.privacy.nodesRedacted).toBe(0)
  })

  it('report: diff redactions are tallied too', async () => {
    const root = mount('<button>Save</button>')
    const before = await inspect(root, { privacy: PRIVACY })
    const previous = before.checkpoint()
    const btn = document.createElement('button')
    btn.textContent = 'Delete account'
    root.appendChild(btn)
    const after = await inspect(root, { previous, privacy: PRIVACY })
    expect(after.changed).toBe(true)
    expect(after.privacy.hitsByRule.some((h) => h.rule === '#0' && h.hits > 0)).toBe(true)
    expect(Object.keys(after.privacy.fields)).toContain('name')
  })
})
