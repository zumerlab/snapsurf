# Experimento Codex — harness v3

Fecha: 2026-07-30/31. Rama local: `agent-lab`. No se hizo push ni se modificó
`packages/agent/src` o `src/`.

Esta ronda repitió solamente el brazo SNAPDOM AGENT. Los números v1 y v2 son los
que anoté en `codex-self.md` y `codex-self-v2.md`. Conté cada comando operativo
desde `open` hasta verificar el criterio de éxito. La inspección manual del PNG de
T5 cuenta como una imagen, aunque no como un comando del harness.

## Comparación

| Tarea | v1 éxito / acciones | v2 éxito / acciones | v3 éxito / acciones | imágenes v3 | Resultado v3 |
| --- | ---: | ---: | ---: | ---: | --- |
| T1 Hacker News | sí / 8 | sí / 4 | sí / 4 | 0 | “UEFA and its national associations will not participate in FIFA competitions”; `item?id=49113929` |
| T2 GitHub issues | sí / 3 | sí / 3 | sí / 3 | 0 | 0 abiertos; 338 cerrados |
| T3 eBay | sí / 10 | sí / 11 | sí / 12 | 0 | primer resultado real: “10 Random Christmas Vinyl Record Lot”; `/itm/406631272018` |
| T4 npm/preact | sí / 3 | sí / 3 | sí / 3 | 0 | 22.921.763 weekly downloads |
| T5 Wikipedia | sí / 4 | sí / 4 | sí / 5 | 1 | enlace del artículo seguido hasta `/wiki/Mar_del_Plata` |
| **Total** | **5/5 / 28** | **5/5 / 25** | **5/5 / 27** | **1** | **ningún abandono** |

Los dos comandos adicionales de v3 fueron validaciones deliberadas de funciones
nuevas: `parent` en T3 y `snap` en T5. Sin ellas el flujo habría sumado 25
comandos, igual que v2. Por lo tanto, v3 no redujo por sí solo la cantidad de
turnos del protocolo; sí eliminó el fallo de navegación de v2 y dio evidencia
mejor.

## Resultados y fricción por tarea

### T1 — Hacker News

`open` tardó 1.199 ms. `find "433 comments"` devolvió primero un `link` cuyo tail
era `item?id=49113929`; el click confirmó `role=link`, `name="433 comments"` y el
`look` siguiente verificó la URL de comentarios. Entre la búsqueda y el reporte
el contador vivo pasó a 434, una buena advertencia de que el resultado es una
medición temporal, no un fixture estable.

La combinación de ranking, tail de `href` y confirmación del click resolvió la
ambigüedad que había costado comandos en v1.

### T2 — GitHub issues

`open` tardó 1.658 ms. Los dos `find` dieron `Open0 (0)` y `Closed338 (338)`;
el segundo incluyó un `href` con `state:closed`. La UI también mostraba un issue
cerrado destacado, pero el filtro y su URL hicieron inequívoco el conteo.

La fricción sigue siendo que el nombre accesible concatena etiqueta y contador.
`text` sería útil si hubiese un nodo contenedor pequeño y estable, pero acá los
resultados de `find` alcanzaron.

### T3 — eBay

`open` fue el más lento: 5.074 ms. El foco, tipeo y Enter se observaron después
de cada acción. A diferencia de v2, el primer `look` post-Enter funcionó y mostró
la URL de resultados; no apareció el `document.body === null`.

`find "vinyl record"` fue rápido (4 ms) y rankeó enlaces, pero los tails de los
resultados de eBay terminaban en parámetros de tracking, no en la parte útil
`/itm/`. Además, los primeros matches eran un carrusel promocional; el primer
resultado de la lista era el sexto match. `parent` sobre ese match generó un card
local con título, condición, precio, entrega, vendedor y watchers. Desde ese card
el click confirmó el título completo y el harness siguió la pestaña nueva hasta
`/itm/406631272018`.

`parent` aportó mucho y tardó sólo 3 ms, pero incrementó T3 de 11 a 12 comandos.
El ranking todavía no distingue claramente “resultado orgánico de la lista” de
“producto en carrusel”. El tail debería priorizar pathname o inicio de la URL,
no sólo el final.

### T4 — npm/preact

