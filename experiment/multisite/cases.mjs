/**
 * Frozen, public half of the controlled multisite pilot.
 *
 * The neutral intent is public. Truth variants are deliberately absent from this file's
 * rendered markup and URLs: the fixture server owns the opaque run-id -> variant map.
 * These are versioned local replicas of four interaction families, not live-site claims.
 */
export const FIXTURE_VERSION = 1
export const VARIANTS = Object.freeze(['intended', 'fault'])

export const CASES = Object.freeze([
  {
    id: 'T1', siteId: 'todomvc', title: 'create one exact todo',
    action: 'Submit "Pilot alpha" through the New todo textbox.',
    preconditions: ['one existing todo', 'Pilot alpha absent'],
    conjuncts: [
      { id: 'target-added', statement: 'Pilot alpha is present exactly once.' },
      { id: 'count-plus-one', statement: 'The todo count changes from one to two.' },
      { id: 'no-draft-only', statement: 'The action did not merely save a draft/status.' },
    ],
    fault: 'The input/status changes, but Pilot alpha is not created.',
  },
  {
    id: 'T2', siteId: 'todomvc', title: 'complete the exact todo',
    action: 'Activate the checkbox for Pilot alpha.',
    preconditions: ['Pilot alpha incomplete', 'Neighbor beta incomplete'],
    conjuncts: [
      { id: 'target-completed', statement: 'Pilot alpha changes from incomplete to complete.' },
      { id: 'neighbor-stable', statement: 'Neighbor beta remains incomplete.' },
    ],
    fault: 'Neighbor beta completes instead of Pilot alpha.',
  },
  {
    id: 'T3', siteId: 'todomvc', title: 'filter to the active route',
    action: 'Activate the Active filter.',
    preconditions: ['one active todo', 'one completed todo', 'route #/all'],
    conjuncts: [
      { id: 'active-route', statement: 'The route becomes #/active.' },
      { id: 'active-visible', statement: 'Active item remains visible.' },
      { id: 'completed-absent', statement: 'Completed item is absent from the rendered list.' },
    ],
    fault: 'The hash changes, but the completed item remains rendered.',
  },
  {
    id: 'T4', siteId: 'todomvc', title: 'delete the exact todo',
    action: 'Activate Delete Pilot alpha.',
    preconditions: ['Pilot alpha present', 'Neighbor beta present'],
    conjuncts: [
      { id: 'target-removed', statement: 'Pilot alpha is absent.' },
      { id: 'neighbor-present', statement: 'Neighbor beta remains present.' },
      { id: 'count-minus-one', statement: 'The todo count changes from two to one.' },
    ],
    fault: 'Neighbor beta is removed while Pilot alpha remains.',
  },
  {
    id: 'S1', siteId: 'saucedemo', title: 'login reaches inventory',
    action: 'Submit the fixed public test credentials.',
    preconditions: ['login form visible', 'inventory absent'],
    conjuncts: [
      { id: 'inventory-visible', statement: 'Products inventory is visible.' },
      { id: 'login-absent', statement: 'The login form is absent.' },
      { id: 'error-absent', statement: 'No login error is shown.' },
    ],
    fault: 'The page changes to an error while the login form remains.',
  },
  {
    id: 'S2', siteId: 'saucedemo', title: 'add the exact product',
    action: 'Activate Add Backpack to cart.',
    preconditions: ['Backpack and Bike Light both not in cart', 'cart badge absent'],
    conjuncts: [
      { id: 'target-button-transition', statement: 'Backpack control changes to Remove Backpack from cart.' },
      { id: 'neighbor-stable', statement: 'Bike Light remains not in the cart.' },
      { id: 'badge-one', statement: 'The cart badge becomes one.' },
    ],
    fault: 'Bike Light is added instead; the badge still becomes one.',
  },
  {
    id: 'S3', siteId: 'saucedemo', title: 'remove the exact product',
    action: 'Activate Remove Backpack from cart.',
    preconditions: ['Backpack present', 'Bike Light present', 'cart badge two'],
    conjuncts: [
      { id: 'target-removed', statement: 'Backpack is absent from the cart.' },
      { id: 'neighbor-present', statement: 'Bike Light remains in the cart.' },
      { id: 'badge-one', statement: 'The cart badge changes from two to one.' },
    ],
    fault: 'Bike Light is removed while Backpack remains; the badge still becomes one.',
  },
  {
    id: 'I1', siteId: 'the-internet', title: 'remove the dynamic checkbox',
    action: 'Activate Remove.',
    preconditions: ['dynamic checkbox visible', 'Remove button visible'],
    conjuncts: [
      { id: 'checkbox-absent', statement: 'Dynamic checkbox is absent.' },
      { id: 'add-visible', statement: 'Add button is visible.' },
      { id: 'gone-message', statement: "It's gone! is visible." },
    ],
    fault: 'The message and button change, but the checkbox remains.',
  },
  {
    id: 'I2', siteId: 'the-internet', title: 'enable the textbox',
    action: 'Activate Enable.',
    preconditions: ['textbox disabled', 'Enable button visible'],
    conjuncts: [
      { id: 'textbox-enabled', statement: 'Editable field changes from disabled to enabled.' },
      { id: 'disable-visible', statement: 'Disable button is visible.' },
      { id: 'enabled-message', statement: "It's enabled! is visible." },
    ],
    fault: 'The message and button change, but the textbox remains disabled.',
  },
  {
    id: 'I3', siteId: 'the-internet', title: 'load the delayed content',
    action: 'Activate Start.',
    preconditions: ['Hello World absent', 'loading indicator absent'],
    conjuncts: [
      { id: 'hello-visible', statement: 'Hello World! is added and visible.' },
      { id: 'loader-absent', statement: 'Loading indicator is absent after completion.' },
    ],
    fault: 'The spinner disappears without adding Hello World!.',
  },
  {
    id: 'B1', siteId: 'bootstrap', title: 'open an actionable modal',
    action: 'Activate Launch demo modal.',
    preconditions: ['dialog absent', 'launcher actionable'],
    conjuncts: [
      { id: 'dialog-visible', statement: 'Verification modal is visible.' },
      { id: 'close-actionable', statement: 'Close modal is not geometrically covered.' },
      { id: 'launcher-covered', statement: 'The backdrop covers the launcher.' },
    ],
    fault: 'The dialog renders, but an additional overlay covers Close modal.',
  },
  {
    id: 'B2', siteId: 'bootstrap', title: 'close the modal completely',
    action: 'Activate Close modal.',
    preconditions: ['dialog visible', 'backdrop visible', 'launcher covered'],
    conjuncts: [
      { id: 'dialog-absent', statement: 'Verification modal is absent.' },
      { id: 'backdrop-absent', statement: 'Modal backdrop is absent.' },
      { id: 'launcher-actionable', statement: 'Launch demo modal is actionable again.' },
    ],
    fault: 'The dialog hides but a transparent backdrop still intercepts the launcher.',
  },
])

