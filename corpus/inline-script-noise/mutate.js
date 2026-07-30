/**
 * Real e-commerce and news pages carry inline tracking scripts whose contents change on
 * every render (timestamps, cache-busting ids). Nothing a user can see changes.
 * Found in the field pass: a Mercado Libre container was reporting its accessible name
 * as "(function() { if (false) { var firstViewUrl = …" — the script's source code.
 */
export default async function mutate(root) {
  root.querySelector('script').textContent = 'window.__tracking = { ts: 1799999999, view: "b" }'
}
