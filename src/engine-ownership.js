// Internal integration only; neither function is re-exported by a public entry
// point or attached to window. A capture-capable entry binds its renderer's
// read-only predicate before observing. Portable semantic bundles need no engine.
let ownsNode = null

export function bindEngineOwnership(predicate) {
  if (typeof predicate !== 'function') throw new TypeError('engine ownership requires a predicate')
  if (ownsNode && ownsNode !== predicate) throw new Error('engine ownership is already bound to a different renderer instance')
  ownsNode = predicate
}

export function isEngineInternalNode(node) {
  return ownsNode ? ownsNode(node) === true : false
}
