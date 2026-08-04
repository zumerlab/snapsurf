# Experimento Codex — harness v4: duraciones

Fecha: 2026-07-30/31. Rama local `agent-lab`. No hice push ni modifiqué
`packages/agent/src` o `src/`.

## Metodología

Cada tarea válida se ejecutó completa dentro de una sola invocación de `zsh`
medida con `/usr/bin/time -p`. No hubo tiempo de razonamiento entre comandos. El
wall-time informado es por tanto tiempo puro de la cadena: procesos CLI,
transporte, impresión/parsing de salida y ejecución del daemon.

La sesión válida fue `20260731-020403`; su JSONL contiene exactamente los 20
comandos de las cinco tareas antes de `stop`. Hubo dos intentos preliminares
descartados de T1: uno por una incompatibilidad del `awk` de macOS y otro porque
el parser tomó sólo los primeros 40 actionables del mapa truncado. Reinicié el
daemon antes de la medición válida, por lo que esos intentos no contaminan
tiempos, epochs ni caché de la sesión reportada.

Los tiempos v3 aproximados son la suma de `durationMs` de su JSONL, no wall-time;
los incluyo sólo como referencia y no los presento como medición equivalente.

## Resultado por tarea

| Tarea | v1 acc. | v2 acc. | v3 acc. | v4 éxito | v4 acc. | v3 aprox. `ΣdurationMs` | v4 wall-time |
| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |
| T1 Hacker News | 8 | 4 | 4 | sí | 4 | 2,05 s | 2,15 s |
| T2 GitHub issues | 3 | 3 | 3 | sí | 3 | 1,66 s | 2,01 s |
| T3 eBay | 10 | 11 | 12 | sí | 8 | 11,77 s | 11,61 s |
| T4 npm/preact | 3 | 3 | 3 | sí | 2 | 1,31 s | 2,96 s |
| T5 Wikipedia | 4 | 4 | 5 | sí | 3 | 5,35 s | 8,83 s |
| **Total** | **28** | **25** | **27** | **5/5** | **20** | **22,14 s** | **27,56 s** |

Resultados concretos:

- T1: máximo observado, 436 comentarios; “UEFA and its national associations
  will not participate in FIFA competitions”; URL `item?id=49113929`.
- T2: 0 issues abiertos y 338 cerrados.
- T3: primer resultado vertical, “Fleetwood Mac - Rumours [New Vinyl LP]”;
  URL `/itm/136833971688`.
- T4: 22.921.763 weekly downloads.
- T5: el enlace del artículo terminó en `/wiki/Mar_del_Plata`.

La reducción a 20 acciones no viene de fingir éxito: usé la URL que devuelve
`click` como verificación final en T3 y T5, y el `find` de npm ya incluía el
número, por lo que `text` no era necesario. T1 sí necesitó `look` para obtener el
título luego de entrar a comentarios.

## Overhead del CLI por tarea

| Tarea | v4 wall | `ΣdurationMs` JSONL | diferencia | diferencia/comando |
| --- | ---: | ---: | ---: | ---: |
| T1 | 2.150 ms | 1.848 ms | 302 ms | 76 ms |
| T2 | 2.010 ms | 1.800 ms | 210 ms | 70 ms |
| T3 | 11.610 ms | 10.812 ms | 798 ms | 100 ms |
| T4 | 2.960 ms | 2.774 ms | 186 ms | 93 ms |
| T5 | 8.830 ms | 8.055 ms | 775 ms | 258 ms |
| **Total** | **27.560 ms** | **25.289 ms** | **2.271 ms** | **114 ms** |

Sin T5, el overhead medio es 88 ms/comando, dentro del rango de referencia de
70–90 ms salvo eBay. T5 lo eleva porque `open` devolvió una observación con 6.609
actionables y la CLI tuvo que transportar y procesar una salida muy grande. El
`durationMs` del daemon no cubre todo ese costo del cliente.

Sí amerita modo batch, aunque no como prioridad por encima de compactar la
observación. En esta corrida un batch ideal podría ahorrar alrededor de 1,4–1,8 s
de launches/transporte en los 20 comandos. Es una mejora perceptible, pero no
arreglaría los 4,85 s del `open` de eBay ni el outlier de 7,73 s de Wikipedia.
Un `browse.mjs run` es especialmente valioso si:

- mantiene variables/ids entre pasos;
- aborta con un resultado estructurado al primer error;
- devuelve una sola salida compacta y un wall-time global;
- conserva una entrada JSONL por verbo, no una sola entrada opaca.

Batch sin compactación podría incluso acumular la misma cantidad de texto y
ocultar dónde se perdió tiempo.

## Distribución por comando

Mediana calculada sobre los comandos de las cinco tareas válidas. Para un número
par de muestras uso el promedio de los dos valores centrales.

| Comando | n | p50 | máximo |
| --- | ---: | ---: | ---: |
| `open` | 5 | 2.773 ms | 7.725 ms |
| `find` | 7 | 2 ms | 28 ms |
| `look` | 2 | 485 ms | 508 ms |
| `click` | 4 | 913 ms | 1.513 ms |
| `enter` | 1 | 2.030 ms | 2.030 ms |

El p50 de click es poco representativo: los clicks sin navegación fueron
306–314 ms, mientras que los dos clicks de eBay fueron 1.512–1.513 ms. `find`
sigue siendo prácticamente gratis; el máximo de 28 ms ocurrió sobre los 579
actionables de resultados de eBay.

## Desglose completo de la tarea más lenta: T3 eBay

