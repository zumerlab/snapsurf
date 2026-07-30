export default async function mutate(root) {
  root.querySelector('[data-testid="status"]').textContent = 'Estado: enviado'
}
