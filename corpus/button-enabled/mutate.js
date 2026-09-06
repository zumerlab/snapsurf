export default async function mutate(root) {
  root.querySelector('[data-testid="save"]').removeAttribute('disabled')
}
