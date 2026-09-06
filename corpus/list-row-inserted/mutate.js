export default async function mutate(root) {
  const list = root.querySelector('[data-testid="orders"]')
  const row = document.createElement('li')
  row.style.cssText = 'padding:12px; border-bottom:1px solid #eee'
  row.textContent = 'Foxtrot shipment'
  // Insert in the middle: after Bravo, before Charlie → Charlie/Delta/Echo shift down.
  list.insertBefore(row, list.children[2])
}