| Seq. | Comando | `durationMs` | Propósito |
| ---: | --- | ---: | --- |
| 8 | `open ebay.com` | 4.853 ms | cargar home |
| 9 | `find "Search for anything"` | 6 ms | resolver buscador |
| 10 | `click` | 1.512 ms | enfocar combobox |
| 11 | `type "vinyl record"` | 408 ms | escribir consulta |
| 12 | `enter` | 2.030 ms | navegar a resultados |
| 13 | `look` | 462 ms | observar resultados, 579 actionables |
| 14 | `find "Opens in a new window or tab"` | 28 ms | localizar cards |
| 15 | `click` | 1.513 ms | abrir primer resultado y seguir pestaña |
|  | **Suma daemon** | **10.812 ms** |  |
|  | **Overhead CLI** | **798 ms** |  |
|  | **Wall-time** | **11.610 ms** |  |

Fue apenas más rápida que la referencia de 12,1 s. El ranking puso primero el
resultado vertical real y registró un `href` pathname-first
`/itm/136833971688?...`; después aparecieron productos de carrusel. Eso eliminó
la necesidad de `parent` de v3 y bajó T3 de 12 a 8 comandos.

## Por qué esta corrida fue más lenta que la referencia

Mi total de 27,56 s supera en 6,36 s la referencia de 21,2 s. No fue por ejecutar
comandos de a uno: cada tarea fue una cadena única y eBay quedó por debajo de la
referencia.

La diferencia principal fue T5:

- corrida oficial: `open Wikipedia = 7.725 ms`, wall de la tarea 8,83 s;
- v3: `open Wikipedia ≈ 3.489 ms`;
- repetición diagnóstica posterior, en una sesión separada:
  `open = 3.512 ms`, wall 3,58 s;
- las tres observaciones tuvieron el mismo orden de tamaño; v4 oficial y el
  diagnóstico reportaron `mapTotal=6609`.

Por tanto, los 7,73 s fueron un outlier transitorio de red o adaptive settle, no
una página distinta ni más trabajo semántico estable. No sustituí ni promedié la
medición oficial. Si T5 hubiese repetido los 3,58 s del diagnóstico, el total
habría sido aproximadamente 22,31 s, cerca de la referencia.

npm también fue más lento que v3 (`open=2.773 ms` frente a 1.309 ms), otra señal
de variabilidad de carga. HN y GitHub quedaron en el rango esperado.

## Spot-check de auditoría

### Denegación readonly

Levanté una sesión separada `20260731-020554` con `--readonly`, abrí HN, ejecuté
un `find` y forcé `click n_1rg`. La entrada fue:

```json
{
  "cmd": "click",
  "durationMs": 0,
  "ok": false,
  "denied": "readonly"
}
```

El bug serio de v3 está corregido: la denegación ya no aparece como exitosa.

### Matches completos de find

El JSONL ahora permite reconstruir la elección. Por ejemplo, T1 guardó:

```json
{
  "id": "n_1r96",
  "r": "link",
  "n": "436 comments",
  "href": "/item?id=49113929"
}
```

Y T3 guardó el primer producto con nombre y
`href="/itm/136833971688?..."`. El pathname aparece primero y ya no queda
enterrado detrás de tracking. Los wrappers page-wide también quedaron fuera de
los primeros resultados relevantes.

Hay dos incumplimientos respecto de la descripción de v4:

1. Los campos reales son abreviados `{id,r,n,href}`, no
   `{id,role,name,href}`. La información está, pero un consumidor que implemente
   literalmente el contrato documentado no la encontrará.
2. Las URLs de `urlBefore/urlAfter` no están reducidas a `origin+pathname`.
   Ejemplos de la sesión válida conservan `_nkw`, `epid` e `itmmeta`; parecen
   truncadas por longitud, pero todavía contienen query. El fix evita URLs
   infinitas, no evita exposición de parámetros.

`open/look` sí añadieron `mapTotal`; por ejemplo, HN comentarios registró 3.580,
eBay resultados 579 y Wikipedia 6.609. Esta ronda no produjo un `look` delta sin
navegación para comprobar `changed/#changes`.

## Fricciones nuevas

- El costo externo de una invocación no es constante: escala con el volumen de
  salida. “70–90 ms por comando” describe bien páginas normales, no Wikipedia.
- La observación inicial de HN sólo mapea los primeros 40 actionables. Mi intento
  preliminar eligió erróneamente 339 comentarios porque el máximo de 436 estaba
  visible en el outline pero fuera del mapa. La ruta correcta fue calcular el
  máximo del outline y luego hacer `find "436 comments"`.
- En eBay, seleccionar “primer item” todavía requiere distinguir cards verticales
  de carruseles. El ranking v2 acertó esta vez, pero esa prioridad es heurística,
  no una propiedad declarada del resultado.
- Adaptive settle puede variar por varios segundos en la misma Wikipedia sin
  cambiar `mapTotal`. Sería útil loguear el motivo de settle y sus fases
  (`navigation`, quiet window, walk) para explicar outliers.
- El JSONL compacto mejora costo, pero las abreviaturas `r/n` y la documentación
  `{role,name}` deben tener un único contrato.

## Lectura honesta

V4 demuestra que el harness puede completar las cinco tareas en los mismos 20
comandos de la referencia y que la mayor parte del tiempo está en navegación, no
en búsqueda semántica. `find` tiene p50 de 2 ms; optimizarlo más no cambiaría la
experiencia. Las prioridades reales son:

1. estabilizar y desglosar adaptive settle;
2. compactar observaciones enormes;
3. añadir batch para quitar aproximadamente 0,1 s por verbo y hacer atómica la
   medición de workflows;
4. cerrar el contrato de auditoría de campos y sanitización de URLs.

Sí implementaría batch, pero después o junto con una respuesta compacta. No
vendería un ahorro de 2 s de CLI como solución a una corrida cuyo outlier de red
costó más de 4 s.

Todos los daemons de la corrida válida, spot-check y diagnóstico fueron
detenidos al finalizar.
