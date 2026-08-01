# Benchmark QA — oráculo (vía MCP) vs pixel-diff vs a11y-tree

Fecha: 2026-08-01 · corpus: 19 fixtures con truth escrita a mano
(11 con cambio semántico real, 8 de RUIDO: movimiento visual sin cambio semántico).
El brazo oráculo corre A TRAVÉS del servidor MCP (browser_open + browser_verify): mide el producto.

## Resultado global

| Brazo | Correctos | Falsos positivos (ruido) | Cambios perdidos | Explica QUÉ cambió |
|---|---:|---:|---:|---|
| **Oráculo (browser_verify)** | **19/19** | **0/8** | 0/11 | kinds + role + name + selector |
| Pixel-diff (clase pixelmatch) | 13/19 | 5/8 | 1/11 | % de píxeles, sin semántica |
| a11y-tree (Playwright) | 16/19 | 2/8 | 1/11 | dos árboles JSON a diffear |

## Por fixture

| Fixture | Truth | Oráculo | Pixel | a11y | Evidencia oráculo | Evidencia pixel | Evidencia a11y |
|---|:---:|:---:|:---:|:---:|---:|---:|---:|
| button-enabled | cambio | ✓ | ✗ (0%) | ✓ | 197 B | 33 KB | 1 KB |
| canvas-region | ruido | ✓ | ✗ (4.875%) | ✓ | 123 B | 29 KB | 0 KB |
| css-animation-running | ruido | ✓ | ✗ (0.323%) | ✓ | 131 B | 24 KB | 0 KB |
| css-in-js-regeneration | ruido | ✓ | ✓ | ✓ | 132 B | 44 KB | 1 KB |
| font-swap-late | cambio | ✓ | ✓ | ✗ | 619 B | 98 KB | 1 KB |
| inline-script-noise | ruido | ✓ | ✓ | ✓ | 130 B | 23 KB | 0 KB |
| list-reordered | cambio | ✓ | ✓ | ✓ | 370 B | 36 KB | 1 KB |
| list-row-inserted | cambio | ✓ | ✓ | ✓ | 553 B | 43 KB | 1 KB |
| live-timestamp | ruido | ✓ | ✗ (0.008%) | ✗ | 125 B | 40 KB | 1 KB |
| modal-overlay | cambio | ✓ | ✓ | ✓ | 342 B | 23 KB | 0 KB |
| nested-modal-stack | cambio | ✓ | ✓ | ✓ | 367 B | 29 KB | 1 KB |
| node-replaced | cambio | ✓ | ✓ | ✓ | 307 B | 38 KB | 1 KB |
| portal-render | cambio | ✓ | ✓ | ✓ | 584 B | 42 KB | 1 KB |
| react-remount | ruido | ✓ | ✓ | ✓ | 124 B | 27 KB | 0 KB |
| residual-hover | ruido | ✓ | ✗ (0.249%) | ✗ | 125 B | 31 KB | 0 KB |
| scroll-only | ruido | ✓ | ✗ (0.308%) | ✓ | 122 B | 39 KB | 2 KB |
| shadow-dom-mutation | cambio | ✓ | ✓ | ✓ | 205 B | 25 KB | 0 KB |
| text-update | cambio | ✓ | ✓ | ✓ | 198 B | 26 KB | 0 KB |
| virtualized-scroll | cambio | ✓ | ✓ | ✓ | 713 B | 31 KB | 1 KB |

Notas de honestidad:
- El pixel-diff se corrió con el MISMO algoritmo perceptual con anti-aliasing de
  @zumer/snapdiff (clase pixelmatch), no un compare naive.
- El a11y-tree solo responde "¿difiere el JSON?"; interpretar QUÉ cambió queda a
  cargo del consumidor con ambos árboles completos (la columna de evidencia).
- La evidencia del oráculo es el texto de browser_verify (kinds+names+selectors,
  listo para un LLM o una aserción); la del pixel son los DOS screenshots que un
  humano/LLM tendría que mirar; la del a11y son los dos árboles a diffear.
