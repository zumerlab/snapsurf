# Local MCP value probe

Status: empirical local observation, not a general product claim  
Run: 2026-08-12T04:38:10.375Z to 2026-08-12T04:38:58.049Z  
Repetitions: 3; trials: 72

All three arms matched the frozen expected-truth manifest in 72/72 trials: 0 false greens, 0 false negatives, and 0 UNKNOWN verdicts. This is equal correctness on four authored local cases, not evidence of general accuracy.

## Outcome

| Arm (same 24-trial set) | Correct | False green | False negative | Unknown | Median verify rounds | Median action+verify rounds | Median full-flow rounds | Median verify effective B | Median action+verify effective B | Median full-flow effective B | Median verify ms | Median full-flow ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| playwright-out-of-box | 24/24 | 0 | 0 | 0 | 1.5 | 2.5 | 3.5 | 558.5 | 1497.5 | 2557.5 | 5.6 | 195.1 |
| snapdom-direct | 24/24 | 0 | 0 | 0 | 1 | 2 | 3 | 2660 | 3359 | 5288 | 17 | 556.9 |
| playwright-custom-evaluate | 24/24 | 0 | 0 | 0 | 1 | 2 | 3 | 1206 | 2037.5 | 3330.5 | 55.5 | 252 |

## Case breakdown

Rounds are shown as `correct / near-miss`; this exposes short-circuit behavior instead of pooling it away.

| Case | Arm / route | Correct | Verify rounds (correct / near) | Full-flow rounds (correct / near) | Median verify effective B | Median full-flow effective B | Median verify ms | Median full-flow ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| checkbox-target | playwright-out-of-box / direct-testing-tools | 6/6 | 2 / 1 | 4 / 3 | 558.5 | 2557.5 | 5.8 | 341.8 |
| add-exact-item | playwright-out-of-box / direct-testing-plus-wait-tool | 6/6 | 2 / 1 | 4 / 3 | 695.5 | 2369.5 | 3.7 | 186.3 |
| modal-actionable | playwright-out-of-box / direct-testing-plus-built-in-hover-actionability-probe | 6/6 | 2 / 2 | 4 / 4 | 1840.5 | 3758 | 627.8 | 803.4 |
| semantic-no-op | playwright-out-of-box / mechanical-automatic-action-snapshot-comparison | 6/6 | 0 / 0 | 2 / 2 | 0 | 1648.5 | 0 | 181.3 |
| checkbox-target | snapdom-direct / direct-browser-assert | 6/6 | 1 / 1 | 3 / 3 | 2435.5 | 5282.5 | 20.3 | 872.9 |
| add-exact-item | snapdom-direct / direct-browser-assert | 6/6 | 1 / 1 | 3 / 3 | 3440 | 5845 | 15.9 | 552.2 |
| modal-actionable | snapdom-direct / direct-browser-assert | 6/6 | 1 / 1 | 3 / 3 | 3109 | 5520.5 | 20.4 | 556.9 |
| semantic-no-op | snapdom-direct / direct-browser-assert | 6/6 | 1 / 1 | 3 / 3 | 1089 | 3498 | 15.2 | 553 |
| checkbox-target | playwright-custom-evaluate / custom-browser-evaluate | 6/6 | 1 / 1 | 3 / 3 | 890 | 2889 | 54.7 | 383.6 |
| add-exact-item | playwright-custom-evaluate / custom-browser-evaluate | 6/6 | 1 / 1 | 3 / 3 | 928 | 2601 | 56 | 249.9 |
| modal-actionable | playwright-custom-evaluate / custom-browser-evaluate | 6/6 | 1 / 1 | 3 / 3 | 1859.5 | 3777 | 55.1 | 248 |
| semantic-no-op | playwright-custom-evaluate / custom-browser-evaluate | 6/6 | 1 / 1 | 4 / 4 | 1484.5 | 4345 | 56.1 | 289.3 |

## Cold schema cost

| Server | Tools | initialize + tools/list request/response bytes | Including initialized notification | tools/list response bytes |
|---|---:|---:|---:|---:|
| playwrightMcp | 29 | 22204 | 22271 | 21806 |
| snapdomMcp | 13 | 14351 | 14418 | 13968 |

## Interpretation boundary

SnapDOM provided one declarative `browser_assert` verification round for every case. Playwright out of the box used zero to two post-action rounds depending on the predicate, and arbitrary `browser_evaluate` used one custom round. The direct Playwright routes were usually smaller; custom evaluation was also smaller here but required case-authored JavaScript. SnapDOM returned the typed before/after checks and diff automatically.

Two endpoints show why there is no global winner in this probe. For the covered modal near miss, SnapDOM used one direct assertion at about 20 ms while Playwright's built-in hover actionability probe used two rounds at about 1.2 seconds; custom evaluation used one round at about 55 ms. For semantic no-op, Playwright mechanically compared the snapshots already returned by navigation and action with zero additional MCP rounds and about 751–770 effective action-plus-verification bytes, while SnapDOM used one assertion round and about 1,669–1,911 bytes.

Full flow starts with navigation or `browser_open` and includes setup, action, verification, and linked-artifact reads. SnapDOM reuses the action target already returned by `browser_open`; Playwright reuses the ref from navigation. The custom no-op baseline evaluation counts as setup. Package/browser installation, MCP startup, and expected-truth polling remain outside this timing.

The SnapDOM schema was smaller than the Playwright MCP schema, but SnapDOM is currently an additional layer alongside Playwright; a client loading both schemas pays both costs rather than replacing one with the other.

This run compares deterministic MCP surfaces without a model. The “oracle” is a frozen server-side expected-truth manifest activated by an action ping; it does not observe the DOM. The probe can show direct expressibility and exact protocol cost for these pinned fixtures. It cannot establish model task success, token cost, web-wide accuracy, a false-green population rate, or population-level latency.

Playwright automatic snapshots were linked `.yml` artifacts in this version. The runner validates every path under its temporary artifact root, hashes and reads it mechanically, and reports artifact bytes separately from JSON-RPC bytes and in an effective total.

Isolation and cleanup gates passed: local fixture only, explicit temporary Chromium for Playwright MCP, isolated in-memory profiles, OS-assigned SnapDOM ports excluding 8377, clean MCP exits, closed fixture and daemon ports, and verified temporary-root deletion. No personal Chrome profile, tab, cookie, session, history, password, or extension was accessed.

Fixture SHA-256: `445294ed1ed85ae789e05b81a4918d968b50835f7c2def0ba00161c3e7de6bc0`. Raw requests, responses, oracle state, and per-trial timings are in the sibling JSON file.
