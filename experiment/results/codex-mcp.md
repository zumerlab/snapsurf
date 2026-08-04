# Experimento Codex — MCP a ciegas (gate F1c)

Fecha: 2026-07-31. Rama local `agent-lab`. No usé `browse.mjs`, la skill de
Playwright ni documentación externa. La única documentación funcional fue la
respuesta de `tools/list` del servidor MCP.

## Metodología

Consumí `packages/agent/mcp/server.mjs` por stdio, JSON-RPC por línea:

1. `initialize`;
2. `notifications/initialized`;
3. `tools/list`;
4. `tools/call` para las cinco tareas.

Para medir sin incluir mis pausas de razonamiento interpuse un relay temporal
fuera del repositorio. El relay no interpreta ni modifica MCP: registra
`performance.now()` justo antes de escribir cada request al stdin del server y al
recibir la línea JSON de respuesta completa. El wall por tarea es la suma de esos
round-trips puros. No incluye los waits artificiales del terminal que utilicé
para leer las respuestas.

Hubo dos inicializaciones descartadas mientras corregía la medición del
transporte: el PTY retenía respuestas hasta agotar el timeout solicitado. Las
tareas y números de abajo pertenecen a una única sesión medida por el relay.

## Resultado

| Tarea | MCP éxito | MCP llamadas | MCP wall puro | CLI v4 éxito/acciones | CLI v4 wall |
| --- | :---: | ---: | ---: | ---: | ---: |
| HN: máximo de comentarios | sí | 6 | 1,71 s | sí / 4 | 2,15 s |
| GitHub issues abiertos/cerrados | sí | 2 | 1,84 s | sí / 3 | 2,01 s |
| Wikipedia Argentina → Mar del Plata | sí | 4 | 4,23 s | sí / 3 | 8,83 s |
| npm/preact weekly downloads | sí | 3 | 1,30 s | sí / 2 | 2,96 s |
| eBay `vinyl record` → primer `/itm/` | sí | 10 | 10,90 s | sí / 8 | 11,61 s |
| **Total** | **5/5** | **25** | **19,98 s** | **5/5 / 20** | **27,56 s** |

Referencia MCP del gate: **5/5, 21 llamadas, 21,2 s**. Mi ejecución hizo cuatro
llamadas más pero terminó 1,22 s antes. Contra mi CLI v4, MCP ahorró 7,58 s, con
la salvedad conocida de que Wikipedia fue un outlier de 8,83 s en aquella ronda.

Resultados observados:

- HN: 459 comentarios, “Gemini Robotics 2 brings whole body intelligence to
  robots”, `item?id=49111237`.
- GitHub: 0 abiertos y 338 cerrados.
- Wikipedia: el click navegó a `/wiki/Mar_del_Plata`.
- npm: 27.689.392 weekly downloads.
- eBay: primer resultado “The Rolling Stones Dirty Work 12\" Vinyl LP Rock
  Rolling Stones Records”, `/itm/198526021172`.

Cada tarea quedó por debajo del tope de 15 llamadas.

## Duración por llamada

### HN — 6 llamadas, 1.712,1 ms

| Tool | ms | bytes de respuesta |
| --- | ---: | ---: |
| `browser_open` | 843,6 | 2.598 |
| `browser_find("comments")` | 9,5 | 973 |
| `browser_page(outline)` | 7,8 | 12.807 |
| `browser_find("459 comments")` | 6,1 | 337 |
| `browser_act(click)` | 308,6 | 212 |
| `browser_verify` | 536,5 | 2.462 |

El digest no incluía los enlaces de comentarios. `find("comments")` devolvió
doce matches en orden de página, no una agregación por valor. Para justificar el
máximo tuve que pedir el outline y después localizar el conteo exacto. Funcionó,
pero explica las dos llamadas adicionales frente a un flujo ideal.

### GitHub — 2 llamadas, 1.842,0 ms

| Tool | ms | bytes |
| --- | ---: | ---: |
| `browser_open` | 1.835,6 | 2.501 |
| `browser_find("Closed")` | 6,4 | 719 |

`open` ya mostró `Open0 (0)`; `find` devolvió `Closed338 (338)` con el href del
filtro cerrado.

