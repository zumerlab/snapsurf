export default async function mutate(root, { frame }) {
  // Programmatic focus and nothing else. The only visual delta is the focus
  // ring (outline + box-shadow), which is deliberately outside the visual
  // style subset — so the diff must be empty.
  const btn = root.querySelector('[data-testid="publish"]')
  btn.focus()
  await frame()
  // Guard against a vacuous pass: the fixture only exercises its scenario if
  // the focus ring actually rendered.
  const cs = getComputedStyle(btn)
  if (cs.outlineStyle === 'none' || cs.boxShadow === 'none') {
    throw new Error(`residual-hover: focus ring did not apply (outline=${cs.outlineStyle}, boxShadow=${cs.boxShadow}, activeElement=${document.activeElement?.tagName})`)
  }
}
