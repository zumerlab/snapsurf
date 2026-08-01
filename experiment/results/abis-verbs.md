# A-bis — Los verbos que nunca se habían probado

2026-08-01 · runner: `experiment/abis-verbs.mjs` · **13/13 checks OK**

Cobertura previa verificada con matcher sobre `test/`, `experiment/`,
`companion/gate.mjs` y `demo-qa/`: `rec` y `parent` no aparecían en ningún lado;
`snap`, `cp` y `map` solo en `mcp/server.mjs`, que es implementación, no prueba.

## Resultado por verbo

| Verbo | Checks | Estado |
|---|---|---|
| `parent` | localiza y sube a la card con ≥2 actionables (ve link **y** botón) | ✅ |
| `map` | primera página 40 ids · offset 40 devuelve 22 nuevos · **sin solapamiento** | ✅ |
| `snap` | PNG de 60 KB de la región + ancestro de contexto | ✅ |
| `cp` | `save` / `list` / `diff` contra el checkpoint nombrado | ✅ |
| `rec` | GIF 296 KB y MP4 75 KB del body (2 s) · scopeado a un elemento · sobrevive una navegación | ✅ |

`rec` produce **GIF89a por gifExport y MP4 por videoExport**, ambos con los plugins
públicos de snapdom (cero codecs externos). Overhead medido: 2.200 ms para 2 s de GIF
y 2.053 ms para 2 s de MP4 — es decir, ~tiempo real, sin penalización relevante.

## Dos hallazgos que solo aparecen probando

### 1. El scoping de `rec` funciona; lo que engaña es tomar el primer id de `find`

Primera corrida: la grabación "scopeada" pesaba lo mismo que la del body y medía
1280×800. Parecía que `rec <id>` ignoraba el scope. **No es así.** Grabando la card
por su id exacto el resultado es **326×106 px**, idéntico a su caja CSS.

Lo que había pasado: mi test tomaba `match(/n_\w+/)` — el **primer** id del `find`
rankeado — y para la consulta "Producto destacado" el primer hit era un **wrapper de
página (1264×270)**, no el heading ni la card. Es la conducta conocida del ranking
(los contenedores concatenan el nombre accesible de sus hijos y matchean todo).

**Consecuencia para consumidores** (y para nuestra propia doc): *nunca tomar el primer
id de `find` a ciegas* — hay que leer rol, nombre y bbox antes de actuar. El eco de
`click` existe justamente para eso, pero `rec`/`snap` no tienen ese eco.

### 2. Divergencia doc-vs-comportamiento: la navegación NO aborta la grabación

Está documentado que "una navegación aborta la grabación (el elemento muere con el
documento)". Medido: con una grabación de 4 s y una navegación **real a otra URL** a
los 800 ms, la grabación **terminó normalmente** y produjo un GIF válido de 591 KB.

O la doc quedó vieja, o el comportamiento cambió. Hay que resolver cuál antes de
prometerle nada a un consumidor sobre este borde.

## Pendiente de decisión (no de test)

`rec` sigue sin consumidor definido. Un LLM no mira un GIF cuadro por cuadro a costo
razonable; si el consumidor es humano, el lugar natural es **evidencia adjunta a un
`assert` que falla**. Hasta que eso se decida, estos checks son un smoke de que el
verbo no está roto, no una validación de producto.