### Wikipedia — 4 llamadas, 4.229,6 ms

| Tool | ms | bytes |
| --- | ---: | ---: |
| `browser_open` | 3.450,1 | 3.833 |
| `browser_find("Mar del Plata")` | 16,7 | 470 |
| `browser_act(click)` | 317,8 | 211 |
| `browser_verify` | 445,0 | 3.623 |

`find` resolvió directamente un enlace a 91.034 px. `verify` confirmó URL y
estado nuevo sin una segunda operación de observación distinta.

### npm — 3 llamadas, 1.297,3 ms

| Tool | ms | bytes |
| --- | ---: | ---: |
| `browser_open` | 1.287,8 | 2.693 |
| `browser_find("Weekly Downloads")` | 5,2 | 311 |
| `browser_text` | 4,3 | 205 |

`browser_text` convirtió el nodo concatenado en el valor explícito
`Weekly Downloads 27.689.392`.

### eBay — 10 llamadas, 10.896,6 ms

| Tool | ms | bytes |
| --- | ---: | ---: |
| `browser_open` | 4.678,3 | 3.673 |
| `browser_find("Search for anything")` | 5,0 | 233 |
| `browser_act(click input)` | 1.515,2 | 198 |
| `browser_verify` | 217,5 | 481 |
| `browser_act(type)` | 409,4 | 119 |
| `browser_verify` | 210,8 | 1.057 |
| `browser_act(enter)` | 2.039,4 | 191 |
| `browser_verify` | 215,7 | 3.939 |
| `browser_act(click result)` | 1.524,8 | 686 |
| `browser_verify` | 80,5 | 4.790 |

Seguí literalmente la descripción de `browser_act`: verify después de cada
acción. El verify posterior a Enter devolvió el digest de resultados y puso el
primer card real como primer actionable; no necesité otro `find` ni `parent`.

En total, las cinco tareas devolvieron 49.322 bytes de JSON. La mediana de las 25
llamadas fue 308,6 ms; el máximo fue el `browser_open` de eBay, 4.678,3 ms. Las
búsquedas y lecturas estuvieron entre 4,3 y 16,7 ms.

## Evaluación de la superficie MCP

### ¿Las nueve descripciones alcanzan?

En lo conceptual, sí. Pude completar 5/5 sin mirar ninguna otra documentación:

- `browser_open` explica digest, ranking y caducidad de ids;
- `browser_find` explica búsqueda global y que no hace falta pedir el outline;
- `browser_act` explica foco, tipeo, Enter, auto-scroll y echo del click;
- `browser_verify` comunica claramente la idea de verificar en lugar de asumir;
- checkpoint/diff aclaran incluso que no son undo;
- `browser_text`, `browser_page` y `browser_screenshot` tienen un criterio de
  escalación comprensible.

Pero la salida contradice esa superficie. Repite instrucciones heredadas del
CLI:

```text
corré look para ver qué cambió
REGIONES (zoom con look <id>)
detalle: outline · map <offset> · find <texto> · look <id>
```

No existe una tool MCP llamada `look`, ni tools llamadas simplemente `find` o
`map`. Un cliente realmente ciego puede inventar una tool inexistente. Yo pude
inferir que “corré look” significaba `browser_verify`, pero la superficie no se
explica sola de manera consistente.

Además, el schema de `browser_act` sólo exige `action`; `target` y `text` son
opcionales incluso cuando el verbo los necesita. La descripción lo explica,
pero el JSON Schema debería expresarlo con `oneOf` para que un cliente pueda
validar antes de llamar.

### ¿Qué confundió o faltó?

1. **Zoom regional inexistente.** El digest ofrece ids de regiones y manda hacer
   `look <id>`, pero `browser_page` no acepta id. Falta `browser_inspect(id)` o un
   parámetro `id` en `browser_page`.
2. **Agregación dirigida.** Para “el mayor número de comentarios”, find encontró
   texto pero no podía ordenar por el número contenido. Inventaría
   `browser_query({ match, select, orderBy, limit })`, o permitiría devolver más
   matches estructurados al cliente sin pedir 12 KB de outline.
3. **Assertions.** Para QA inventaría
   `browser_assert({ url, target, state, text })`, construida encima del diff y
   con resultado booleano estructurado.
