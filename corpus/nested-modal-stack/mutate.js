export default async function mutate(root) {
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Second dialog')
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center'
  modal.innerHTML = '<div style="background:#fff;padding:24px"><p>Are you sure?</p><button>Confirm</button></div>'
  root.appendChild(modal)
}