`open` tardó 1.309 ms. `find "Weekly Downloads"` encontró el bloque
`DownloadsWeekly Downloads22.921.763`; `text` sobre ese nodo devolvió
`Weekly Downloads 22.921.763`. Fueron tres comandos, igual que antes, pero con
menos interpretación frágil. Éste es el caso más claro donde `text <id>` paga su
costo de API.

### T5 — Wikipedia

`open` tardó 3.489 ms. `find "Mar del Plata"` encontró el enlace a 91.034 px y
mostró el `href` exacto. `snap` tardó 1.132 ms, centró correctamente la región y
produjo un PNG sin bandas blancas. La imagen mostró el párrafo demográfico, la
foto y leyenda “6. Mar del Plata”, además de la navegación lateral: fue una
segunda opinión visual útil, no una captura arbitraria de toda la página.

`snap` no incrementó el epoch semántico, así que el mismo id siguió válido. El
click quedó registrado en coordenadas de viewport `(861,400)`, no en el offset
absoluto de 91.034 px, y llegó a `/wiki/Mar_del_Plata`. Esto valida en conjunto
scroll profundo, mapa relativo al viewport y reuso del id tras un snap.

## Velocidad percibida

| Página | `open` v2 aprox. | `open` v3 JSONL | cambio aprox. |
| --- | ---: | ---: | ---: |
| Hacker News | 4,06 s | 1,20 s | -70 % |
| GitHub issues | 4,37 s | 1,66 s | -62 % |
| eBay | 5,49 s | 5,07 s | -8 % |
| npm/preact | 4,04 s | 1,31 s | -68 % |
| Wikipedia Argentina | 6,20 s | 3,49 s | -44 % |

El promedio de esos cinco `open` bajó de aproximadamente 4,83 s a 2,55 s
(-47 %). La mejora se siente claramente en HN, GitHub y npm. eBay sigue dominado
por la página y la navegación: Enter tardó 2.026 ms y cada click relevante cerca
de 1,5 s. Los `find` estuvieron entre 1 y 8 ms; los `look` normales entre 171 y
689 ms. Adaptive settle mejoró el costo fijo sin volver a introducir la carrera
de v2 en esta ejecución.

## Rúbrica

### 1. Permission boundaries

Los verbos funcionan como una API de capacidades explícitas mejor que en v2.
Probé un daemon `--readonly`: permitió `open/find` y denegó tanto `click` como
`type`, con mensajes claros. El intento de escribir `secret-never-logged` quedó
como `«19 chars»` en JSONL. Con `--allow news.ycombinator.com`, HN abrió y un
`open` a GitHub fue bloqueado antes de navegar; la página permaneció en HN.

No lo consideraría aún una frontera de permisos completa:

- `open` está permitido en readonly aunque un GET puede tener efectos del lado
  servidor;
- `type` y `enter` son permisos muy amplios: no hay scope por campo, formulario
  o destino;
- faltan políticas explícitas para descargas, uploads, clipboard, popups y
  esquemas no HTTP;
- `find` y `open` conservan sus argumentos sin redacción, por lo que una búsqueda
  o URL sensible sí puede filtrarse al log;
- una denegación allowlist quedó registrada con `denied:"allowlist"` pero
  `ok:true`. Eso es un bug serio para cualquier consumidor de auditoría.

Conclusión: buena base de capability API para un laboratorio; todavía no alcanza
para afirmar aislamiento de seguridad en un producto autónomo.

### 2. Recovery

Probé:

1. `cp save mar-final` en `/wiki/Mar_del_Plata`;
2. `cp list`, que mostró URL, observación y timestamp;
3. navegación a Argentina;
4. `cp diff mar-final`.

El checkpoint se serializó a un JSON independiente y sobrevivió a la navegación.
El diff advirtió correctamente que las URLs eran distintas y que el resultado
podía ser ruido. También explicitó que cambiaba el baseline global del próximo
`look`.

Esto es checkpointing y comparación, no recovery. No existe `cp restore`; no se
puede recuperar pestaña activa, historial, inputs, foco, scroll o estado de una
app. Para “volver a un estado conocido” aún tendría que hacer `open` y repetir
acciones manualmente. Los checkpoints serían útiles como aserciones o evidencia
de replay, pero no reducen hoy el costo de recuperarse de un fallo.

### 3. Auditabilidad

Reconstruí T3 sólo desde el JSONL de la sesión:

