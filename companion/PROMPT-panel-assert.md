# Prompt for the Claude extension panel — SNAPDOM_ASSERT round (copy-paste)

(User: reload the companion FIRST — chrome://extensions → ⟳ — or this round will
test a stale bundle again.)

---

The snapDOM companion in this Chrome gained an ASSERT protocol since your last
round — deterministic QA checks built on the semantic diff, in the page. Your
previous reports shaped it (structured results, faithful negatives, verified
selectors), so this round you evaluate it as its most demanding reviewer.

Protocol (same ready/obsId handshake you already use):

```js
const obsId = Date.now();
const ready = new Promise(r => {
  const h = e => { if (e.data && e.data.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) { removeEventListener('message', h); r(); } };
  addEventListener('message', h); setTimeout(r, 2500);
});
window.postMessage({ type: 'SNAPDOM_ASSERT', obsId, spec: {
  changed: true,                                   // or false — "my action did nothing" is assertable
  mustInclude: [{ kind: 'state', name: 'Menú' }],  // kinds: added/removed/content/state/style/moved/resized
  exists: 'some text on the page',
  notCovered: 'a button label',
  urlIncludes: '/wiki/'
}}, '*');
await ready;
JSON.parse(document.getElementById('__snapdom_digest').textContent)
// → { type:'assert', pass, walkMs, checks:[{type, expected, actual, pass}] }
```

Notes: a failed assertion is a structured RESULT, not an error. The assert consumes
the diff baseline (like an observe): one message covers act → assert. First message
on a fresh page needs a prior SNAPDOM_OBSERVE to establish the baseline.

Your round, on real sites of your choice (at least two, e.g. wikipedia + lanacion):

1. **Exact-effect assertion**: perform a real action (open a menu, expand a section)
   and assert its precise semantic effect with mustInclude kind+name. Verify the
   checks report honestly.
2. **The faithful negative as an assertion**: find a real no-op (or make your click
   miss on purpose, as happened to you with the eBay scaled coordinates) and assert
   changed:false — while the page carries real ambient noise.
3. **Try to produce a FALSE PASS or FALSE FAIL**: ambient mutations racing your
   assert, asserting too early/late, mustInclude with names that half-match,
   notCovered on something genuinely covered. Adversarial, like your selector audit.
4. Compare against how you would verify the same things with your native tools
   (calls, bytes, certainty).

Report back: per-test results with real numbers, the vocabulary's gaps (what
assertion did you WANT that the spec cannot express?), any contract inconsistency
between this prompt and observed behavior, and your verdict: would an agent-QA flow
in this browser rely on SNAPDOM_ASSERT as its primary check? No sugar-coating —
your previous rounds were valuable precisely because they weren't gentle.