const codes = Object.freeze({
  T1: [7311, 4902], T2: [1823, 7714], T3: [6651, 2384], T4: [9017, 3146],
  S1: [5279, 8063], S2: [4421, 9730], S3: [6098, 1572],
  I1: [2854, 7180], I2: [8342, 3619], I3: [1964, 8857],
  B1: [7536, 4208], B2: [3175, 9641],
})

export function effectCode(caseId, variant) {
  const pair = codes[caseId]
  const index = VARIANTS.indexOf(variant)
  if (!pair || index < 0) throw new Error(`unknown controlled fixture ${caseId}/${variant}`)
  return pair[index]
}

export function initialState(caseId) {
  switch (caseId) {
    case 'T1': return { items: ['Existing todo'], status: 'Ready' }
    case 'T2': return { targetChecked: false, neighborChecked: false }
    case 'T3': return { hash: '#/all', visibleItems: ['Active item', 'Completed item'] }
    case 'T4': return { items: ['Pilot alpha', 'Neighbor beta'] }
    case 'S1': return { inventoryVisible: false, loginVisible: true, errorVisible: false }
    case 'S2': return { backpackInCart: false, bikeInCart: false, badge: 0 }
    case 'S3': return { cartItems: ['Backpack', 'Bike Light'], badge: 2 }
    case 'I1': return { checkboxPresent: true, button: 'Remove', message: '' }
    case 'I2': return { disabled: true, button: 'Enable', message: '' }
    case 'I3': return { helloVisible: false, loaderVisible: false }
    case 'B1': return { dialogVisible: false, closeCovered: false, launcherCovered: false }
    case 'B2': return { dialogVisible: true, backdropVisible: true, launcherCovered: true }
    default: throw new Error(`unknown case ${caseId}`)
  }
}

