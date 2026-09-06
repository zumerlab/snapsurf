export default async function mutate(root) {
  // CSS-in-JS regeneration: new class name, byte-different author notation
  // (#333 → rgb(51, 51, 51)), identical computed result.
  const style = document.createElement('style')
  style.id = 'css-gen-2'
  style.textContent = '.css-xyz789 { color: rgb(51, 51, 51); font-weight: 600; }'
  root.appendChild(style)
  for (const el of root.querySelectorAll('.css-abc123')) {
    el.classList.remove('css-abc123')
    el.classList.add('css-xyz789')
  }
  root.querySelector('#css-gen-1').remove()
}
