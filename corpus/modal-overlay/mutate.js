export default async function mutate(root) {
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Confirmation')
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center'
  modal.innerHTML = '<div style="background:#fff;padding:20px"><p>¿Confirmar?</p><button>Sí</button></div>'
  root.appendChild(modal)
}