export function expectedState(caseId, variant) {
  const intended = variant === 'intended'
  switch (caseId) {
    case 'T1': return intended
      ? { items: ['Existing todo', 'Pilot alpha'], status: 'Ready' }
      : { items: ['Existing todo'], status: 'Draft saved' }
    case 'T2': return intended
      ? { targetChecked: true, neighborChecked: false }
      : { targetChecked: false, neighborChecked: true }
    case 'T3': return intended
      ? { hash: '#/active', visibleItems: ['Active item'] }
      : { hash: '#/active', visibleItems: ['Active item', 'Completed item'] }
    case 'T4': return intended
      ? { items: ['Neighbor beta'] }
      : { items: ['Pilot alpha'] }
    case 'S1': return intended
      ? { inventoryVisible: true, loginVisible: false, errorVisible: false }
      : { inventoryVisible: false, loginVisible: true, errorVisible: true }
    case 'S2': return intended
      ? { backpackInCart: true, bikeInCart: false, badge: 1 }
      : { backpackInCart: false, bikeInCart: true, badge: 1 }
    case 'S3': return intended
      ? { cartItems: ['Bike Light'], badge: 1 }
      : { cartItems: ['Backpack'], badge: 1 }
    case 'I1': return intended
      ? { checkboxPresent: false, button: 'Add', message: "It's gone!" }
      : { checkboxPresent: true, button: 'Add', message: "It's gone!" }
    case 'I2': return intended
      ? { disabled: false, button: 'Disable', message: "It's enabled!" }
      : { disabled: true, button: 'Disable', message: "It's enabled!" }
    case 'I3': return intended
      ? { helloVisible: true, loaderVisible: false }
      : { helloVisible: false, loaderVisible: false }
    case 'B1': return intended
      ? { dialogVisible: true, closeCovered: false, launcherCovered: true }
      : { dialogVisible: true, closeCovered: true, launcherCovered: true }
    case 'B2': return intended
      ? { dialogVisible: false, backdropVisible: false, launcherCovered: false }
      : { dialogVisible: false, backdropVisible: true, launcherCovered: true }
    default: throw new Error(`unknown case ${caseId}`)
  }
}

export function oracleChecks(caseId, state) {
  switch (caseId) {
    case 'T1': return {
      'target-added': state.items.filter((item) => item === 'Pilot alpha').length === 1,
      'count-plus-one': state.items.length === 2,
      'no-draft-only': state.status !== 'Draft saved',
    }
    case 'T2': return {
      'target-completed': state.targetChecked === true,
      'neighbor-stable': state.neighborChecked === false,
    }
    case 'T3': return {
      'active-route': state.hash === '#/active',
      'active-visible': state.visibleItems.includes('Active item'),
      'completed-absent': !state.visibleItems.includes('Completed item'),
    }
    case 'T4': return {
      'target-removed': !state.items.includes('Pilot alpha'),
      'neighbor-present': state.items.includes('Neighbor beta'),
      'count-minus-one': state.items.length === 1,
    }
    case 'S1': return {
      'inventory-visible': state.inventoryVisible === true,
      'login-absent': state.loginVisible === false,
      'error-absent': state.errorVisible === false,
    }
    case 'S2': return {
      'target-button-transition': state.backpackInCart === true,
      'neighbor-stable': state.bikeInCart === false,
      'badge-one': state.badge === 1,
    }
    case 'S3': return {
      'target-removed': !state.cartItems.includes('Backpack'),
      'neighbor-present': state.cartItems.includes('Bike Light'),
      'badge-one': state.badge === 1,
    }
    case 'I1': return {
      'checkbox-absent': state.checkboxPresent === false,
      'add-visible': state.button === 'Add',
      'gone-message': state.message === "It's gone!",
    }
    case 'I2': return {
      'textbox-enabled': state.disabled === false,
      'disable-visible': state.button === 'Disable',
      'enabled-message': state.message === "It's enabled!",
    }
    case 'I3': return {
      'hello-visible': state.helloVisible === true,
      'loader-absent': state.loaderVisible === false,
    }
    case 'B1': return {
      'dialog-visible': state.dialogVisible === true,
      'close-actionable': state.closeCovered === false,
      'launcher-covered': state.launcherCovered === true,
    }
    case 'B2': return {
      'dialog-absent': state.dialogVisible === false,
      'backdrop-absent': state.backdropVisible === false,
      'launcher-actionable': state.launcherCovered === false,
    }
    default: throw new Error(`unknown case ${caseId}`)
  }
}

