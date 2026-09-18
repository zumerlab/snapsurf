import { afterEach, describe, expect, it } from 'vitest'
import { captureCoverage } from '../src/capture-coverage.js'

afterEach(() => { document.body.innerHTML = '' })

async function frame(parent = document.body, sandbox = '') {
  const el = document.createElement('iframe')
  el.style.cssText = 'display:block;width:160px;height:90px;border:0'
  if (sandbox !== null) el.setAttribute('sandbox', sandbox)
  const loaded = new Promise(resolve => el.addEventListener('load', resolve, { once: true }))
  el.srcdoc = '<p>Isolated document</p>'
  parent.append(el)
  await loaded
  return el
}

describe('page-side screenshot iframe coverage', () => {
  it('declares an opaque sandbox without changing its DOM, sandbox or srcdoc', async () => {
    const el = await frame()
    const before = document.body.innerHTML
    const mutations = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true })
    const coverage = captureCoverage()
    await Promise.resolve()
    observer.disconnect()
    expect(coverage.status).toBe('partial')
    expect(coverage.regionsTotal).toBe(1)
    expect(coverage.regions[0].reason).toBe('sandbox-opaque-origin')
    expect(coverage.regions[0].bbox.slice(2)).toEqual([160, 90])
    expect(el.contentDocument).toBeNull()
    expect(document.body.innerHTML).toBe(before)
    expect(mutations).toHaveLength(0)
    expect(JSON.stringify(coverage)).not.toContain('Isolated document')
  })

  it('does not label readable same-origin frames as omissions', async () => {
    await frame(document.body, 'allow-same-origin')
    await frame(document.body, null)
    expect(captureCoverage().regionsTotal).toBe(0)
    expect(captureCoverage().status).toBe('no-known-omissions')
  })

  it('distinguishes a non-sandboxed inaccessible document without reading its payload', async () => {
    const el = await frame(document.body, null)
    const loaded = new Promise(resolve => el.addEventListener('load', resolve, { once: true }))
    el.srcdoc = ''
    el.removeAttribute('srcdoc')
    el.src = 'data:text/html,<p>Private cross-origin payload</p>'
    await loaded
    const coverage = captureCoverage()
    expect(coverage.regions[0].reason).toBe('document-inaccessible')
    expect(JSON.stringify(coverage)).not.toContain('Private')
  })

  it('checks open shadow roots and responds to current visibility, not an old observation', async () => {
    const host = document.createElement('section')
    document.body.append(host)
    const el = await frame(host.attachShadow({ mode: 'open' }))
    expect(captureCoverage().regionsTotal).toBe(1)
    host.style.opacity = '0'
    expect(captureCoverage().regionsTotal).toBe(0)
    host.style.opacity = '1'
    el.style.visibility = 'hidden'
    expect(captureCoverage().regionsTotal).toBe(0)
    el.style.visibility = 'visible'
    expect(captureCoverage().regionsTotal).toBe(1)
  })

  it('omits offscreen, zero-size, hidden and fully overflow-clipped frames from warnings', async () => {
    const el = await frame()
    el.style.position = 'absolute'
    el.style.left = '-9999px'
    expect(captureCoverage().regionsTotal).toBe(0)
    el.style.left = '0'
    el.style.width = '0'
    expect(captureCoverage().regionsTotal).toBe(0)
    el.style.width = '160px'
    el.style.display = 'none'
    expect(captureCoverage().regionsTotal).toBe(0)
    el.style.display = 'block'
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'position:relative;width:20px;height:20px;overflow:hidden'
    document.body.append(wrapper)
    wrapper.append(el)
    el.style.top = '30px'
    expect(captureCoverage().regionsTotal).toBe(0)
  })

  it('declares detail truncation without shrinking the number of unreadable regions', async () => {
    await Promise.all(Array.from({ length: 42 }, async () => {
      const el = await frame()
      el.style.cssText += ';position:absolute;top:10px;left:10px'
    }))
    const coverage = captureCoverage()
    expect(coverage.status).toBe('partial')
    expect(coverage.regionsTotal).toBe(42)
    expect(coverage.regions).toHaveLength(40)
    expect(coverage.regionsOmitted).toBe(2)
  })
})
