/**
 * Dynamic verification of Codex's privacy feature (2026-07-30).
 * Three questions, each answered by running the real pipeline:
 *   1. Round-trip: does a privacy checkpoint produce spurious changes on an unchanged page?
 *   2. Leak: does ui.changes / toChanges() expose content the caller asked to redact?
 *   3. Over-redaction: does the sensitive-looking heuristic nuke innocent text?
 */
import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'

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