export function oracleVerdict(caseId, state) {
  if (!state) return 'UNKNOWN'
  return Object.values(oracleChecks(caseId, state)).every(Boolean) ? 'PASS' : 'FAIL'
}

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const fixtureBody = (caseId) => {
  switch (caseId) {
    case 'T1': return {
      title: 'Todo list',
      body: `<main><h1>Todos</h1><label>New todo <input id="new-todo" autocomplete="off"></label><p id="status">Ready</p><p id="count">1 item</p><ul id="todos"><li>Existing todo</li></ul></main>`,
      script: `byId('new-todo').addEventListener('keydown', async event => { if (event.key !== 'Enter') return; event.preventDefault(); const result = await effect(); if (result.code === 7311) { addItem('todos', 'Pilot alpha'); byId('status').textContent = 'Ready'; byId('count').textContent = '2 items' } else { byId('status').textContent = 'Draft saved' } event.target.value = ''; settle() })`,
    }
    case 'T2': return {
      title: 'Todo list',
      body: `<main><h1>Todos</h1><label><input id="target" type="checkbox"> Pilot alpha</label><label><input id="neighbor" type="checkbox"> Neighbor beta</label></main>`,
      script: `byId('target').addEventListener('click', async event => { event.preventDefault(); const result = await effect(); byId(result.code === 1823 ? 'target' : 'neighbor').checked = true; settle() })`,
    }
    case 'T3': return {
      title: 'Todo list',
      body: `<main><h1>Todos</h1><nav><a id="active-filter" href="#/active">Active</a></nav><ul id="todos"><li data-state="active">Active item</li><li data-state="completed">Completed item</li></ul></main>`,
      script: `location.hash = '/all'; byId('active-filter').addEventListener('click', async event => { event.preventDefault(); const result = await effect(); location.hash = '/active'; if (result.code === 6651) document.querySelector('[data-state=completed]').remove(); settle() })`,
    }
    case 'T4': return {
      title: 'Todo list',
      body: `<main><h1>Todos</h1><ul id="todos"><li data-item="target">Pilot alpha <button id="delete-target">Delete Pilot alpha</button></li><li data-item="neighbor">Neighbor beta <button>Delete Neighbor beta</button></li></ul></main>`,
      script: `byId('delete-target').addEventListener('click', async () => { const result = await effect(); document.querySelector(result.code === 9017 ? '[data-item=target]' : '[data-item=neighbor]').remove(); settle() })`,
    }
    case 'S1': return {
      title: 'Store login',
      body: `<main><section id="login"><h1>Sign in</h1><form id="login-form"><label>Username <input id="username" autocomplete="off"></label><label>Password <input id="password" type="password" autocomplete="off"></label><button>Login</button></form></section><section id="inventory" hidden><h1>Products</h1><p>Backpack</p><p>Bike Light</p></section></main>`,
      script: `byId('login-form').addEventListener('submit', async event => { event.preventDefault(); const result = await effect(); if (result.code === 5279) { byId('login').remove(); byId('inventory').hidden = false } else { const error = document.createElement('p'); error.id = 'error'; error.textContent = 'Invalid login'; byId('login').appendChild(error) } settle() })`,
    }
    case 'S2': return {
      title: 'Store inventory',
      body: `<main><h1>Products</h1><a href="#cart">Cart <span id="badge" hidden></span></a><article><h2>Backpack</h2><button id="add-backpack">Add Backpack to cart</button></article><article><h2>Bike Light</h2><button id="add-bike">Add Bike Light to cart</button></article></main>`,
      script: `byId('add-backpack').addEventListener('click', async () => { const result = await effect(); const target = result.code === 4421 ? byId('add-backpack') : byId('add-bike'); target.textContent = result.code === 4421 ? 'Remove Backpack from cart' : 'Remove Bike Light from cart'; byId('badge').hidden = false; byId('badge').textContent = '1'; settle() })`,
    }
    case 'S3': return {
      title: 'Store cart',
      body: `<main><h1>Your Cart</h1><a href="#cart">Cart <span id="badge">2</span></a><section id="cart"><article data-item="backpack"><h2>Backpack</h2><button id="remove-backpack">Remove Backpack from cart</button></article><article data-item="bike"><h2>Bike Light</h2><button>Remove Bike Light from cart</button></article></section></main>`,
      script: `byId('remove-backpack').addEventListener('click', async () => { const result = await effect(); document.querySelector(result.code === 6098 ? '[data-item=backpack]' : '[data-item=bike]').remove(); byId('badge').textContent = '1'; settle() })`,
    }
    case 'I1': return {
      title: 'Dynamic controls',
      body: `<main><h1>Dynamic Controls</h1><section id="control"><label id="checkbox-label"><input id="dynamic-checkbox" type="checkbox"> Dynamic checkbox</label><button id="toggle">Remove</button><p id="message"></p></section></main>`,
      script: `byId('toggle').addEventListener('click', async () => { const result = await effect(); if (result.code === 2854) byId('checkbox-label').remove(); byId('toggle').textContent = 'Add'; byId('message').textContent = "It's gone!"; settle() })`,
    }
    case 'I2': return {
      title: 'Dynamic controls',
      body: `<main><h1>Dynamic Controls</h1><label>Editable field <input id="editable" disabled></label><button id="enable">Enable</button><p id="message"></p></main>`,
      script: `byId('enable').addEventListener('click', async () => { const result = await effect(); if (result.code === 8342) byId('editable').disabled = false; byId('enable').textContent = 'Disable'; byId('message').textContent = "It's enabled!"; settle() })`,
    }
    case 'I3': return {
      title: 'Dynamic loading',
      body: `<main><h1>Dynamically Loaded Page Elements</h1><button id="start">Start</button><p id="loader" hidden>Loading…</p><section id="finish"></section></main>`,
      script: `byId('start').addEventListener('click', async () => { byId('loader').hidden = false; const result = await effect(); setTimeout(() => { byId('loader').remove(); if (result.code === 1964) { const heading = document.createElement('h2'); heading.textContent = 'Hello World!'; byId('finish').appendChild(heading) } settle() }, 180) })`,
    }
    case 'B1': return {
      title: 'Modal demo',
      body: `<main><h1>Modal</h1><button id="launch">Launch demo modal</button></main><div id="backdrop" class="backdrop" aria-label="Modal backdrop" hidden></div><section id="dialog" role="dialog" aria-label="Verification modal" hidden><h2>Verification modal</h2><button id="close">Close modal</button></section><div id="close-cover" class="close-cover" aria-label="Blocking layer" hidden></div>`,
      script: `byId('launch').addEventListener('click', async () => { const result = await effect(); byId('backdrop').hidden = false; byId('dialog').hidden = false; if (result.code === 4208) byId('close-cover').hidden = false; settle() })`,
    }
    case 'B2': return {
      title: 'Modal demo',
      body: `<main><h1>Modal</h1><button id="launch">Launch demo modal</button></main><div id="backdrop" class="backdrop" aria-label="Modal backdrop"></div><section id="dialog" role="dialog" aria-label="Verification modal"><h2>Verification modal</h2><button id="close">Close modal</button></section>`,
      script: `byId('close').addEventListener('click', async () => { const result = await effect(); byId('dialog').remove(); if (result.code === 3175) byId('backdrop').remove(); else byId('backdrop').style.opacity = '0'; settle() })`,
    }
    default: throw new Error(`unknown case ${caseId}`)
  }
}

