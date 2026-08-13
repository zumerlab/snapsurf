/* global chrome */

const CHANNEL = 'snapdom-companion-v1'
const INTERNAL_CHANNEL = 'snapdom-companion-internal-v1'
const POLICY_PREFIX = 'privacy:'
const queues = new Map()

// `privacy:null` is the one explicit clear operation. Any other malformed shape must
// leave the sticky policy untouched: treating a typo as null silently exposed the next
// observation. Empty strings are ignored, but an update with no effective rules is
// rejected (use null when clearing is actually intended).
function normalizePolicyUpdate(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'redact') || !Array.isArray(value.redact) ||
      value.redact.some((rule) => typeof rule !== 'string')) {
    throw new Error('invalid privacy policy: expected {redact: string[]} or null')
  }
  const redact = value.redact.map((rule) => rule.trim()).filter(Boolean)
  if (!redact.length) {
    throw new Error('invalid privacy policy: redact needs a non-empty string (use null to clear)')
  }
  return { redact }
}

async function readPolicy(tabId) {
  const key = POLICY_PREFIX + tabId
  const stored = await chrome.storage.session.get(key)
  const value = stored[key]
  return value === undefined ? null : normalizePolicyUpdate(value)
}

async function writePolicy(tabId, policy) {
  const key = POLICY_PREFIX + tabId
  if (policy) await chrome.storage.session.set({ [key]: policy })
  else await chrome.storage.session.remove(key)
}

function enqueue(tabId, operation) {
  const prior = queues.get(tabId) || Promise.resolve()
  const next = prior.catch(() => {}).then(operation)
  queues.set(tabId, next)
  const cleanup = () => { if (queues.get(tabId) === next) queues.delete(tabId) }
  // Avoid the unobserved rejected promise that Promise.prototype.finally creates.
  void next.then(cleanup, cleanup)
  return next
}

async function handleExternal(message) {
  if (!message || message.channel !== CHANNEL) return undefined
  const tabId = Number(message.tabId)
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { type: 'SNAPDOM_DIGEST_READY', obsId: message.request?.obsId ?? null, error: 'tabId must be a non-negative integer' }
  }
  const request = message.request || {}
  return enqueue(tabId, async () => {
    // Only an allowlisted extension can reach this handler. The policy update is
    // applied before the request and persisted outside the page/DOM. Requests that
    // omit privacy inherit it; explicit null is an authenticated clear operation.
    // An explicit update is validated before storage is touched. In particular, an
    // invalid update can neither clear a good policy nor reach the content script.
    let policy
    if (Object.prototype.hasOwnProperty.call(request, 'privacy')) {
      policy = normalizePolicyUpdate(request.privacy)
      await writePolicy(tabId, policy)
    } else {
      policy = await readPolicy(tabId)
    }
    const result = await chrome.tabs.sendMessage(tabId, {
      channel: INTERNAL_CHANNEL,
      request,
      policy,
    }, { frameId: 0 })
    return { type: 'SNAPDOM_DIGEST_READY', obsId: request.obsId ?? request.token ?? null, result }
  })
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // `externally_connectable.ids` rejects every unlisted extension before this runs.
  // Web pages are not listed under `matches`, so they cannot call this API at all.
  if (!message || message.channel !== CHANNEL) return false
  handleExternal(message, sender).then(sendResponse, (err) => sendResponse({
    type: 'SNAPDOM_DIGEST_READY',
    obsId: message.request?.obsId ?? null,
    error: String(err),
  }))
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  queues.delete(tabId)
  chrome.storage.session.remove(POLICY_PREFIX + tabId)
})
