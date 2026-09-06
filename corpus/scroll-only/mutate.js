export default async function mutate(root, { frame }) {
  // Scroll the container and NOTHING else. Geometry is measured relative to the
  // nearest scrolling ancestor plus its scroll offset, so this must be a no-op diff.
  root.querySelector('[data-testid="scroller"]').scrollTop += 200
  await frame()
}
