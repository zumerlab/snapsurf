# Codex self-navigation: screenshots vs SnapDOM Agent

Fecha: 2026-07-30  
Viewport: 1280×800, Chromium headless  
Orden: T1 Nativo primero; T2 Agent primero; T3 Nativo primero; T4 Agent primero;
T5 Nativo primero.

Conté cada comando operativo como una acción, incluidos `open`, `look`, `find`,
`text` y cada captura solicitada. En NATIVO cada captura solicitada fue mirada y
cuenta además como imagen. En Agent no miré ninguna imagen.

## Resultados por tarea

| Tarea | Brazo | Éxito | Acciones | Imágenes |
|---|---|---:|---:|---:|
| T1 Hacker News | NATIVO | sí | 3 | 1 |
| T1 Hacker News | AGENT | sí | 8 | 0 |
| T2 GitHub issues | AGENT | sí | 3 | 0 |
| T2 GitHub issues | NATIVO | sí | 2 | 1 |
| T3 eBay | NATIVO | sí | 7 | 2 |
| T3 eBay | AGENT | sí | 10 | 0 |
| T4 npm/preact | AGENT | sí | 3 | 0 |
| T4 npm/preact | NATIVO | sí | 4 | 2 |
| T5 Wikipedia | NATIVO | sí | 15 | 6 |
| T5 Wikipedia | AGENT | sí | 4 | 0 |

## Totales

| Brazo | Éxitos | Acciones | Imágenes miradas |
|---|---:|---:|---:|
| NATIVO | 5/5 | 31 | 12 |
| AGENT | 5/5 | 28 | 0 |

El Agent ahorró 3 comandos en total (28 contra 31) y eliminó las 12 imágenes.
Ese total esconde diferencias grandes por tipo de tarea: NATIVO ganó T1, T2 y T3
en acciones; Agent ganó T4 por poco y T5 de forma contundente.

## Evidencia y fricción por tarea

### T1 — Hacker News

Resultado: el artículo con más comentarios fue **“Google will expand age checks
on Android worldwide till the end of the year”**, con 377 comentarios. Ambos
brazos terminaron en `item?id=49107950`.

- NATIVO: la lista completa cabía en una imagen. Localicé visualmente el mayor
  conteo y hice un click. 3 comandos, 1 imagen.
- Agent: el outline estaba recortado y necesité `find "377 comments"`. Cometí un
  error al copiar el id (`n_1rdd` en vez de `n_1rd5`); el harness resolvió ese id
  parecido a otro elemento válido, el voto ascendente, y me envió al login. Tuve
  que reabrir y repetir. 8 comandos.
- Fricción valiosa: un id equivocado puede ejecutar una acción distinta sin
  confirmación del objetivo. Sería útil que `click` imprimiera antes o junto al
  resultado el role/name resuelto, no sólo las coordenadas.

### T2 — GitHub issues

Resultado: **0 abiertos, 338 cerrados**.

- Agent: el mapa superior decía `Issues 0`, pero ese badge no bastaba como
  control. `find "Open"` encontró `Open0 (0)` y `find "Closed"` encontró
  `Closed338 (338)`. 3 comandos.
- NATIVO: ambos contadores aparecían juntos en la primera imagen. 2 comandos,
  1 imagen.
- Fricción valiosa: el Agent expone nombres accesibles con texto concatenado
  (`Open0 (0)`, `Closed338 (338)`) y múltiples representaciones del mismo dato.
  Es preciso, pero menos legible que la jerarquía visual de la página.

### T3 — eBay

Resultado: búsqueda `vinyl record`; primer resultado abierto correctamente en
`/itm/198526021172`.

- NATIVO: una imagen para localizar la búsqueda y otra para localizar el primer
  resultado. El popup “Find more like this” tapaba parte de la lista, pero no el
  primer título. La nueva pestaña fue seguida correctamente. 7 comandos,
  2 imágenes.
- Agent: `find "The Rolling Stones Dirty Work"` localizó el primer título y el
  daemon siguió correctamente la nueva pestaña. 10 comandos.
- Fricción valiosa: cumplir `look` después de focus, tipeo y Enter produjo tres
  observaciones. El `look` de resultados recorrió una página de unos 20.175 px.
  Para un formulario convencional, el protocolo añade comandos y trabajo sin
  aportar mucho frente a una captura visual.

### T4 — npm/preact

Resultado: **27.594.520 weekly downloads**.

- Agent: `find "Weekly Downloads"` encontró el bloque fuera del mapa inicial y
  `text <id>` devolvió el número exacto. 3 comandos, sin scroll.
- NATIVO: el bloque no estaba en la primera captura; apareció después de un
  PageDown. 4 comandos, 2 imágenes.
- Lectura: éste es el mejor caso para Agent. La tarea pide extraer un dato textual
  conocido y `find` evita exploración visual.

### T5 — Wikipedia

Resultado: navegación legítima desde el artículo Argentina al enlace
`Mar del Plata`; URL final `/wiki/Mar_del_Plata`.

- NATIVO: el buscador del navegador (`Control+F`) no produjo un estado observable
  útil en Chromium headless. Navegué visualmente mediante Contenido → Población →
  Ciudades principales, retrocedí una pantalla y pulsé el enlace visible “Mar del
  Plata”. Éxito justo en el límite: 15 comandos, 6 imágenes.
- Agent: `open → find "Mar del Plata" → click <primer id> → look`. 4 comandos.
- Fricción valiosa: Agent ganó ampliamente en navegación de página larga, pero
  `open` tardó aproximadamente 20 segundos, recorrió 6.609 actionables y reportó
  una altura cercana a 148.000 px. El coste de construir la observación completa
  es desproporcionado aunque luego `find` sea excelente.

## Lectura honesta

No hay un ganador universal.

**Usaría NATIVO para páginas compactas y visualmente bien jerarquizadas**, como
la portada de Hacker News, los filtros de GitHub o una lista de resultados de
e-commerce. Ganó esas tres tareas en acciones:

- T1: 3 vs 8.
- T2: 2 vs 3.
- T3: 7 vs 10.

La imagen comunica orden, agrupación y “primer resultado” de forma inmediata.
También evita procesar miles de nodos. Su debilidad aparece cuando el objetivo
está lejos del viewport: obliga a explorar, mirar más imágenes y estimar clicks.

**Usaría Agent para búsqueda textual exacta y navegación profunda**, especialmente
cuando conozco el nombre del objetivo pero no dónde está. Ganó:

- T4: 3 vs 4, con cero exploración visual.
- T5: 4 vs 15, la diferencia decisiva del experimento.

Sí usaría el agente **como índice/locator semántico bajo demanda**, combinado con
capturas regionales cuando la decisión dependa de apariencia, orden visual,
superposición o estado gráfico. No lo usaría todavía como observador completo en
cada paso de una sesión larga: los `look` obligatorios son ruidosos en formularios,
los ids permiten errores silenciosos si se copia uno parecido, y las páginas
grandes muestran costes y geometrías extremas.

El diseño que estos datos favorecen es híbrido:

1. observación estructural barata y `find` global;
2. click por id con confirmación de role/name;
3. captura visual sólo de la región ambigua;
4. evitar reconstruir la página completa después de acciones que sólo cambian
   foco o texto local.

El ahorro de imágenes fue real —12 a 0—, pero no debe venderse como ahorro general
de trabajo: en tres tareas cortas NATIVO necesitó menos comandos, y en Wikipedia el
Agent intercambió 11 comandos humanos por una observación inicial muy costosa.
