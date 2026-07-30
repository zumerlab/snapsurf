export default async function mutate(root) {
  // Built-in clock normalization: "14:32:05" → "14:32:07" must hash identically.
  root.querySelector('[data-testid="clock"]').textContent = '14:32:07'
  // Built-in relative-time normalization (Spanish form).
  root.querySelector('[data-testid="rel"]').textContent = 'hace 5 segundos'
  // Bare number — NOT covered by any built-in normalizer; only the preset's
  // [data-live-clock] ignore selector keeps it out of the diff.
  const counter = root.querySelector('[data-live-clock]')
  counter.textContent = String(Number(counter.textContent) + 1)
}
