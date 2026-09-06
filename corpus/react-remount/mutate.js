/**
 * React-style remount: the same visible UI rebuilt from scratch. Every element is
 * a NEW instance and the framework-ish hashed classes changed (c-aN → c-bN), the
 * way a fresh render with regenerated CSS-module hashes would look. Roles, names,
 * text, states and layout are identical. data-testid survives on the Refresh
 * button (tier-1 identity); the Archive button has none (structural identity).
 */
export default async function mutate(root, { frame }) {
  root.innerHTML = `
<style>
  .rr-card { padding: 16px; border: 1px solid #ccc; background: #fff; width: 360px; }
  .rr-card h2 { font-size: 18px; margin: 0 0 8px; }
  .rr-list { margin: 8px 0 12px; padding-left: 20px; }
  .rr-btn { padding: 6px 12px; border: 1px solid #888; background: #f5f5f5; color: #111; }
  .rr-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
</style>
<div class="rr-card c-b7">
  <h2 class="c-b8">Inbox</h2>
  <ul class="rr-list c-b9">
    <li class="c-c1">Message from Ana</li>
    <li class="c-c2">Weekly report</li>
  </ul>
  <button class="rr-btn rr-primary c-c3" data-testid="refresh-btn" type="button">Refresh</button>
  <button class="rr-btn c-c4" type="button">Archive</button>
</div>
`
  await frame()
}
