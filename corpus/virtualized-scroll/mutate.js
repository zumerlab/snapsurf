/**
 * Virtualizer window swap: the user scrolls 6 rows down (240px) and the
 * virtualizer reacts — recycles rows 1..6, renders rows 13..18, and grows the
 * top spacer / shrinks the bottom spacer so surviving rows keep their
 * content-space position. Total content height stays 30 × 40 = 1200px.
 */
const WORDS = ['mike', 'november', 'oscar', 'papa', 'quebec', 'romeo']

export default async function mutate(root, { frame }) {
  const scroller = root.querySelector('[data-testid="scroller"]')
  const top = root.querySelector('[data-testid="spacer-top"]')
  const bottom = root.querySelector('[data-testid="spacer-bottom"]')

  scroller.scrollTop = 240

  const rows = [...scroller.querySelectorAll('.vrow')]
  for (const row of rows.slice(0, 6)) row.remove()

  for (let i = 13; i <= 18; i++) {
    const div = document.createElement('div')
    div.className = 'vrow'
    div.textContent = `Row ${i} · ${WORDS[i - 13]}`
    bottom.before(div)
  }

  top.style.height = '240px'
  bottom.style.height = '480px'

  await frame()
}
