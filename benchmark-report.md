# Agent benchmark report

Superseded twice on 2026-07-30 — first version measured only its own 3 manual cases and
missed that the privacy layer leaked through the change report. After the fix
(`applyDiffPrivacy`): full suite 43/43 passing (api 10, plugin 5, corpus 20, manual 3,
privacy-probe 5). Privacy overhead at 601 nodes: none measurable (inspect p50 14.1 ms
with rules vs 14.5 ms without; off = early return).

Synthetic scaling (chromium, `test/bench.test.js`): walk p50 1.2 / 3.4 / 6.3 ms and
inspect p50 2.5 / 6.4 / 16.1 ms at 61 / 241 / 601 nodes.

Real-site numbers and the screenshot-judged comparison live in FIELD.md (visual field
pass section).

Reproduce:

```bash
npx vitest run packages/agent/test --exclude '**/bench.test.js' --browser.headless
npx vitest run packages/agent/test/bench.test.js --browser.headless
```
