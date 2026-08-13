# Ronda 5 — resultados (grilla 2×2 × 3 tareas)

Corrida: 2026-08-13. Cuatro brazos completos, 12 celdas. Protocolo en
[`ronda5-protocolo.md`](ronda5-protocolo.md); prompts congelados en `scratchpad/r5-*.txt`.

## La grilla — columna `proof`

|                    | T-A lazy scroll | T-B negativo fiel | T-C oclusión |
|--------------------|-----------------|-------------------|--------------|
| **Claude · snapdom** | afirmado (6)  | **demostrado** (8) | **demostrado** (16†) |
| **Codex · snapdom**  | afirmado (8)  | **demostrado** (15)| **demostrado** (16) |
| **Claude · nativo**  | afirmado (2)  | afirmado (11‡)     | **demostrado** (11) |
| **Codex · nativo**   | afirmado (2)  | afirmado (1)       | **demostrado** (5) |

(entre paréntesis: toolCalls. † incluye ~9 llamadas perdidas en el bug de abajo.
‡ camino limpio; ~20 llamadas más se fueron en el viewport 0×0 del Browser pane.)

## Lo que la grilla dice — y no es lo que el protocolo esperaba

**T-B es la única celda que discrimina.** Es la fila entera donde snapdom dice
`demostrado` y nativo dice `afirmado`, y la diferencia es exacta, no retórica:

- snapdom: `changesTotal: 2` sobre la página COMPLETA, más cinco `mustNotInclude`
  en `absent`. El negativo cubre todo lo que la página podría haber movido.
- nativo: `othersChanged: []` sobre las seis tuplas nombre→botón que **yo elegí
  comparar**. Fuera de esa proyección escrita a mano no hay observación. Si el
  click hubiera tocado el header, el precio o un `aria-disabled`, ninguno de los
  dos brazos nativos se habría enterado.

Los dos brazos nativos convergieron, sin coordinación, en el mismo gesto: construir
a mano un snapshot antes/después y diffearlo. Codex lo dijo solo en su `meta`:
*"probar el negativo global exigió construir manualmente snapshots antes/después"*.
Eso es el producto, reimplementado peor, en cada tarea, por cada agente.

**T-C no discrimina — y esto corrige lo que veníamos asumiendo.** Los cuatro brazos
dijeron `demostrado`. Playwright ya tiene una primitiva de oclusión: el trial-click
falla con `intercepts pointer events`, y `elementFromPoint` devuelve `DIV.underlay`
en vez del link. Es un hecho tipado, emitido por la librería, no una mirada a
píxeles. La ventaja de snapdom en oclusión es de **ergonomía** (`{"notCovered":"click
here"}` en una línea vs. saber que hay que preguntar por hit-testing), no de
capacidad. Conviene dejar de venderla como si fuera lo segundo.

**T-A no discrimina para nadie, y además estaba mal diseñada.** Tres defectos:
1. La premisa es falsa. HN página 2 mide ~1217px con viewport de 800: los puestos
   #33–35 están sobre el fold. `scroll bottom` movió 417px. No hubo lazy load que
   hidratar — HN es server-rendered. Codex/nativo tuvo que **fabricar** el fold
   (viewport de 100px) para que la tarea existiera, y lo declaró.
2. Es un blanco móvil. Entre mi corrida y la siguiente entró una historia nueva en
   #31 y todo se corrió un puesto. Los cuatro brazos contestaron sobre rankings
   distintos: mi brazo snapdom vio #33=Principia, mi brazo nativo vio #34=Principia,
   Codex/snapdom vio #34=GoAccess. **Las respuestas de T-A no son comparables entre
   brazos** salvo corrida simultánea.
3. Extracción no produce `demostrado` por definición: no hay transición que probar.

## Fricciones nuevas → candidatas a fix

1. **`open` observa antes de `window.onload` — bug real, el hallazgo de la ronda.**
   `tools/browse.mjs:1578` navega con `waitUntil: 'domcontentloaded'`. El modal de
   `entry_ad` se pinta en `onload`, así que **no aparece en el digest y el agente no
   recibe ninguna señal de que falta algo**: ve una página de 2 actionables y la da
   por completa. Verificado: mismo contexto (`viewport`, `userAgent`, `bypassCSP`,
   `locale: es-AR`) bajo Playwright pelado sí muestra el modal — no son las opciones
   de contexto, es el momento de la observación. Con 2.5s de espera el `look` lo
   emite entero (15 cambios). Le costó ~9 llamadas a mi brazo y una sesión entera al
   de Codex, que reportó *"la primera sesión no expuso el modal pese a re-habilitarlo
   y recargar"*. Es la clase de elemento de mayor riesgo para un agente —
   precisamente lo que bloquea clicks. Fix: esperar `load` (o exponer un settle
   explícito y decir en el digest que la página sigue cargando).
2. **La descripción de `browser_session_open` miente sobre las cookies.** Dice
   *"Sessions share cookies (one browser context)"*; la implementación hace
   `browser.newContext()` por sesión (`tools/browse.mjs:453`), o sea que cada sesión
   tiene su propio jar. Me mandó por una hipótesis equivocada durante ~15 minutos
   (diagnostiqué contaminación entre brazos que no existía). Fix: corregir el texto.
3. **`browser_scroll` y `browser_parent` no llegaron al registro MCP de esta sesión.**
   Existen en `mcp/server.mjs:309` y `:215` pero no eran invocables; el brazo snapdom
   de Claude tuvo que correr por CLI. El de Codex sí los tuvo.
