import { Buffer } from 'node:buffer'
import { expect } from 'playwright/test'

const TIMEOUT_MS = 600
const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

const errorEvidence = (error) => ({
  name: error?.name || 'Error',
  message: String(error?.message || error).slice(0, 6_000),
  matcherResult: error?.matcherResult ? {
    name: error.matcherResult.name,
    pass: error.matcherResult.pass,
    expected: error.matcherResult.expected,
    actual: error.matcherResult.actual,
  } : undefined,
})

async function playwrightCheck(id, statement, run) {
  let succeeded = false
  let diagnostic = null
  const started = performance.now()
  try {
    await run()
    succeeded = true
  } catch (error) {
    if (!isSemanticAssertion(error)) throw error
    diagnostic = errorEvidence(error)
  }
  return {
    id, statement, pass: succeeded,
    observed: succeeded ? 'assertion-satisfied' : 'assertion-rejected',
    expectedObservation: 'success',
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    diagnostic,
  }
}

function isSemanticAssertion(error) {
  return !!error?.matcherResult || error?.name === 'AssertionError'
}

const playwrightDefinitions = {
  T1: (page) => [
    ['target-added', 'Pilot alpha is present exactly once.', () => expect(page.getByText('Pilot alpha', { exact: true })).toHaveCount(1, { timeout: TIMEOUT_MS })],
    ['count-plus-one', 'The todo count changes from one to two.', () => expect(page.locator('#todos li')).toHaveCount(2, { timeout: TIMEOUT_MS })],
    ['no-draft-only', 'The action did not merely save a draft/status.', () => expect(page.locator('#status')).toHaveText('Ready', { timeout: TIMEOUT_MS })],
  ],
  T2: (page) => [
    ['target-completed', 'Pilot alpha changes from incomplete to complete.', () => expect(page.getByLabel('Pilot alpha')).toBeChecked({ timeout: TIMEOUT_MS })],
    ['neighbor-stable', 'Neighbor beta remains incomplete.', () => expect(page.getByLabel('Neighbor beta')).not.toBeChecked({ timeout: TIMEOUT_MS })],
  ],
  T3: (page) => [
    ['active-route', 'The route becomes #/active.', () => expect(page).toHaveURL(/#\/active$/, { timeout: TIMEOUT_MS })],
    ['active-visible', 'Active item remains visible.', () => expect(page.getByText('Active item', { exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['completed-absent', 'Completed item is absent from the rendered list.', () => expect(page.getByText('Completed item', { exact: true })).toHaveCount(0, { timeout: TIMEOUT_MS })],
  ],
  T4: (page) => [
    ['target-removed', 'Pilot alpha is absent.', () => expect(page.getByText('Pilot alpha', { exact: false })).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['neighbor-present', 'Neighbor beta remains present.', () => expect(page.getByText('Neighbor beta', { exact: false })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['count-minus-one', 'The todo count changes from two to one.', () => expect(page.locator('#todos li')).toHaveCount(1, { timeout: TIMEOUT_MS })],
  ],
  S1: (page) => [
    ['inventory-visible', 'Products inventory is visible.', () => expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['login-absent', 'The login form is absent.', () => expect(page.locator('#login-form')).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['error-absent', 'No login error is shown.', () => expect(page.locator('#error')).toHaveCount(0, { timeout: TIMEOUT_MS })],
  ],
  S2: (page) => [
    ['target-button-transition', 'Backpack control changes to Remove Backpack from cart.', () => expect(page.locator('#add-backpack')).toHaveText('Remove Backpack from cart', { timeout: TIMEOUT_MS })],
    ['neighbor-stable', 'Bike Light remains not in the cart.', () => expect(page.locator('#add-bike')).toHaveText('Add Bike Light to cart', { timeout: TIMEOUT_MS })],
    ['badge-one', 'The cart badge becomes one.', () => expect(page.locator('#badge')).toHaveText('1', { timeout: TIMEOUT_MS })],
  ],
  S3: (page) => [
    ['target-removed', 'Backpack is absent from the cart.', () => expect(page.getByRole('heading', { name: 'Backpack', exact: true })).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['neighbor-present', 'Bike Light remains in the cart.', () => expect(page.getByRole('heading', { name: 'Bike Light', exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['badge-one', 'The cart badge changes from two to one.', () => expect(page.locator('#badge')).toHaveText('1', { timeout: TIMEOUT_MS })],
  ],
  I1: (page) => [
    ['checkbox-absent', 'Dynamic checkbox is absent.', () => expect(page.locator('#dynamic-checkbox')).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['add-visible', 'Add button is visible.', () => expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['gone-message', "It's gone! is visible.", () => expect(page.getByText("It's gone!", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
  ],
  I2: (page) => [
    ['textbox-enabled', 'Editable field changes from disabled to enabled.', () => expect(page.getByLabel('Editable field')).toBeEnabled({ timeout: TIMEOUT_MS })],
    ['disable-visible', 'Disable button is visible.', () => expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['enabled-message', "It's enabled! is visible.", () => expect(page.getByText("It's enabled!", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
  ],
  I3: (page) => [
    ['hello-visible', 'Hello World! is added and visible.', () => expect(page.getByText('Hello World!', { exact: true })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['loader-absent', 'Loading indicator is absent after completion.', () => expect(page.locator('#loader')).toBeHidden({ timeout: TIMEOUT_MS })],
  ],
  B1: (page) => [
    ['dialog-visible', 'Verification modal is visible.', () => expect(page.getByRole('dialog', { name: 'Verification modal' })).toBeVisible({ timeout: TIMEOUT_MS })],
    ['close-actionable', 'Close modal is not geometrically covered.', () => expectUncovered(page.getByRole('button', { name: 'Close modal', exact: true }))],
    ['launcher-covered', 'The backdrop covers the launcher.', () => expectCovered(page.getByRole('button', { name: 'Launch demo modal', exact: true }))],
  ],
  B2: (page) => [
    ['dialog-absent', 'Verification modal is absent.', () => expect(page.getByRole('dialog', { name: 'Verification modal' })).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['backdrop-absent', 'Modal backdrop is absent.', () => expect(page.locator('#backdrop')).toHaveCount(0, { timeout: TIMEOUT_MS })],
    ['launcher-actionable', 'Launch demo modal is actionable again.', () => expectUncovered(page.getByRole('button', { name: 'Launch demo modal', exact: true }))],
  ],
}

export async function verifyWithPlaywright(page, caseId) {
  const define = playwrightDefinitions[caseId]
  if (!define) throw new Error(`missing Playwright verifier for ${caseId}`)
  const definitions = define(page)
  const started = performance.now()
  const checks = []
  for (const [id, statement, run] of definitions) {
    checks.push(await playwrightCheck(id, statement, run))
  }
  const snapshot = await page.locator('body').ariaSnapshot().catch((error) => `ARIA_SNAPSHOT_ERROR: ${error.message || error}`)
  const evidence = { checks, ariaSnapshot: snapshot }
  return {
    verdict: checks.every((entry) => entry.pass) ? 'PASS' : 'FAIL',
    checks,
    evidence,
    evidenceBytes: bytes(evidence),
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    route: 'playwright-authored-assertions',
  }
}

async function hitState(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if (!element.isConnected || element.hidden || style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
      return { visible: false, covered: true }
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { visible: true, covered: !hit || !(hit === element || element.contains(hit)) }
  }, { timeout: TIMEOUT_MS })
}

async function expectUncovered(locator) {
  expect(await hitState(locator)).toEqual({ visible: true, covered: false })
}

async function expectCovered(locator) {
  expect(await hitState(locator)).toEqual({ visible: true, covered: true })
}

export async function establishSnapdomBaseline(page) {
  await page.evaluate(() => {
    const observation = window.__agentObserve(document.documentElement)
    const ui = window.__agentBuildUi(observation, {})
    window.__multisitePilotBaseline = ui.checkpoint()
  })
}

export async function verifyWithSnapdom(page, caseId) {
  const started = performance.now()
  const evidence = await page.evaluate(() => {
    const previous = window.__multisitePilotBaseline
    if (!previous) throw new Error('SnapDOM pilot baseline missing')
    const observation = window.__agentObserve(document.documentElement, { previous })
    const ui = window.__agentBuildUi(observation, {})
    const view = ui.__view || ui.__snapshot
    const nodes = view.order.map((id) => view.nodes.get(id)).filter(Boolean).map((node) => ({
      id: node.id,
      role: node.role,
      name: node.name || '',
      text: node.text || '',
      visible: node.visible !== false,
      covered: !!node.covered,
      state: node.state || {},
    }))
    return {
      changed: ui.changed,
      torn: observation.torn || 0,
      unobservable: ui.unobservable || [],
      changes: (ui.changes || []).map((change) => ({
        kind: change.kind,
        role: change.role,
        name: change.name,
        beforeName: change.beforeName,
        from: change.before,
        to: change.after,
      })),
      actionabilityDelta: ui.actionabilityDelta || { becameCovered: [], becameVisible: [] },
      nodes,
      urlHash: location.hash,
    }
  })
  const checks = snapdomChecks(caseId, evidence)
  const uncertain = evidence.torn > 0 || evidence.unobservable.length > 0
  // This pilot does not try to prove that an opaque region is irrelevant to a failed
  // conjunct. Conservatively abstain whenever the observation carries uncertainty.
  const verdict = uncertain ? 'UNKNOWN' : (checks.every((entry) => entry.pass) ? 'PASS' : 'FAIL')
  const packet = { checks, diff: evidence }
  return {
    verdict,
    checks,
    evidence: packet,
    evidenceBytes: bytes(packet),
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    route: 'snapdom-typed-diff',
  }
}

function snapdomChecks(caseId, evidence) {
  const allCurrent = (text, role) => evidence.nodes.filter((node) => (!role || node.role === role) &&
    [node.name, node.text].some((value) => normalize(value) === normalize(text)))
  const visible = evidence.nodes.filter((node) => node.visible)
  const current = (text, role) => visible.filter((node) => (!role || node.role === role) &&
    [node.name, node.text].some((value) => normalize(value) === normalize(text)))
  const contains = (text, role) => visible.filter((node) => (!role || node.role === role) &&
    [node.name, node.text].some((value) => normalize(value).includes(normalize(text))))
  const changed = (predicate) => evidence.changes.some(predicate)
  const transition = (before, after, role) => changed((entry) =>
    (!role || entry.role === role) && normalize(entry.beforeName) === normalize(before) &&
    normalize(entry.name) === normalize(after))
  const delta = (kind, text) => (evidence.actionabilityDelta[kind] || [])
    .some((entry) => normalize(entry.name || entry.role).includes(normalize(text)))
  const check = (id, statement, pass, actual) => ({ id, statement, pass: !!pass, actual })

  if (caseId === 'T1') return [
    check('target-added', 'Pilot alpha is present exactly once.', current('Pilot alpha', 'listitem').length === 1 && changed((entry) => entry.kind === 'added' && normalize(entry.name).includes('pilot alpha')), summarize(evidence, 'Pilot alpha')),
    check('count-plus-one', 'The todo count changes from one to two.', visible.filter((node) => node.role === 'listitem').length === 2, `${visible.filter((node) => node.role === 'listitem').length} listitems`),
    check('no-draft-only', 'The action did not merely save a draft/status.', !contains('Draft saved').length && contains('Ready').length > 0, summarize(evidence, 'Draft saved')),
  ]
  if (caseId === 'T2') return [
    check('target-completed', 'Pilot alpha changes from incomplete to complete.', changed((entry) => entry.kind === 'state' && normalize(entry.name).includes('pilot alpha') && entry.to?.checked === true), summarize(evidence, 'Pilot alpha')),
    check('neighbor-stable', 'Neighbor beta remains incomplete.', !changed((entry) => entry.kind === 'state' && normalize(entry.name).includes('neighbor beta')) && current('Neighbor beta', 'checkbox').some((node) => node.state.checked !== true), summarize(evidence, 'Neighbor beta')),
  ]
  if (caseId === 'T3') return [
    check('active-route', 'The route becomes #/active.', evidence.urlHash === '#/active', evidence.urlHash),
    check('active-visible', 'Active item remains visible.', current('Active item', 'listitem').length === 1, summarize(evidence, 'Active item')),
    check('completed-absent', 'Completed item is absent from the rendered list.', current('Completed item', 'listitem').length === 0, summarize(evidence, 'Completed item')),
  ]
  if (caseId === 'T4') return [
    check('target-removed', 'Pilot alpha is absent.', !contains('Pilot alpha').length && changed((entry) => entry.kind === 'removed' && normalize(entry.name).includes('pilot alpha')), summarize(evidence, 'Pilot alpha')),
    check('neighbor-present', 'Neighbor beta remains present.', contains('Neighbor beta').length > 0 && !changed((entry) => entry.kind === 'removed' && normalize(entry.name).includes('neighbor beta')), summarize(evidence, 'Neighbor beta')),
    check('count-minus-one', 'The todo count changes from two to one.', visible.filter((node) => node.role === 'listitem').length === 1, `${visible.filter((node) => node.role === 'listitem').length} listitems`),
  ]
  if (caseId === 'S1') return [
    check('inventory-visible', 'Products inventory is visible.', current('Products', 'heading').length > 0, summarize(evidence, 'Products')),
    check('login-absent', 'The login form is absent.', allCurrent('Username', 'textbox').length === 0 && allCurrent('Password', 'textbox').length === 0, summarize(evidence, 'Username')),
    check('error-absent', 'No login error is shown.', allCurrent('Invalid login').length === 0, summarize(evidence, 'Invalid login')),
  ]
  if (caseId === 'S2') return [
    check('target-button-transition', 'Backpack control changes to Remove Backpack from cart.', current('Remove Backpack from cart', 'button').length === 1 && transition('Add Backpack to cart', 'Remove Backpack from cart', 'button'), summarize(evidence, 'Backpack')),
    check('neighbor-stable', 'Bike Light remains not in the cart.', current('Add Bike Light to cart', 'button').length === 1 && !changed((entry) => normalize(entry.name).includes('bike light')), summarize(evidence, 'Bike Light')),
    check('badge-one', 'The cart badge becomes one.', current('1').length > 0, summarize(evidence, '1')),
  ]
  if (caseId === 'S3') return [
    check('target-removed', 'Backpack is absent from the cart.', current('Backpack', 'heading').length === 0 && (changed((entry) => entry.kind === 'removed' && normalize(entry.name).includes('backpack')) || changed((entry) => normalize(entry.beforeName).includes('backpack'))), summarize(evidence, 'Backpack')),
    // The remaining sibling can be aligned as a possible replacement after a preceding
    // row is deleted. Final exact presence is authoritative for this conjunct; the raw
    // diff remains in the packet so the identity ambiguity is auditable.
    check('neighbor-present', 'Bike Light remains in the cart.', current('Bike Light', 'heading').length === 1, summarize(evidence, 'Bike Light')),
    check('badge-one', 'The cart badge changes from two to one.', current('1').length > 0, summarize(evidence, '1')),
  ]
  if (caseId === 'I1') return [
    check('checkbox-absent', 'Dynamic checkbox is absent.', visible.filter((node) => node.role === 'checkbox').length === 0 && changed((entry) => entry.kind === 'removed' && entry.role === 'checkbox'), `${visible.filter((node) => node.role === 'checkbox').length} checkboxes`),
    check('add-visible', 'Add button is visible.', current('Add', 'button').some((node) => !node.covered), summarize(evidence, 'Add')),
    check('gone-message', "It's gone! is visible.", contains("It's gone!").length > 0, summarize(evidence, "It's gone!")),
  ]
  if (caseId === 'I2') return [
    check('textbox-enabled', 'Editable field changes from disabled to enabled.', changed((entry) => entry.kind === 'state' && entry.role === 'textbox' && entry.to?.disabled === false) && current('Editable field', 'textbox').some((node) => node.state.disabled !== true), summarize(evidence, 'Editable field')),
    check('disable-visible', 'Disable button is visible.', current('Disable', 'button').length > 0, summarize(evidence, 'Disable')),
    check('enabled-message', "It's enabled! is visible.", contains("It's enabled!").length > 0, summarize(evidence, "It's enabled!")),
  ]
  if (caseId === 'I3') return [
    check('hello-visible', 'Hello World! is added and visible.', current('Hello World!', 'heading').length > 0 && changed((entry) => entry.kind === 'added' && normalize(entry.name).includes('hello world')), summarize(evidence, 'Hello World!')),
    check('loader-absent', 'Loading indicator is absent after completion.', current('Loading…').length === 0, summarize(evidence, 'Loading')),
  ]
  if (caseId === 'B1') return [
    check('dialog-visible', 'Verification modal is visible.', current('Verification modal', 'dialog').length > 0, summarize(evidence, 'Verification modal')),
    check('close-actionable', 'Close modal is not geometrically covered.', current('Close modal', 'button').some((node) => !node.covered), summarize(evidence, 'Close modal')),
    check('launcher-covered', 'The backdrop covers the launcher.', current('Launch demo modal', 'button').some((node) => node.covered) || delta('becameCovered', 'Launch demo modal'), summarize(evidence, 'Launch demo modal')),
  ]
  if (caseId === 'B2') return [
    check('dialog-absent', 'Verification modal is absent.', allCurrent('Verification modal', 'dialog').length === 0, summarize(evidence, 'Verification modal')),
    check('backdrop-absent', 'Modal backdrop is absent.', allCurrent('Modal backdrop').length === 0, summarize(evidence, 'Modal backdrop')),
    check('launcher-actionable', 'Launch demo modal is actionable again.', current('Launch demo modal', 'button').some((node) => !node.covered) || delta('becameVisible', 'Launch demo modal'), summarize(evidence, 'Launch demo modal')),
  ]
  throw new Error(`missing SnapDOM verifier for ${caseId}`)
}

function summarize(evidence, text) {
  const needle = normalize(text)
  return {
    matchingNodes: evidence.nodes.filter((node) => [node.name, node.text].some((value) => normalize(value).includes(needle))).slice(0, 8),
    matchingChanges: evidence.changes.filter((change) => [change.name, change.beforeName].some((value) => normalize(value).includes(needle))).slice(0, 8),
  }
}