/** Rendered bytes are identical across truth variants for one case. */
export function renderFixture(caseId) {
  const fixture = fixtureBody(caseId)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(fixture.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 32px; font: 16px/1.4 system-ui, sans-serif; color: #171717; }
    main { max-width: 760px; }
    label, article, li { display: block; margin: 12px 0; }
    input, button, a { font: inherit; margin: 4px; }
    [hidden] { display: none !important; }
    .backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.35); }
    #dialog { position: fixed; z-index: 30; left: 260px; top: 150px; width: 380px; min-height: 190px; padding: 28px; background: white; border: 2px solid #222; }
    #close { position: absolute; right: 24px; bottom: 20px; }
    .close-cover { position: fixed; z-index: 40; left: 512px; top: 278px; width: 116px; height: 48px; background: rgba(190,20,20,.25); }
  </style>
</head>
<body>
${fixture.body}
<script>
  const byId = id => document.getElementById(id)
  const runId = location.pathname.split('/').filter(Boolean).at(-1)
  window.__pilotActionSettled = false
  const settle = () => { window.__pilotActionSettled = true; document.dispatchEvent(new Event('pilot-action-settled')) }
  const addItem = (id, text) => { const item = document.createElement('li'); item.textContent = text; byId(id).appendChild(item) }
  const effect = async () => {
    const response = await fetch('/effect/' + encodeURIComponent(runId), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })
    if (!response.ok) throw new Error('controlled action failed')
    return response.json()
  }
  ${fixture.script}