- secuencia 8 abrió eBay;
- 9 encontró la búsqueda;
- 10 clickeó `combobox "Search for anything"`;
- 12 tipeó 12 caracteres, redactados;
- 14 hizo Enter y registró la URL con `_nkw=vinyl+record`;
- 16 registró los ids encontrados;
- 17 observó el parent;
- 18 clickeó el link con el nombre completo y terminó en `/itm/406631272018`;
- 19 observó la página de producto.

Eso alcanza para reconstruir el flujo y su resultado sin transcript. `ts`, `seq`,
epoch, URLs, duración, role/name del click, hash del snap, errores y denegaciones
son una mejora grande. Los delimitadores `««« ... »»»` también hacen visible que
el contenido de página es no confiable.

Falta:

- guardar texto/role/`href` de cada match de `find`, no sólo ids;
- guardar un resumen o hash del contenido de cada `look`, porque hoy el JSONL no
  permite reconstruir qué se vio;
- identificar pestaña/popup y motivo del cambio de página;
- distinguir consistentemente `ok`, `denied` y exit status;
- normalizar o truncar URLs enormes de tracking sin perder pathname;
- definir redacción para argumentos sensibles de `find`, `open` y nombres de
  checkpoints.

El prompt hablaba de `packages/agent/logs/session.jsonl`, pero el daemon creó
archivos por sesión como `20260731-013822.jsonl`. Prefiero el esquema por sesión,
aunque contrato y documentación deberían coincidir.

### 4. Velocidad percibida vs v2

Sí cambió materialmente: 47 % menos en el promedio de `open`, y los comandos
semánticos suelen sentirse instantáneos. El costo restante ya no parece ser
principalmente snapDOM: eBay, páginas de 149.000 px y los clicks con navegación
siguen siendo los límites. No hubo pausa fija obvia ni retry manual en esta ronda.

## Fricciones nuevas o todavía abiertas

- Los ids por epoch son razonables, pero cada observación local debe dejar
  clarísimo qué namespace produjo. `parent` cambió de ids `n_1...` a `n_2...`;
  funcionó, aunque un agente que retenga ambos mapas puede equivocarse.
- `snap` funcionó y preservó el id, pero esa semántica debería estar documentada
  explícitamente: es una observación visual que no invalida ids semánticos.
- El ranking por texto es útil, pero no modela tipos de bloques comerciales.
- `cp diff` entre documentos es honestamente ruidoso y, además, mueve el baseline
  global. No es una operación puramente inspectiva.
- Las salidas completas de `open/look` continúan siendo enormes. El protocolo
  dice “si no lo ves, find”, pero igual imprime miles de tokens antes de llegar a
  esa decisión.
- El registro allowlist con `ok:true` invalida consultas ingenuas como
  “todas las acciones `ok` se ejecutaron”.

## Lectura honesta y veredicto actualizado

V3 cambió mi evaluación, pero no hasta “navegador completo”.

Sí lo usaría como backend de observación/acción para agentes en tareas acotadas:
extracción de números, navegación por enlaces profundos, verificación de destino
y evidencia visual localizada. `text`, `parent`, tails de `href`, click
role/name, JSONL y `snap` dirigido forman una combinación bastante mejor que un
visor puramente visual. En T1, T2 y T4 fue más determinista que decidir por
píxeles; en T5 llegó en dos comandos semánticos a un enlace a 91.000 px y el snap
dio contexto visual correcto.

No reemplaza todavía un navegador de agente general. Los checkpoints no
restauran, los permisos son gruesos, el log tiene una inconsistencia de éxito,
las páginas comerciales siguen necesitando juicio estructural y las salidas
largas consumen mucho contexto. Para flujos visuales sencillos, el brazo nativo
seguirá siendo más directo: en la primera ronda eBay fueron 7 acciones y 2
imágenes contra 12 comandos acá. V3 lo hizo más auditable y resistente, no más
corto.

Mi veredicto pasa de “no lo usaría como navegador completo” a: **sí lo usaría
como capa semántica auditable con fallback visual localizado, detrás de un
orquestador que limite permisos y maneje recuperación; no lo expondría todavía
como navegador autónomo completo**.

El daemon normal y los daemons de prueba `--readonly`/`--allow` fueron detenidos
al finalizar.
