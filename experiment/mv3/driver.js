/* Runs in the ISOLATED world — the product's real environment. No bypassCSP anywhere. */
setTimeout(async () => {
  const out = { href: location.href, world: typeof window.__agentInspect }
  try {
    const t0 = performance.now()
    const ui = await window.__agentInspect(document.body)
    out.inspectMs = Math.round(performance.now() - t0)
    out.nodes = ui.__snapshot.order.length
    out.mapEntries = ui.agentMap.map.length
    out.contextBytes = ui.context.length
    out.unobservable = ui.unobservable.length
    const cp = ui.checkpoint()
    out.checkpointBytes = JSON.stringify(cp).length
    await new Promise((r) => setTimeout(r, 2000))
    const ui2 = await window.__agentInspect(document.body, { previous: cp })
    out.restFps = ui2.changes.length
    out.restKinds = [...new Set(ui2.changes.map((c) => c.kind))]
    out.restSample = ui2.changes.slice(0, 12).map((c) => ({ kind: c.kind, role: c.role, name: c.name && String(c.name).slice(0, 45) }))
    out.animCount = document.getAnimations ? document.getAnimations().length : -1
    out.caps = await window.__agentCaps()
    out.ok = true
  } catch (e) {
    out.ok = false
    out.error = String(e).slice(0, 200)
  }
  console.log('__MV3_ORACLE__' + JSON.stringify(out))
}, 10000)
