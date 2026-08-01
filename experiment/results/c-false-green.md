# Fase C — False-green diferencial

2026-08-01 · `experiment/c-false-green.mjs` · app `demo-qa/silent-failures.html`
con ruido ambiental deliberado (reloj vivo + spinner + marquesina) ·
agent-browser 0.33.1 · pixel-diff perceptual (clase pixelmatch, @zumer/snapdiff).

Ocho acciones que **parecen** haber funcionado. Cada canal responde "¿mi acción tuvo
el efecto que yo pretendía?" y un juez independiente —`window.__intent()`, que lee el
estado real del DOM sin pasar por ningún canal— dice la verdad.

## Resultado

| Canal | Aciertos | **FALSE GREEN** | false red |
|---|---:|---:|---:|
| **Oráculo · assert de la postcondición** | **8/8** | **0** | 0 |
| Oráculo · `look` crudo (¿cambió algo?) | 4-6/8 † | 2-4 | 0 |

| agent-browser `diff snapshot` (as-is) | 2/8 | 6 | 0 |
| agent-browser + normalización sin refs | 2/8 | 6 | 0 |
| Screenshot (pixel-diff perceptual) | 2/8 | 6 | 0 |

**Diferencial: 0 vs 6 falsos positivos de éxito sobre 8 casos.** El criterio de corte
del TESTPLAN pedía ≥30 puntos; el resultado es de 75.

† **El brazo `look` crudo NO es estable entre corridas.** La primera corrida dio 6/8 · 2
falsos verdes y la re-corrida del 2026-08-01 dio 4/8 · 4: depende del ruido ambiental que
la página produzca en ese instante (reloj + spinner + marquesina), que es justamente lo
que el caso simula. El brazo `assert` dio 8/8 · 0 falsos verdes en las dos corridas. La
conclusión del documento no cambia — la refuerza: preguntar "¿cambió algo?" es
intrínsecamente inestable bajo ruido, y por eso la aserción de postcondición es el
producto y el diff crudo es el insumo.

## Por caso

| # | Falla plantada | Verdad | assert | look | agent-browser | pixel |
|---|---|:---:|:---:|:---:|:---:|:---:|
| F1 | no-op puro | ✗ | ✓ FAIL | ✓ | ✗ dice cambió | ✗ 0,118% |
| F2 | submit rechazado en silencio | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0,182% |
| F3 | click interceptado por overlay | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0,082% |
| F4 | toast efímero (ya se fue) | ✗ | ✓ FAIL | ✓ | ✗ | ✗ 0,112% |
| F5 | funciona fuera del viewport | ✓ | ✓ PASS | ✓ | ✗ indistinguible | ✗ 4,9% |
| F6 | estado sin delta visual | ✓ | ✓ PASS | ✓ | ✗ indistinguible | ✗ 3,9% |
| F7 | doble efecto (insertó 2, no 1) | ✗ | ✓ FAIL | ✗ dice ok | ✗ | ✗ 3,8% |
| F8 | SPA a medio hidratar | ✗ | ✓ FAIL | ✗ dice ok | ✗ | ✗ 3,9% |

## Lo que hay que leer con cuidado

**1. El valor NO está en el diff, está en la aserción.** Nuestro propio `look` crudo
—la pregunta "¿cambió algo?"— produce **2 falsos positivos** (F7: insertó dos filas y
"cambió" es cierto; F8: la URL cambió y el contenido nunca hidrató). El canal que da
0 es el `assert` de la postcondición pretendida. Esto confirma por medición lo que ya
sospechábamos: **`changed:true` a secas es señal de humo, no aserción**, y el producto
defendible es el runtime de postcondiciones, no "un diff mejor".

**2. Los otros canales no fallan por ser malos, fallan porque responden otra pregunta.**
El pixel-diff detecta movimiento —siempre lo hay, el reloj corre— y agent-browser
entrega un diff textual que el consumidor tiene que interpretar. Ninguno de los dos
**miente**: simplemente no tienen una primitive para expresar "yo esperaba que se
agregara UNA fila llamada X". Comparación honesta: no es "su diff está roto", es
**"con su diff todavía tenés que escribir vos la capa que decide si funcionó, y ahí es
donde aparecen los falsos verdes"**.

**3. Los dos casos que separan todo son los más incómodos**: F7 (la acción funcionó
*de más*) y F8 (la navegación arrancó y no terminó). Ambos son "algo pasó" para
cualquier canal de cambio, y solo una aserción con intención —`maxChanges`,
`urlIncludes` + `exists`— los distingue de un éxito.

## Higiene de medición (cuatro bugs propios, corregidos antes de creer nada)

Esta fase dio resultados distintos en cinco corridas. Los cuatro errores eran míos:

1. **pixel-diff siempre 0,000%** — invocaba `diffPixels` con `ImageData` en vez de los
   datos crudos; devolvía `undefined` y se leía como 0. Corregido copiando la
   invocación exacta del brazo pixel de `bench-qa`.
2. **`element.click()` programático** — atraviesa el hit-testing, así que F3 (click
   interceptado) daba "ocurrió". Corregido a click real de mouse.
3. **Click real por coordenadas de página** — los botones bajo el fold quedaban fuera
   del viewport y el click caía al vacío (los 8 casos daban "no pasó nada"). Corregido
   con auto-scroll + `force:true` (saltea los chequeos de Playwright, **no** el
   hit-testing del browser, que es lo que F3 necesita).
4. **Asimetría injusta**: agent-browser recibía la acción por `eval` (programática) y
   nosotros por click real. Igualado: los tres canales usan el click real de su propia
   herramienta.

Y un quinto, conceptual: el juez medía *"¿mutó algo?"* en vez de *"¿se cumplió la
postcondición?"*. Con la primera definición, F7 y F8 contaban como éxitos —que es
justamente el error que este experimento existe para detectar.

## Reproducir

```bash
npm install -g agent-browser
node packages/agent/experiment/c-false-green.mjs
```

Datos crudos por caso: `results/c-false-green.json`.
