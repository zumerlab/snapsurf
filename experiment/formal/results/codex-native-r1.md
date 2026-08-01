# Formal benchmark — Codex native r1

Native stack: a temporary Playwright helper under `/tmp`. I did not use
`browse.mjs`, SnapDOM MCP, the companion extension, or product code under
`packages/agent/*`.

| Task | Method | Actions | Wall ms | Outcome |
| --- | --- | ---: | ---: | --- |
| T1 HN | rendered DOM | 1 | 798 | claimed pass |
| T2 GitHub version | UI links → Raw JSON | 3 | 17.280 | claimed pass after 2 dead ends |
| T3 Wikipedia deep link | accessible link click | 3 | 60.816 | claimed pass after 2 timeouts |
| T4 npm downloads | browser → public API fallback | 3 | 2.553 | claimed pass; page blocked by Cloudflare |
| T5 eBay first | search + rendered link inspection | 3 | 21.200 | claimed pass after markup/ranking diagnosis |
| T6 Python docs | two link navigations + signature | 4 | 62.060 | claimed pass after 3 dead ends |
| T7 partido | rendered table rows | 2 | 30.678 | claimed pass after exact-selector timeout |
| T8 demo add | form interaction | 1 | 57 | claimed pass |
| T9 demo no-op | click + semantic list comparison | 1 | 1.158 | claimed pass |
| T10 Wikipedia search | site search | 1 | 1.605 | claimed pass |

## Findings

- The native stack is very fast when a stable semantic locator works, but brittle
  selector assumptions created four 30-second timeouts across Wikipedia, Python
  docs and the Mar del Plata infobox.
- npm blocked headless Chromium with a Cloudflare verification page. Native fetch
  against npm's public API recovered the answer, but that is a method change and
  is declared in the JSON.
- eBay's current result markup no longer uses `li.s-item` and places fake
  `/itm/123456` “Shop on eBay” links ahead of real products. Broad DOM inspection
  was needed to identify the first real titled listing.
- The deterministic control was strong: T8 completed in 57 ms and T9 correctly
  returned `no-change` despite waiting through an ambient clock tick.
- `wallMs` sums measured execution/timeout windows. It does not include pauses of
  model reasoning between tool calls because this interface did not expose a
  continuous benchmark timer. That measurement limitation is explicit rather
  than estimated away.