</script>
</body>
</html>`
}

export async function performPlaywrightAction(page, caseId) {
  switch (caseId) {
    case 'T1': await page.getByLabel('New todo').fill('Pilot alpha'); await page.getByLabel('New todo').press('Enter'); break
    case 'T2': await page.getByLabel('Pilot alpha').click(); break
    case 'T3': await page.getByRole('link', { name: 'Active', exact: true }).click(); break
    case 'T4': await page.getByRole('button', { name: 'Delete Pilot alpha', exact: true }).click(); break
    case 'S1':
      await page.getByLabel('Username').fill('standard_user')
      await page.getByLabel('Password').fill('public_test_password')
      await page.getByRole('button', { name: 'Login', exact: true }).click()
      break
    case 'S2': await page.getByRole('button', { name: 'Add Backpack to cart', exact: true }).click(); break
    case 'S3': await page.getByRole('button', { name: 'Remove Backpack from cart', exact: true }).click(); break
    case 'I1': await page.getByRole('button', { name: 'Remove', exact: true }).click(); break
    case 'I2': await page.getByRole('button', { name: 'Enable', exact: true }).click(); break
    case 'I3': await page.getByRole('button', { name: 'Start', exact: true }).click(); break
    case 'B1': await page.getByRole('button', { name: 'Launch demo modal', exact: true }).click(); break
    case 'B2': await page.getByRole('button', { name: 'Close modal', exact: true }).click(); break
    default: throw new Error(`unknown case ${caseId}`)
  }
  await page.waitForFunction(() => window.__pilotActionSettled === true, null, { timeout: 2_000 })
}

export async function readPrimitiveState(page, caseId) {
  return page.evaluate((id) => {
    const visible = (element) => {
      if (!element || !element.isConnected || element.hidden) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const covered = (element) => {
      if (!visible(element)) return false
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return !hit || !(hit === element || element.contains(hit))
    }
    const textList = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((element) => element.textContent.trim())
    if (id === 'T1') return { items: textList('#todos li'), status: document.querySelector('#status').textContent.trim() }
    if (id === 'T2') return { targetChecked: document.querySelector('#target').checked, neighborChecked: document.querySelector('#neighbor').checked }
    if (id === 'T3') return { hash: location.hash, visibleItems: textList('#todos li') }
    if (id === 'T4') return { items: textList('#todos li').map((text) => text.replace(/Delete .+$/, '').trim()) }
    if (id === 'S1') return { inventoryVisible: visible(document.querySelector('#inventory')), loginVisible: visible(document.querySelector('#login-form')), errorVisible: visible(document.querySelector('#error')) }
    if (id === 'S2') return {
      backpackInCart: document.querySelector('#add-backpack').textContent.startsWith('Remove'),
      bikeInCart: document.querySelector('#add-bike').textContent.startsWith('Remove'),
      badge: visible(document.querySelector('#badge')) ? Number(document.querySelector('#badge').textContent) : 0,
    }
    if (id === 'S3') return { cartItems: textList('#cart h2'), badge: Number(document.querySelector('#badge').textContent) }
    if (id === 'I1') return { checkboxPresent: !!document.querySelector('#dynamic-checkbox'), button: document.querySelector('#toggle').textContent.trim(), message: document.querySelector('#message').textContent.trim() }
    if (id === 'I2') return { disabled: document.querySelector('#editable').disabled, button: document.querySelector('#enable').textContent.trim(), message: document.querySelector('#message').textContent.trim() }
    if (id === 'I3') return { helloVisible: textList('#finish h2').includes('Hello World!'), loaderVisible: visible(document.querySelector('#loader')) }
    if (id === 'B1') return { dialogVisible: visible(document.querySelector('#dialog')), closeCovered: covered(document.querySelector('#close')), launcherCovered: covered(document.querySelector('#launch')) }
    if (id === 'B2') return { dialogVisible: visible(document.querySelector('#dialog')), backdropVisible: visible(document.querySelector('#backdrop')), launcherCovered: covered(document.querySelector('#launch')) }
    throw new Error('unknown controlled case')
  }, caseId)
}
