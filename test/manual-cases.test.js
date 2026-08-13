import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'

function mount(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('manual agent cases', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('redacts sensitive labels and values in context/checkpoint', async () => {
    const root = mount('<button>Delete account</button><input type="text" name="email" value="agent@example.com">')
    const ui = await inspect(root, { privacy: { redact: ['delete account', 'email'] } })
    const checkpointJson = JSON.stringify(ui.checkpoint())

    expect(ui.context).not.toContain('Delete account')
    expect(ui.context).toContain('[redacted]')
    expect(checkpointJson).not.toContain('agent@example.com')
    expect(checkpointJson).not.toContain('Delete account')
  })

  it('still finds actionable nodes when privacy is enabled', async () => {
    const root = mount('<input aria-label="Email" type="text" value="agent@example.com">')
    const ui = await inspect(root, { privacy: { redact: ['email'] } })

    expect(ui.getByRole('button', { name: 'Delete' })).toBeNull()
    // The protected label itself cannot remain a query predicate: doing so would expose
    // a one-bit presence oracle. The actionable control is still discoverable by role.
    const input = ui.getByRole('textbox')
    expect(input).toBeTruthy()
    expect(input.name).toBe('[redacted]')
    expect(ui.getByLabel('Email')).toBeNull()
  })

  it('keeps change detection working with no privacy rules', async () => {
    const root = mount('<button>Save</button>')
    const ui = await inspect(root)

    expect(ui.changed).toBeUndefined()
    expect(ui.context).toContain('button')
  })
})