4. **No hay restore.** Checkpoint/diff están bien descritos, pero no recuperan
   estado. No bloqueó estas tareas, aunque limita pipelines largos.

### ¿`browser_verify` cambió el flujo?

Sí. Es la primitive más valiosa de la superficie:

- tras navegación devuelve directamente el digest nuevo;
- tras type mostró el cambio de estado del combobox;
- una llamada extra sin acción devolvió `sin cambios desde el último look`, por
  lo que el negativo fiel existe;
- evitó que yo agregara una operación genérica de re-observación distinta.

Pero hoy verifica correlación temporal, no causalidad. Después de enfocar el
input de eBay reportó seis cambios de estilo/movimiento de un carrusel y no el
foco. Un agente puede interpretar `changed` como prueba de que su acción tuvo el
efecto buscado cuando sólo cambió contenido ambiental.

La descripción promete un campo `changed`, pero `tools/call` devuelve sólo prosa
en `content[].text`. En el no-op no recibí `changed:false`; recibí la frase “sin
cambios”. En navegación tampoco recibí `changed:true`, sino un digest completo.
Para un humano funciona. Para QA automatizado obliga a parsear español.

## Fricciones del transporte

Lo que funcionó:

- `initialize`, `tools/list` y `tools/call` no produjeron errores JSON-RPC;
- el framing por línea fue simple;
- readiness apareció por stderr y no contaminó stdout;
- cada respuesta conservó delimitadores que marcan contenido web como no
  confiable;
- latencia de `find`/`text` fue despreciable.

Lo que no está listo:

- No hay `structuredContent`: URL, `changed`, matches, target resuelto y cambios
  viven dentro de texto localizado. Un integrador tendría que mantener un parser
  frágil.
- Las respuestas no siempre son “~2–3 KB”: el outline fue 12.807 bytes y los
  verifies de páginas completas llegaron a 4.790 bytes. Es razonable como
  escalación, pero debería haber límites y métricas declarados.
- La URL completa de eBay, con query y tracking extensos, apareció tanto en act
  como verify. Para un producto client-side, redacción y estructura separada de
  URL son parte del contrato de privacidad.
- Los ids caducan con observaciones, pero una respuesta MCP no ofrece el epoch
  como campo estructurado para rechazar localmente un id viejo.
- La medición expuso un problema de lifecycle: al cerrar el servidor MCP quedó
  un `browse.mjs serve` huérfano con PPID 1. `SIGTERM` no lo detuvo; tuve que
  identificar el PID exacto y usar `SIGKILL`. También explica que una sesión
  reiniciada empezara con `obs #9`: el daemon anterior seguía vivo.

Ese último punto es un blocker real para CI: el server dice que levanta el daemon
solo, por lo tanto debe terminarlo de manera determinista al recibir EOF,
`SIGINT`, `SIGTERM` o al morir el parent.

## Veredicto para un builder externo

**Es integrable hoy para experimentación y para un agente con un modelo en el
loop. No lo pondría tal cual en un pipeline de QA desatendido.**

El núcleo merece integración: 5/5, menos de 20 s, búsqueda profunda rápida y un
verify que sí detecta no-ops. La superficie de nueve tools es pequeña y, salvo el
leak de nombres CLI, fácil de aprender.

Antes de producción pediría:

1. `structuredContent` versionado para todas las tools;
2. `changed`, URL, epoch, matches y target como campos, no prosa;
3. causalidad o separación entre cambios del target y mutaciones ambientales;
4. assertions deterministas para QA;
5. schema condicional correcto para `browser_act`;
6. reemplazar todas las instrucciones `look/find/map` por nombres MCP reales;
7. redacción auditable de texto y query params;
8. ownership correcto del daemon y cierre garantizado;
9. tests de lifecycle por EOF y señales.

No hace falta convertirlo en un navegador autónomo completo. Como capa MCP de
observación incremental y verificación ya aporta algo distinto; lo que falta es
que esa evidencia sea estructurada, causal y operable por máquinas sin parsear
el texto pensado para un agente.

Al finalizar cerré el server y verifiqué con `pgrep`. El daemon huérfano fue
terminado por PID exacto y no quedó ningún `browse.mjs` ni `server.mjs` activo.
