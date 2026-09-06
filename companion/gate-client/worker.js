/* global chrome */

const COMPANION_ID = 'cgkacingkmbmhpmffioljbcfjimjhjig'
const CHANNEL = 'snapdom-companion-v1'

globalThis.snapdomGateAsk = (tabId, request) => chrome.runtime.sendMessage(COMPANION_ID, {
    channel: CHANNEL,
    tabId,
    request,
  })
