/**
 * Ambiguous in-place replacement: the card in slot 3 ("Gamma") is removed and a
 * DIFFERENT, unrelated card ("Omega") takes its exact place — same tag, same role,
 * same structure, same slot, but different heading text, copy and button label.
 * This is NOT an edit of the Gamma card: it is a brand-new element instance with
 * no identity signal shared with the old one beyond its position.
 */
export default async function mutate(root, { frame }) {
  const old = root.querySelectorAll('.nr-card')[2]
  const fresh = document.createElement('div')
  fresh.className = 'nr-card'
  fresh.innerHTML = `
    <h3>Omega</h3>
    <p>Completely unrelated offering.</p>
    <button type="button">Open Omega</button>
  `
  old.replaceWith(fresh)
  await frame()
}