4. **`text` trunca sin avisar en el CLI.** El texto de la tabla de HN se cortó a
   mitad del item #35 y la prosa no marcó nada. La tool declara `truncated: true` en
   `structuredContent`, pero el cliente CLI no lo imprime: un valor cortado se lee
   como un valor completo. Codex reportó la misma forma del problema en el outline
   (*"truncó el contenido y omitió los puntos"*).
5. **`parent` no alcanza la fila de subtexto en HN.** Sube al ancestro con ≥2
   actionables, que en el `<table>` de HN es el `<tr>` del título — puntos y
   comentarios viven en el `<tr>` hermano. La "card" queda incompleta.
6. **El verbo es `look`, no `verify`.** `verify` es el nombre MCP; en el CLI no
   existe y devuelve `unknown command`. Costó una llamada.

Fricciones del brazo nativo (Browser pane), para balance: viewport que se reporta
`1280x720` mientras la página renderiza a 0×0 (`innerWidth: 0`) y rompe
`elementFromPoint`; `form_input` que no dispara los eventos de React y deja el login
mudo; refs que se vuelven stale y mandan dos clicks distintos a la misma coordenada;
`navigate` que descarta el path; y `javascript_tool` que filtra las `const` entre
llamadas (`Identifier 'a' has already been declared`).

## Respuestas crudas

```json
{"task":"T-A","stack":"snapdom","arm":"claude","answer":"#33 Principia Mathematica is modern and insightful — 258 puntos, 136 comentarios; #34 Show HN: At 16K features, flat autoencoders break. Curved space doesn't — 3 puntos, 0 comentarios (discuss); #35 OpenCV AI Competition 2026 — 3 puntos, 0 comentarios (discuss)","evidence":"browser_text sobre la tabla emitió la línea de subtexto de cada item; el #35 llegó cortado y hubo que recuperarlo con find(\"Hussain04\") → \"3 points by Hussain04 1 hour ago | hide | discuss\"","toolCalls":6,"proof":"afirmado","frictions":"text truncó sin avisar; parent no llega a la fila de puntos/comentarios; los items no estaban bajo el fold"}
{"task":"T-B","stack":"snapdom","arm":"claude","answer":"Solo el Backpack cambió: su botón pasó a Remove y el badge del carrito quedó en 1","evidence":"UN assert, 9/9 PASS: changed=true · mustInclude added \"Remove\" (found, via possible-replacement — identidad ambigua, declarado) · mustInclude added \"1\" (found) · mustNotInclude Bike Light/Bolt T-Shirt/Fleece Jacket/Onesie/Red todos \"absent\" · maxChanges 10 vs changesTotal REAL = 2","toolCalls":8,"proof":"demostrado","frictions":""}
{"task":"T-C","stack":"snapdom","arm":"claude","answer":"Con el modal, \"click here\" estaba cubierto; tras Close quedó libre","evidence":"assert {\"notCovered\":\"click here\"} → FAIL, actual \"covered\". Tras click en Close: look emitió 15 cambios con removed del bloque \"This is a modal window\", y el mismo assert → PASS, actual \"clear\"","toolCalls":16,"proof":"demostrado","frictions":"open observa antes de onload: el modal no existía en el digest y no hubo señal de que faltara"}
{"task":"T-A","stack":"nativo","arm":"claude","answer":"(ranking al momento de mi corrida, ~10 min después del brazo snapdom) #33 Picking berries is my meditation — 93 puntos, 75 comentarios; #34 Principia Mathematica is modern and insightful — 258 puntos, 136 comentarios; #35 Show HN: At 16K features… — 3 puntos, 0 comentarios","evidence":"get_page_text devolvió la página entera con los puestos numerados y su subtexto, en una sola llamada y sin scroll","toolCalls":2,"proof":"afirmado","frictions":"HN se movió un puesto entre brazos: T-A no es comparable salvo corrida simultánea"}
{"task":"T-B","stack":"nativo","arm":"claude","answer":"Backpack → Remove, badge 1, ningún otro producto cambió","evidence":"snapshot propio antes/después de las 6 tuplas nombre→botón: changedButtons=[\"Sauce Labs Backpack\"], othersUnchanged=true, badge null→1. El negativo cubre SOLO esas 6 tuplas + el badge: es la proyección que yo elegí, no la página","toolCalls":11,"proof":"afirmado","frictions":"form_input no dispara los eventos de React y el login quedó mudo; refs stale mandaron dos clicks a la misma coordenada"}
{"task":"T-C","stack":"nativo","arm":"claude","answer":"Con el modal, \"click here\" no era alcanzable; tras Close sí","evidence":"elementFromPoint en el centro del link: antes {tag:\"DIV\", cls:\"underlay\"}, isSelf=false; después {tag:\"A\", text:\"click here\"}, isSelf=true","toolCalls":11,"proof":"demostrado","frictions":"el viewport reportaba 1280x720 pero la página corría a 0×0 (innerWidth:0) y elementFromPoint devolvía null hasta forzar resize; leer .modal display habría mentido (siguió en \"block\") — el hecho bueno era el hit-test"}
```

Las líneas de los dos brazos de Codex, tal como las emitió, están en
`scratchpad/r5-codex-snapdom.out` y `scratchpad/r5-codex-nativo.out`.

## Balance acumulado

5 rondas · 16+ tareas-brazo · 10 bugs/fricciones convertidos en fixes. Lo que la
ronda 5 agrega al balance no es un punto más a favor del instrumento: es **saber
dónde está el punto**. La ventaja está en el negativo global (T-B), es medible, y
ninguna de las dos alternativas nativas la alcanza sin reimplementarla. En oclusión
la ventaja es de ergonomía, no de capacidad — y decirlo así es más defendible que
seguir contándola como si fuera un foso.
