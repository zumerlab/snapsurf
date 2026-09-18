/** Known iframe omissions in a page-side viewport capture. No frame access is elevated. */
export function captureCoverage(root = document.body) {
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  const regions = []
  let regionsTotal = 0
  const intersects = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
  const parent = (el) => el.parentElement || el.getRootNode()?.host || null
  const visibleBox = (el) => {
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height || !intersects(rect, viewport)) return null
    let box = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) }
    for (let node = el; node; node = parent(node)) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || (node === el && style.visibility !== 'visible') || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return null
      if (node === el) continue
      const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX)
      const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY)
      if (clipX || clipY) {
        const clip = node.getBoundingClientRect()
        if (clipX) { box.left = Math.max(box.left, clip.left); box.right = Math.min(box.right, clip.right) }
        if (clipY) { box.top = Math.max(box.top, clip.top); box.bottom = Math.min(box.bottom, clip.bottom) }
        if (box.right <= box.left || box.bottom <= box.top) return null
      }
    }
    return [box.left, box.top, box.right - box.left, box.bottom - box.top].map(Math.round)
  }
  const visit = (container) => {
    for (const el of container.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot)
      if (el.localName !== 'iframe') continue
      const bbox = visibleBox(el)
      if (!bbox) continue
      let readable = false
      try { readable = !!(el.contentDocument || el.contentWindow?.document) } catch { /* browser access boundary */ }
      if (readable) continue
      regionsTotal++
      if (regions.length < 40) regions.push({
        sourceType: 'iframe', bbox,
        reason: el.hasAttribute('sandbox') && !el.sandbox.contains('allow-same-origin')
          ? 'sandbox-opaque-origin' : 'document-inaccessible',
      })
    }
  }
  visit(root)
  return {
    scope: 'top-document-and-open-shadow-iframes',
    status: regionsTotal ? 'partial' : 'no-known-omissions',
    regions, regionsTotal, regionsOmitted: regionsTotal - regions.length,
  }
}
