export default async function mutate(root, { frame }) {
  const ul = root.querySelector('ul')
  // Reverse the list: re-append existing nodes in reverse order. No text, state
  // or style changes — pure reorder, every item ends at a new position.
  for (const li of [...ul.children].reverse()) ul.appendChild(li)
  await frame()
}
