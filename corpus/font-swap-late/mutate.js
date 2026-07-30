export default async function mutate(root) {
  // Late font swap: the web font "arrived", the app flips the container's class
  // from the serif fallback stack to the sans stack. Only font-family changes;
  // descendants reflow from the new metrics.
  const reader = root.querySelector('#reader')
  reader.classList.remove('stack-serif')
  reader.classList.add('stack-sans')
}
