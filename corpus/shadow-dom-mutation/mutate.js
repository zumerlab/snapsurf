/**
 * The runner injects page.html via innerHTML, and fragment parsing NEVER honors
 * declarative shadow roots (<template shadowrootmode> stays inert — verified).
 * So the shadow root is attached here, adopting the host's existing children
 * unchanged (identical layout, same elements), a frame passes, and THEN the
 * mutation under test runs: a text change on the paragraph INSIDE the shadow root.
 */
export default async function mutate(root, { frame }) {
  const host = root.querySelector('x-card')
  const sr = host.attachShadow({ mode: 'open' })
  while (host.firstChild) sr.appendChild(host.firstChild)
  await frame()
  sr.querySelector('[data-testid="shadow-status"]').textContent = 'Estado: enviado'
}
