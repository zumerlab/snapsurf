# Change detection — this tool (through MCP) vs pixel difference vs accessibility tree

Date: 2026-08-03 · corpus: 19 cases with hand-written truth
(11 with a real change, 8 NOISE cases: visible movement, no real change).
The tool arm runs THROUGH the MCP server (browser_open + browser_verify), so it measures the product.

## Overall

| Method | Right | False alarms (noise) | Missed changes | Says WHAT changed |
|---|---:|---:|---:|---|
| **This tool (browser_verify)** | **19/19** | **0/8** | 0/11 | kind + role + name + selector |
| Pixel difference (pixelmatch class) | 13/19 | 5/8 | 1/11 | a % of pixels, no meaning |
| Accessibility tree (Playwright) | 16/19 | 2/8 | 1/11 | two JSON trees to diff yourself |

## Per case

| Case | Truth | This tool | Pixel | a11y | Evidence, tool | Evidence, pixel | Evidence, a11y |
|---|:---:|:---:|:---:|:---:|---:|---:|---:|
| button-enabled | change | ✓ | ✗ (0%) | ✓ | 197 B | 33 KB | 1 KB |
| canvas-region | noise | ✓ | ✗ (4.875%) | ✓ | 123 B | 29 KB | 0 KB |
| css-animation-running | noise | ✓ | ✗ (0.323%) | ✓ | 131 B | 24 KB | 0 KB |
| css-in-js-regeneration | noise | ✓ | ✓ | ✓ | 132 B | 44 KB | 1 KB |
| font-swap-late | change | ✓ | ✓ | ✗ | 619 B | 98 KB | 1 KB |
| inline-script-noise | noise | ✓ | ✓ | ✓ | 130 B | 23 KB | 0 KB |
| list-reordered | change | ✓ | ✓ | ✓ | 370 B | 36 KB | 1 KB |
| list-row-inserted | change | ✓ | ✓ | ✓ | 553 B | 43 KB | 1 KB |
| live-timestamp | noise | ✓ | ✗ (0.008%) | ✗ | 125 B | 40 KB | 1 KB |
| modal-overlay | change | ✓ | ✓ | ✓ | 342 B | 23 KB | 0 KB |
| nested-modal-stack | change | ✓ | ✓ | ✓ | 367 B | 29 KB | 1 KB |
| node-replaced | change | ✓ | ✓ | ✓ | 307 B | 38 KB | 1 KB |
| portal-render | change | ✓ | ✓ | ✓ | 584 B | 42 KB | 1 KB |
| react-remount | noise | ✓ | ✓ | ✓ | 124 B | 27 KB | 0 KB |
| residual-hover | noise | ✓ | ✗ (0.249%) | ✗ | 125 B | 31 KB | 0 KB |
| scroll-only | noise | ✓ | ✗ (0.308%) | ✓ | 122 B | 39 KB | 2 KB |
| shadow-dom-mutation | change | ✓ | ✓ | ✓ | 205 B | 25 KB | 0 KB |
| text-update | change | ✓ | ✓ | ✓ | 198 B | 26 KB | 0 KB |
| virtualized-scroll | change | ✓ | ✓ | ✓ | 713 B | 31 KB | 1 KB |

Honesty notes:
- The pixel comparison uses the SAME perceptual, anti-aliasing-aware algorithm from
  @zumer/snapdiff (pixelmatch class), not a naive compare.
- The accessibility tree only answers "does the JSON differ?". Working out WHAT changed is
  left to the caller, holding both full trees — that is what its evidence column measures.
- Evidence for this tool is the text browser_verify returns (kinds, names, selectors,
  ready for a model or an assertion). For pixels it is the TWO screenshots a person or a
  model would have to look at. For the accessibility tree it is the two trees to diff.
