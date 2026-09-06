/**
 * Regressions from the visual field pass (FIELD.md, 2026-07-30):
 *  1. hidden-input proxy — native control at opacity:0 behind a styled label must stay
 *     in the agent map, and its own label must never be reported as its occluder.
 *  2. geometry freeze inheritance — a transform animation on a container moves every
 *     descendant; the §5 freeze must propagate down or every descendant reports moved.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from '../src/index.js'

function mount(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('field-pass fixes', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('a checkbox at opacity:0 with a visible label stays in the agent map, uncovered', async () => {
    const root = mount(
      '<div style="position:relative;width:200px">' +
      '<input type="checkbox" id="menu-toggle" style="position:absolute;opacity:0;width:32px;height:32px;margin:0">' +
      '<label for="menu-toggle" style="display:inline-flex;width:32px;height:32px;background:#eee">☰</label>' +
      '</div>'
    )
    const ui = await inspect(root)
    const entry = ui.agentMap.map.find((e) => e.r === 'checkbox')
    expect(entry).toBeTruthy()
    expect(entry.covered).toBeUndefined()
  })

  it('a checkbox hidden with visibility:hidden or display:none is NOT resurrected', async () => {
    const root = mount(
      '<div>' +
      '<input type="checkbox" id="a" style="visibility:hidden;width:20px;height:20px"><label for="a">A</label>' +
      '<input type="checkbox" id="b" style="display:none"><label for="b">B</label>' +
      '</div>'
    )
    const ui = await inspect(root)
    expect(ui.agentMap.map.filter((e) => e.r === 'checkbox')).toHaveLength(0)
  })

  it('descendants of a transform-animated container report no moved/resized noise', async () => {
    const style = document.createElement('style')
    style.textContent = '@keyframes __ff_slide { from { transform: translateX(0) } to { transform: translateX(160px) } }'
    document.head.appendChild(style)
    const root = mount(
      '<div style="width:400px">' +
      '<div id="strip" style="animation:__ff_slide 0.4s linear infinite alternate">' +
      '<button>Uno</button><button>Dos</button><span>logo</span>' +
      '</div>' +
      '<button>Fuera</button>' +
      '</div>'
    )
    const before = await inspect(root)
    const previous = before.checkpoint()
    await new Promise((r) => setTimeout(r, 150))
    const after = await inspect(root, { previous })
    const geomKinds = after.changes.filter((c) => c.kind === 'moved' || c.kind === 'resized')
    expect(geomKinds).toEqual([])
    style.remove()
  })
})
