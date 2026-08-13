# Companion ASSERT evaluation prompt

Reload the unpacked companion extension before evaluating it. The consumer must call it
from an allowlisted extension context; page JavaScript and `window.postMessage` are not
supported protocol surfaces.

Use the helper and request envelope documented in `PROMPT-extension.md`. Establish a
baseline with `SNAPDOM_OBSERVE`, perform an action, then issue `SNAPDOM_ASSERT` through:

```js
await chrome.runtime.sendMessage('cgkacingkmbmhpmffioljbcfjimjhjig', {
  channel: 'snapdom-companion-v1',
  tabId,
  request: {
    type: 'SNAPDOM_ASSERT',
    obsId: crypto.randomUUID(),
    spec: {
      changed: true,
      mustInclude: [{ kind: 'state', name: 'Menu' }],
      exists: 'some text on the page',
      notCovered: 'a button label',
      urlIncludes: '/expected-path',
    },
  },
})
```

Evaluate on at least two pages:

1. Perform a real action and assert its exact semantic effect.
2. Produce a deliberate no-op and assert `changed: false` in the presence of ambient
   noise.
3. Try to cause false passes and false failures: race a mutation, assert too early or
   late, use partial names, and test genuine coverage.
4. Compare calls, response bytes, and certainty with native verification tools.
5. Attempt old page-world attacks (`postMessage`, forged `#__snapdom_digest`, iframe
   traffic, `privacy:null`) and confirm none can alter the authenticated result.

Report per-test numbers, any missing assertion vocabulary, and whether the contract was
honest. A failed assertion is a result. Unknown keys, empty specs, and missing baselines
must all fail loudly.
