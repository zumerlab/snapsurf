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
})
