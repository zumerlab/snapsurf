/**
 * Portal render: the SAME dialog element (same instance, same content, same
 * subtree) is reparented from its inline source container into a separate
 * portal-root container further down the tree — exactly what a React portal
 * does on mount. Nothing about the node itself changes except where it lives,
 * so this must read as geometry (moved), never as added+removed, and the
 * node's identity must survive the reparenting.
 *
 * The two wrapper containers carry data-testid (as real portal roots do):
 * without a tier-1 handle, two anonymous generics swapping "who holds the
 * card" are genuinely ambiguous and the matcher may alias them by content,
 * which reads as phantom added/removed empty generics.
 */
export default async function mutate(root, { frame }) {
  const dialog = root.querySelector('[role="dialog"]')
  root.querySelector('#portal-root').appendChild(dialog)
  await frame()
}
