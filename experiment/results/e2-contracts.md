# E2 — Los contratos donde afirmamos ventaja, medidos contra agent-browser

2026-08-01 · agent-browser 0.33.1 · mismas páginas para ambos · sin modelo.
Runner: `experiment/e2-contracts.mjs`.

| Contrato | Nosotros | agent-browser | Veredicto |
|---|---|---|---|
| **C1 oclusión** | `becameCovered: "Comprar ahora"` en la observación, **antes** de intentar nada | El snapshot sigue listando el botón como accionable, sin señal de oclusión. El click falla **después**: `✗ Element 'button' is covered by <div>` | **Ventaja nuestra, confirmada** |
| **C2a identidad · remount** | `n_1r3 → n_1r3` estable | `e1 → e1` estable | **Empate — nuestra suposición era falsa** |
| **C2b identidad · reorder** | ids de superficie cambian; el diff clasifica (`moved` con nombres ricos, `possible-replacement` con nombres pobres) | refs cambian; el diff solo muestra churn textual | Matizado (ver abajo) |
| **C3 navegación SPA** | `navigated:true` + `baselineUrl` | Su diff muestra el cambio de contenido pero **no señala que la URL cambió** | **Ventaja nuestra, confirmada** |

## C1 — Oclusión: la ventaja se sostiene, con crédito para ellos

Es la diferencia más limpia del experimento. Nosotros publicamos la oclusión **en el
mapa de la observación**, antes de que el agente decida; ellos la descubren **al
chocar**. Para un agente eso es la diferencia entre "elegí otra cosa" y "gasté una
acción y ahora tengo que interpretar un error".

Crédito honesto: **su error reactivo es de buena calidad** — nombra el elemento que
tapa (`covered by <div>`), no falla mudo. Es mejor que un click que no hace nada.
La ventaja nuestra es de momento, no de calidad del mensaje.

## C2 — Identidad: acá nos corrigieron dos cosas

**a) Remount: empate. Nuestra afirmación era falsa.** Suponíamos —basándonos en que
su doc declara los refs no estables— que un nodo destruido y recreado idéntico les
rompería la identidad. **No pasa**: `e1 → e1`. Sus refs sobreviven un remount limpio.

**b) Reorder: ninguno conserva los ids de superficie**, y eso es esperable —el DOM
cambió—. La diferencia real no está en el id sino en **qué dice el diff**: el nuestro
clasifica el movimiento; el de ellos solo muestra líneas que entran y salen.

**Hallazgo propio, en contra nuestra, que solo apareció por probar con una página que
no diseñamos:** en una lista de **3 items con nombres cortos** dentro de `<a>`, nuestro
differ degrada a `possible-replacement` en los tres. En una de **6 items con nombres
distintivos** reporta `moved` con identidad preservada (`n_1r3…n_1r8`). O sea:

> el matching de identidad a través de reordenamientos **depende de la riqueza de los
> nombres**; con poca señal declara incertidumbre en vez de inventar identidad.

Declarar la duda es el comportamiento diseñado (mejor `possible-replacement` que un
falso `content`), pero la afirmación correcta pasa a ser *"clasificamos el movimiento
cuando hay señal suficiente, y declaramos incertidumbre cuando no"*, no *"seguimos la
identidad a través de reordenamientos"*. Nuestra propia fixture `list-reordered`
prohíbe `possible-replacement` — usa 8 items con nombres largos, que es el caso fácil.

## C3 — SPA: ventaja confirmada

Tras un `pushState` que cambia la URL y reemplaza el contenido, nosotros marcamos
`navigated:true` con la `baselineUrl` — el consumidor sabe que su diff cruza dos
páginas. Su diff muestra el contenido nuevo sin ninguna señal de que la URL se movió:
un agente que lo lea puede creer que sigue en la misma vista.

## Balance

- **2 ventajas confirmadas** (oclusión proactiva, señal de navegación blanda).
- **1 suposición nuestra refutada** (sus refs sí sobreviven un remount).
- **1 límite propio descubierto** (el matching depende de la riqueza de nombres).

Ninguna de las dos correcciones habría aparecido leyendo su documentación. Es el
argumento a favor de correr al competidor en vez de ficharlo.
