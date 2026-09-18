import { afterEach, describe, expect, it } from 'vitest'
import { observe, buildUi } from '../src/plugin.js'

afterEach(() => { document.body.innerHTML = '' })
function fixture(html) {
  const root = document.createElement('section')
  root.innerHTML = html
  document.body.append(root)
  return root
}
function read(root, selector, options = {}) {
  const observation = observe(root, options)
  const element = root.querySelector(selector)
  return observation.snapshot.nodes.get(observation.snapshot.byElement.get(element))
}

describe('accessible names for native labels and hidden helpers', () => {
  it('keeps a wrapping select label separate from all 31 option names', () => {
    const options = Array.from({ length: 31 }, (_, i) => `<option value="v${i}">Choice ${i}</option>`).join('')
    const root = fixture(`<label>Test <span>case</span><select>${options}</select></label>`)
    expect(read(root, 'select').name).toBe('Test case')
    expect(read(root, 'option').name).toBe('Choice 0')
    root.querySelector('select').value = 'v20'
    expect(read(root, 'select').name).toBe('Test case')
    expect(read(root, 'option:checked').name).toBe('Choice 20')
  })

  it('uses an option label attribute and never invents an unlabeled select name from choices', () => {
    const root = fixture('<select><option label="Readable choice">Internal fallback</option><option>Other choice</option></select>')
    expect(read(root, 'option').name).toBe('Readable choice')
    expect(read(root, 'select').name).toBe('')
  })

  it('does not name non-labelable descendants after a surrounding control label', () => {
    const root = fixture('<label>Plan <span>Public explanation</span><select><option>Basic</option></select></label>')
    expect(read(root, 'span').name).toBe('Public explanation')
    expect(read(root, 'select').name).toBe('Plan Public explanation')
  })

  it('ignores hidden auxiliary errors when summarizing a landmark', () => {
    const root = fixture(`<style>.auxiliary { display:none }</style><main>
      <div class="auxiliary">Uh oh! There was an error while loading.</div>
      <div hidden>Hidden error</div><div aria-hidden="true">Auxiliary error</div>
      <div style="visibility:hidden">Invisible error</div><h1>Coverage discussion</h1><p>Real discussion text</p>
    </main>`)
    const name = read(root, 'main').name
    expect(name).toContain('Coverage discussion')
    expect(name).not.toMatch(/error|Uh oh/)
  })

  it('retains explicitly referenced hidden labels and applies privacy to them', () => {
    const root = fixture('<span id="hidden-label" hidden>Hidden authored name</span><button aria-labelledby="hidden-label">Fallback</button>')
    expect(read(root, 'button').name).toBe('Hidden authored name')
    const ui = buildUi(observe(root, { privacy: { redact: ['Hidden authored name'] } }))
    expect(JSON.stringify(ui.agentMap)).not.toContain('Hidden authored name')
  })
})
