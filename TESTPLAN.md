# Plan de testeo del snapDOM Agent

2026-08-01 · rama `agent-lab` · complementa `PAPER.md` (evidencia actual) y
`LANDSCAPE.md` (estado del arte y riesgos). Este documento responde tres preguntas
que hoy no están respondidas: **(1)** cuándo corresponde cada superficie de uso,
**(2)** si las superficies dan la misma respuesta, y **(3)** si un LLM con sus propias
herramientas disponibles *elige* usar esto — y en qué tipo de tarea.

Regla de este plan: cada fase declara **qué resultado la falsaría**. Una fase que solo
puede confirmar lo que ya creemos no es un test, es una demo.

---

## 1. Las cinco superficies, y cuándo se usa cada una

| # | Superficie | Qué es | Consumidor típico | Requiere CDP | Estado |
|---|---|---|---|---|---|
| S1 | **Core SDK** | `snapdom(el,{plugins:[agentOracle()]})` / `inspect()` | Código de producto: extensión MV3, copiloto embebido, webview | No | 50 tests |
| S2 | **CLI daemon** | `browse.mjs serve` + verbos (open/look/find/click/assert/…) | Agente que encadena N comandos por turno (Claude Code, Codex CLI) | Sí (Playwright propio) | Rondas Codex v2-v5 |
| S3 | **Servidor MCP** | 10 tools (`browser_open/find/act/verify/assert/…`) | Cualquier cliente MCP, como tools nativas | Sí (vía daemon) | GATE.md, bench-qa |
| S4 | **Companion MV3** | Content script isolated-world + postMessage | Agente que vive DENTRO del Chrome del usuario (panel Claude) | **No** | gate 27/27 |
| S5 | **Install global** | `~/.claude/snapdom-agent` + skill de usuario | Toda sesión de Claude Code de la máquina | Sí | Uso diario |

### Matriz de decisión (el árbol, en orden de corte)

1. **¿El agente vive dentro de la página del usuario?** (extensión, copiloto embebido,
   webview) → **S4** si es un agente de terceros que habla por postMessage; **S1** si
   es tu propio código. *Es el único caso sin alternativa en el mercado* — Playwright
   MCP, agent-browser, Stagehand y CUA necesitan CDP o browser propio.
2. **¿El consumidor es un agente con tools nativas configurables?** → **S3 (MCP)**.
   Es la vía de adopción correcta: `claude mcp add` es consentimiento del dueño de la
   máquina, no un protocolo pegado por chat (lección de las rondas del panel).
3. **¿El consumidor puede encadenar muchos comandos por turno de modelo?** → **S2**.
   Ventaja medida: 20 comandos en ~6 turnos vs 1 acción/turno de las extensiones.
4. **¿Es mi propia máquina, para todas las sesiones?** → **S5**.
5. **¿Necesita el browser real logueado del usuario?** → **S4 obligatorio** (S2/S3
   levantan Chromium aislado; ver el hallazgo de Reddit T6: la sesión tibia evita
   bloqueos, pero nadie recomienda el perfil diario — el trade-off es del usuario).

### Lo que la matriz NO cubre todavía (huecos de diseño, no de test)

- **Multi-tab / ventanas**: ninguna superficie lo soporta. agent-browser sí.
- **Restore de estado**: `cp` es checkpoint de observación, no undo (decisión, no bug).
- **Permisos finos**: `--readonly`/`--allow`/`--redact` son gruesos; no hay política
  por campo ni por destino.

---

## 2. Mapa de cobertura: qué está probado hoy

| Dimensión | S1 SDK | S2 CLI | S3 MCP | S4 Companion | S5 Global |
|---|---|---|---|---|---|
| Corrección del diff | ✅ 50 tests | — | ✅ bench-qa 19/19 | ✅ gate | — |
| Performance / bloqueo | ✅ scaling | ⚠️ JSONL | — | ✅ gate throttled | — |
| Fail-loud del assert | ✅ tests | ✅ smoke | ✅ codex-assert | ✅ gate | — |
| Privacidad / redacción | ✅ 8 tests | ✅ smoke | ✅ smoke | ✅ gate ×5 | — |
| Tarea real end-to-end | — | ✅ benchmark | ✅ benchmark | ✅ rondas panel | ⚠️ uso diario |
| **Paridad entre superficies** | ✅ Fase A | ✅ | ✅ | ✅ | — |
| **Verbos rec/parent/snap/cp/map** | — | ❌ **cero** | ❌ cero | — | ❌ |
| **Preferencia del LLM** | — | ❌ sesgado por skill | ❌ | ❌ | ❌ |
| **vs frameworks reales** | ❌ | ❌ | ❌ | ❌ | ❌ |

Las filas en negrita son este plan. La de verbos huérfanos se verificó con matcher
sobre `test/`, `experiment/`, `companion/gate.mjs` y `demo-qa/`: `rec` y `parent` no
aparecen en ningún lado, y `snap`/`cp`/`map` solo en `mcp/server.mjs`, que es la
implementación y no una prueba.

---

## Fase A — Paridad de superficies (barata, cierra un hueco estructural)

**Pregunta**: ¿las cinco superficies contestan lo mismo ante el mismo hecho?

Hoy cada una tiene su propio gate y ninguno cruza. Ya nos mordió: el bug de
`navigated` falso-positivo en `file://` existía en el daemon y no en la companion,
y apareció por casualidad en un demo run.

**Diseño**: 8 casos del corpus determinista (4 cambios reales + 4 de ruido) +
2 casos de SPA + 2 de oclusión, corridos por S1/S2/S3/S4 sobre las **mismas
fixtures locales**. Un runner único compara: `changed`, kinds emitidos, nombres,
`navigated`, `hasBaseline`, y el reporte de privacidad.

**Salida**: `experiment/parity.mjs` + tabla caso × superficie. Discrepancia = bug
de una de las superficies, y hay que decir cuál.

**Falsación**: si aparecen ≥2 discrepancias semánticas (no de formato), la promesa
de "mismo oráculo en todas las vías" es falsa y hay que arreglar antes de mostrar
esto a un tercero.

**Costo**: ~1 sesión, $0 (todo local, sin modelo).

### ✅ Resultado (2026-08-01, `experiment/parity.mjs`)

**PARIDAD OK a la primera: 0/8 desacuerdos de `changed`, 0/8 contradicciones con la
truth, y los kinds coinciden exactamente en las cuatro superficies.**

| fixture | truth | S1 SDK | S2 CLI | S3 MCP | S4 companion |
|---|:---:|---|---|---|---|
| text-update | true | content | content | content | content |
| list-row-inserted | true | added+moved+resized | ídem | ídem | ídem |
| button-enabled | true | state | state | state | state |
| modal-overlay | true | added | added | added | added |
| live-timestamp | false | — | — | — | — |
| css-animation-running | false | — | — | — | — |
| scroll-only | false | — | — | — | — |
| residual-hover | false | — | — | — | — |

Más los dos contratos que el corpus no cubría:

| contrato | S1 SDK | S2 CLI | S3 MCP | S4 companion |
|---|---|---|---|---|
| `becameCovered` (overlay tapa un botón) | 1 | 1 | 1 | 1 |
| `navigated` tras `pushState` | n/a por diseño | true | true | true |

**Falsa alarma diagnosticada (vale como resultado):** la primera corrida dio
`navigated:false` en las tres superficies y marcó PARIDAD ROJA. No era un bug del
producto: `history.pushState` a un path nuevo lanza `SecurityError` bajo origen opaco
(`file://`), así que la URL nunca cambiaba y `false` era la respuesta *correcta*. El
runner ahora sirve las fixtures por HTTP. Es la misma lección de la saga de perf —
medir el instrumento antes de acusar al sistema— y el motivo por el que el harness
quedó documentado.

Caveats declarados (el resultado vale menos de lo que parece si no se dicen):
- **S2 y S3 no son independientes**: el MCP es un traductor fino sobre el daemon, así
  que comparten motor. Las vías genuinamente independientes son tres: SDK crudo,
  familia daemon, y bundle de la companion.
- El corpus es el mismo contra el que se desarrolló el oráculo: esto prueba
  consistencia entre vías, **no** corrección en páginas nuevas.
- `navigated` es contrato de las superficies que rastrean URL; el SDK entrega el diff
  y no participa. Es diseño, no hueco.

---

## Fase A-bis — Features con cobertura CERO

**Hueco detectado en review externo** (verificado con matcher sobre `test/`,
`experiment/`, `companion/gate.mjs`, `demo-qa/`): los verbos `rec`, `parent`,
`snap`, `cp` y `map` **no aparecen en ningún gate, test ni benchmark**. Solo figuran
en `mcp/server.mjs`, que es la implementación, no una prueba. El plan original cubría
la familia observar/verificar e ignoraba una familia entera.

### Pregunta de producto ANTES de invertir tests en grabación

`rec` (GIF89a en JS puro + MediaRecorder, plugins públicos de snapdom, cero codecs
externos) no tiene consumidor definido. **Un LLM no mira un GIF cuadro por cuadro a un
costo razonable.** Si el consumidor es humano, el lugar natural de la grabación es
**evidencia adjunta a una aserción que falló** — un `assert` rojo que entrega 3
segundos de lo que realmente pasó. Eso encaja exactamente con el encuadre de "runtime
de postcondiciones" y además es dogfooding real de los plugins públicos (a diferencia
del video de Playwright, que depende de ffmpeg).

**Decisión a tomar antes de A-bis-2**: o `rec` se integra al fallo del assert (y
entonces se testea como parte del contrato), o queda como utilidad de demo (y entonces
alcanza con un smoke). No testear en profundidad algo cuyo consumidor no está definido.

### A-bis-1 · Smoke de los verbos huérfanos (barato, primero)

Por cada verbo: que corra en el bundle actual, que su salida tenga la forma
documentada, y el caso borde conocido. En particular:
- `rec`: formatos (gif/mp4/webm) y tamaños resultantes, límite de duración, overhead
  sobre el walk, `rec <id>` scopeado a un elemento vs body, y el caso documentado de
  que **una navegación aborta la grabación** (el elemento muere con el documento).
- `snap`: región clipeada vs viewport, y el caso de `content-visibility` (bug ya
  arreglado — vale como test de regresión).
- `cp save/list/diff`: que el baseline nombrado sobreviva navegaciones y que `diff`
  contra un checkpoint viejo dé el mismo resultado que el diff en vivo.
- `parent` / `map`: que `parent` suba a la card con ≥2 actionables y que `map <offset>`
  pagine sin perder ni duplicar entradas.

**Falsación**: cualquier verbo que falle en el bundle actual es deuda que estamos
ofreciendo a consumidores sin saberlo.

---

## Fase E — Head-to-head contra `vercel-labs/agent-browser`

**Hueco detectado en review externo**: es el rival más comparable que existe (misma
categoría: CLI + daemon + refs + find + MCP, repo público) y hasta ahora solo lo
miramos a nivel documental en `LANDSCAPE.md`. **Nunca corrimos una sola tarea contra
él.** Comparar leyendo su README no es comparar.

Verificado para este plan: se instala con `npm install -g agent-browser` (también brew
y cargo; CLI y daemon en Rust, Chrome for Testing auto-descargado), y expone
`snapshot`, `diff snapshot | screenshot | url`, `eval`, `screenshot`, `click/fill/type`
y un protocolo de plugins `agent-browser.plugin.v1` por stdio.

### E1 · Diff determinista, sin modelo (la más importante, primero)

Agregar agent-browser como **cuarto brazo en `bench-qa.mjs`**, junto a pixel-diff y
a11y-diff, sobre las 19 fixtures con truth manual.

Hipótesis a testear (no a asumir — hay que leer qué hace su `diff snapshot` de verdad,
no fiarse de nuestras notas): que un diff de texto del árbol de accesibilidad **pierde
los cambios sin delta textual** (el flip de `disabled`, que es justo el caso que
pixel-diff también pierde) y que **reporta ruido donde el texto se reordena**.

**Falsación, dicha sin eufemismos**: si su diff saca 19/19, nuestra afirmación central
se cae y tenemos que ser los primeros en saberlo.

### E2 · Los contratos donde afirmamos ventaja

Reusar las fixtures de `parity.mjs`:
- **Oclusión**: ¿avisa que el botón quedó tapado *antes* del click? (nosotros:
  proactivo en el mapa; ellos, según su doc: error reactivo post-click).
- **Identidad**: ¿sus refs `@eN` sobreviven un remount de React o una lista
  reordenada? Ellos documentan que **no** son estables; nuestros `n_xxx` los medimos
  deterministas para el mismo DOM. Hay que verificar ambas mitades.
- **SPA**: qué reporta tras una navegación blanda.

### E3 · Brazo en los benchmarks que ya existen (cuando corra la Fase C)

Sumar `agent-browser` como brazo en `experiment/formal/` (10 tareas, mismo modelo,
mismo juez externo) y en la app de fallas silenciosas de la Fase C. Es casi gratis
porque el harness ya está: solo cambia el runner.

**Higiene**: el dato de Reddit (r/AI_Agents `1uc0bbi`: "the worst one in speed…
couldn't get simple task done") es **una anécdota de un solo usuario**, no un
resultado. Sirve como hipótesis a verificar, jamás como cita.

### E4 · Auditoría de dónde ELLOS ganan (la parte que da credibilidad)

Capa de permisos (`--action-policy`, `--confirm-actions`, `--content-boundaries`),
sesiones y multi-tab, auth vault, dashboard, scoping del snapshot. Sale directo a
nuestro backlog en vez de barrerse bajo la alfombra. Un head-to-head donde el rival no
gana nada es un head-to-head mal hecho.

### E5 · Prueba de coexistencia (la jugada estratégica)

Tienen `eval` y protocolo de plugins. **¿Se puede inyectar nuestro SDK dentro de su
flujo y obtener el diff sin reemplazarlos?** Si funciona, dejan de ser rival y pasan a
ser **canal de distribución** — que es exactamente la debilidad #1 del `LANDSCAPE`
(distribución inexistente). Es la fase con mejor relación valor/costo de todo el plan
si E1 sale bien.

---

## Fase B — Preferencia revelada del LLM en sesiones largas

**Pregunta del usuario**: ¿al propio LLM le resulta preferible usarlo antes que sus
propias herramientas? Y crucialmente: **¿en qué tipo de tarea?**

**El sesgo a evitar**: hoy la skill `agent-browse` le *dice* a Claude Code que use el
oráculo por defecto. Cualquier medición con esa skill activa mide obediencia, no
preferencia. Hay que apagarla.

**Diseño — tres brazos, misma sesión de modelo**:

- **B1 · Elección libre (el dato principal)**: ambos toolsets disponibles
  (MCP snapdom + tools nativas del cliente), **sin skill ni instrucción de preferencia**,
  prompt neutro: "resolvé esta tarea con las herramientas que quieras". Se mide qué
  herramienta elige *por paso*, no por tarea.
- **B2 · Elección libre con justificación**: idéntico, pero pidiendo una línea de
  por qué eligió cada herramienta. Da el *porqué* cualitativo; se corre aparte porque
  pedir justificación altera la elección.
- **B3 · Control forzado**: solo tools nativas / solo oráculo. Da el techo de cada
  canal y detecta si la elección libre fue peor que cualquiera de los dos puros
  (señal de que mezclar confunde).

**Tareas: largas y reales, no las 10 del benchmark formal.** El benchmark actual usa
tareas de 2-8 acciones donde todos los brazos llegan (119/120) — no discriminan.
Aquí hacen falta **misiones de 15-40 acciones** sobre sitios reales, del tipo:

1. Investigación multi-página con extracción acumulada (comparar 5 items entre 3
   páginas y producir una tabla).
2. Flujo con formulario multi-paso y validación (llenar, disparar un error de
   validación a propósito, corregirlo, confirmar el efecto).
3. Navegación SPA profunda con hidratación (GitHub: Code→Issues→filtro→issue→
   volver, verificando cada transición).
4. Tarea sobre página gigante (>50k px de scroll) con búsqueda de un elemento bajo
   el fold + acción sobre él.
5. Tarea con ruido ambiental (sitio con carrusel/reloj) donde hay que distinguir
   "mi acción funcionó" de "la página se movió sola".
6. Tarea de recuperación: un paso falla a propósito (elemento tapado por un banner)
   y hay que detectarlo y resolverlo.

**Métricas**:
- **Tasa de elección por tipo de tarea y por paso** (el dato que responde la pregunta).
- **Punto de cruce de tokens**: costo acumulado por turno, brazo vs brazo, a lo largo
  de la sesión. Hipótesis a testear: el oráculo pierde el primer turno (digest ~3KB)
  y gana a partir del turno N. **N nunca fue medido** — es deuda pendiente desde el
  sweep de 35 sitios.
- Éxito juzgado externamente (mismo `judge.mjs`), acciones, wall time.
- Abandono: ¿empieza con una herramienta y se pasa a la otra? ¿En qué momento?

**Falsación (importante)**: si en B1 el modelo elige las tools nativas en la mayoría
de los pasos *y* las tareas se completan igual, entonces el valor percibido no
existe y el producto necesita otro encuadre (o el pitch no es "mejor percepción" sino
solo "verificación", que es la Fase C). Ese resultado hay que reportarlo tal cual.

**Costo**: 6 tareas × 3 brazos × 3 reps ≈ $20-40 de API. Se puede empezar con 1 rep
exploratoria (~$5) para calibrar tareas antes de gastar.

---

## Fase C — False-green diferencial contra frameworks reales (el test decisivo)

**Pregunta**: ¿el oráculo caza fallas que browser-use / Playwright MCP / Stagehand
dan por buenas? Esta es la prueba que convierte la tesis en producto — y es la que
propuso la revisión externa del `LANDSCAPE.md`.

**Por qué es la decisiva**: la literatura mide que el false-success es 45-48% de las
fallas sin verificador independiente y 3% con él (Advani, FAGEN@ICML2026 — ojo:
workshop, autor único, dominios de tool-use no browser). Si ese efecto se reproduce
en browser con frameworks reales, el pitch tiene respaldo externo *y* demostración
propia. Si no se reproduce, hay que decirlo.

**Diseño**: una app de pruebas con **fallas silenciosas plantadas** (el patrón
`demo-qa`, extendido). Cada caso es una acción que *parece* funcionar:

| Caso | Qué pasa realmente | Qué ve un canal sin verificación |
|---|---|---|
| Botón no-op | El handler no hace nada | La página "se ve igual pero con el reloj corriendo" |
| Submit que falla en silencio | Validación server-side rechaza, sin mensaje visible | Formulario limpio = parece éxito |
| Click interceptado | Un overlay transparente come el click | Screenshot idéntico |
| Toast que ya se fue | El efecto ocurrió y desapareció antes del screenshot | Nada que ver |
| Fila insertada fuera de viewport | La acción funcionó pero no se ve | Parece no-op |
| Estado sin delta visual | `disabled` → `enabled`, mismo pixel | Invisible |
| Doble submit | Se insertaron 2 filas en vez de 1 | Parece éxito |
| SPA a medio hidratar | La URL cambió, el contenido no llegó | Parece navegación OK |

**Brazos**: (1) browser-use, (2) Playwright MCP, (3) Stagehand si el tiempo alcanza,
(4) snapDOM Agent vía MCP. Todos con **el mismo modelo** y la misma consigna:
"hacé X y decime si funcionó".

**Métrica única y honesta**: **false-green rate** = casos donde el brazo reporta
éxito y el juez externo (chequeo directo del estado de la app, sin ningún brazo de
por medio) dice que no ocurrió.

**Falsación**: si los frameworks rivales cazan estas fallas con tasas similares
—porque re-perciben y el modelo se da cuenta— la diferenciación central se cae, y lo
que queda es costo de tokens (donde hay competencia agresiva: Rote, Opera, OpenBrowser).
Este es el resultado que más nos costaría y por eso es el que más vale medir.

**Nota metodológica**: hay que ser escrupulosamente justos con los rivales — última
versión, configuración recomendada por sus docs, sin prompts que los saboteen, y
publicar los transcripts. Un benchmark que se gana haciendo trampa no sirve ni para
convencernos a nosotros.

**Costo**: ~1-2 sesiones de setup + $10-20 de API.

---

## Fase D — Benchmark de terceros (credibilidad externa)

**Pregunta**: ¿los números aguantan en tareas que no escribimos nosotros?

Nuestro benchmark formal da 119/120 con tareas propias — y ese 100% sugiere que son
*fáciles*, no que el canal sea superior (los benchmarks públicos miden ~30% de éxito
real en tareas comparables). Es la brecha más citable que tenemos.

**Diseño**: correr un subset de **Online-Mind2Web** (tareas vivas, key-nodes) o
**WebArena** (self-hosted, reproducible) con los brazos del harness formal. Reusar
`experiment/formal/` cambiando solo la fuente de tareas y el juez.

**Falsación**: si el brazo oráculo no mejora al nativo en un corpus ajeno, el
resultado del benchmark propio era un artefacto del diseño de tareas.

**Costo**: 1-2 sesiones + API según subset. Es la mejora de credibilidad más grande
por peso invertido, pero va después de C porque C decide si hay producto.

---

## 2-bis. RESULTADOS DEL CICLO (2026-08-01)

Corrido de forma autónoma en una sesión. Todo determinista, sin gasto de API.

| Fase | Resultado | Reporte |
|---|---|---|
| **A** paridad de superficies | ✅ 8/8 fixtures + oclusión + SPA, cuatro superficies de acuerdo | (en este doc) |
| **E1** agent-browser en bench-qa | ✅ corrido: **11/19 tal cual sale · 17/19 normalizado** vs nuestro 19/19 | `results/e1-agent-browser.md` |
| **E2** contratos afirmados | ⚠️ **2 ventajas confirmadas, 1 suposición nuestra refutada, 1 límite propio** | `results/e2-contracts.md` |
| **A-bis** verbos sin cobertura | ✅ 19/19 en las DOS instalaciones (repo y global) + 2 hallazgos (ranking engaña, doc de `rec` desactualizada) | `results/abis-verbs.md` |
| **C** false-green diferencial | ✅ **0 vs 6 falsos verdes sobre 8** (criterio pedía ≥30 pts, dio 75) | `results/c-false-green.md` |
| **E5** coexistencia | ✅ **el oráculo corre DENTRO de agent-browser** por su `eval --stdin` | `results/e5-coexistence.md` |
| **B** preferencia revelada | ✅ **el modelo elige el oráculo en 78% de los pasos** sin skill que sesgue; tokens 5× | `results/b-preference.md` |
| **D** benchmark de terceros | ⚠️ **28% en tareas ajenas vs 99% en las nuestras**; brazo de píxeles incompleto | `results/d-third-party.md` |

### Los tres resultados que cambian el pitch

1. **La tesis se sostiene, pero el margen depende del rival.** Contra pixel-diff
   (13/19) y a11y-tree (16/19) la distancia es grande; contra un agent-browser bien
   normalizado es 19/19 vs 17/19. La ventaja está concentrada en **ruido textual** y
   **cambios sin representación textual**.
2. **El valor NO es el diff, es la aserción.** En la Fase C nuestro propio `look`
   crudo produjo 2 falsos verdes; el `assert` de postcondición produjo 0. Es la
   confirmación medida del reencuadre a **runtime de postcondiciones**.
3. **agent-browser puede ser canal, no rival.** 45 KB por su `eval` y su flujo queda
   intacto.
4. **El modelo prefiere el oráculo cuando puede elegir** — 78% de los pasos, en las seis
   tareas, sin nada que lo sesgue. Pero también usa píxeles para orientarse: apoya el
   híbrido, no el reemplazo.
5. **Nuestras tareas eran fáciles, y ahora está medido.** 99% en nuestro benchmark vs
   **28% en tareas de terceros** (Mind2Web-Live, sus key nodes). El 119/120 mide el
   canal en tareas alcanzables, no capacidad. Y en ese corpus ajeno **no hay evidencia
   de que el canal semántico mejore el éxito** — la ventaja medida está en costo y
   verificación, no en capacidad.

### Lo que este ciclo corrigió de nuestras propias afirmaciones

- ~~"un diff textual del a11y tree pierde el flip de `disabled`"~~ → **falso**, lo
  detecta (viaja en la serialización).
- ~~"sus refs no sobreviven un remount"~~ → **falso**, sobreviven (`e1 → e1`).
- ~~"seguimos la identidad a través de reordenamientos"~~ → **con matices**: depende
  de la riqueza de los nombres; con nombres cortos declara incertidumbre.
- ~~"una navegación aborta la grabación"~~ → **no ocurre** (doc desactualizada).

### Higiene de medición

Siete bugs de método propios, todos encontrados y corregidos antes de creer ningún
número: `diffPixels` mal invocado (0,000% en todo), click programático que atravesaba
el overlay, click por coordenadas fuera del viewport, asimetría `eval` vs click real
contra el rival, y un juez que medía "¿mutó algo?" en vez de "¿se cumplió la
postcondición?". Más el `execFile`+`input` de E5 y, en la Fase D, un `catch { break }`
que silenciaba errores de API y hacía leer cinco episodios muertos como "0 key nodes"
legítimos. **Ningún resultado de este ciclo sobrevivió a su primera corrida sin
revisión, y el fallo mudo apareció tres veces en mi propio harness** — el mismo patrón
que el producto persigue en las páginas.

## 3. Orden propuesto y criterio de corte

```
A ✅  →  E1 ($0, ataca la afirmación central)  →  A-bis  →  C + E3 (misma corrida)  →  E5  →  B  →  D
                                                              ↑ E2 y E4 acompañan a E1
```

- **A primero** (hecha): gratis, y mostrarle a un tercero superficies que no concuerdan
  entre sí quema credibilidad.
- **E1 inmediatamente después**: es determinista, sin modelo, cuesta $0 y apunta
  directo a la afirmación de la que cuelga todo el pitch. Si el diff del rival empata,
  todo lo demás cambia de sentido — mejor saberlo antes de gastar en C.
- **A-bis antes de C**: barato, y no tiene sentido llevar a un head-to-head un bundle
  con verbos que nunca se probaron.
- **C y E3 en la MISMA corrida**: agent-browser entra como brazo de la app de fallas
  silenciosas en vez de pagar dos veces el setup.
- **E5 después de C**: si hay diferenciación demostrada, la coexistencia se vuelve
  canal de distribución; si no la hay, no hay nada que distribuir.
- **B antes que D** porque B es más barato y su resultado cambia qué se mide en D.

**Criterio de corte honesto**: si C muestra false-green diferencial ≥30 puntos a
favor y A está limpio, hay caso para buscar el primer consumidor real (F4 del PLAN.md).
Si C sale parejo, el encuadre correcto pasa a ser el que sugirió la revisión externa:
**runtime de postcondiciones para automatizaciones web**, o directamente una feature
de snapdom / tecnología licenciable — no un producto independiente.

---

## 4. Qué NO está en este plan (a propósito)

- Más features del oráculo. La prioridad es validación externa y distribución, no
  superficie nueva.
- Mejorar el 19/19 o el 119/120: ya no informan nada.
- Multi-tab, restore, permisos finos: se difieren hasta que un consumidor real los
  pida — pero E4 los va a documentar como ventaja del rival, que es distinto a
  ignorarlos.
- Publicar cualquier cosa (npm, store, repo público).

## 5. Historial de huecos del plan (para no repetirlos)

Este documento nació cubriendo solo la familia observar/verificar. Un review externo
encontró dos omisiones que valen como lección de método:

1. **Familia de features entera sin testear** (`rec`/`snap`/`cp`/`parent`/`map`): el
   plan miró las superficies y no el inventario de verbos. Regla nueva: antes de
   planificar tests, listar TODO lo que el producto expone y marcar qué no toca ningún
   gate.
2. **Comparable nunca ejecutado**: agent-browser estaba analizado en `LANDSCAPE.md` a
   nivel documental y eso se sintió como cobertura. No lo es. Regla nueva: una
   herramienta que no se corrió no está medida, por más prolija que sea la ficha que le
   escribimos.

3. **La instalación que usamos todos los días no estaba en ningún gate** (2026-08-01).
   Los gates corrían siempre contra el árbol del repo; el install global
   (`~/.claude/snapdom-agent`) nunca se ejecutó en una prueba. Ahí el bundle `sdk.js`
   se construía desde una SEGUNDA copia de la fuente de entrada, que nunca recibió
   `redactString`: `window.__agentRedact` quedaba undefined y `find`, `text` y `assert`
   tiraban "is not a function" DENTRO de la página. `open` seguía funcionando, así que
   el daemon parecía sano. Reglas nuevas: (a) toda definición de bundle vive en UN solo
   archivo (`tools/sdk-bundle.mjs`, con verificación de los globals al construir);
   (b) los gates aceptan `--daemon <path>` y se corren también contra el install global;
   (c) el bundle de la companion se re-genera y se compara antes de creer su gate —
   estaba atrasado respecto de `91daf6d` (las correcciones F3 de privacidad NO estaban
   en la extensión cargada en Chrome).

4. **Cuatro harnesses terminaban y no salían** (2026-08-01). `e1`, `e2`, `e5`,
   `c-false-green` y `b-preference` escribían sus resultados y quedaban colgados con el
   servidor de fixtures vivo por un socket keep-alive. Medido: >10 min de cuelgue sobre
   un trabajo real de 43 s. Un CI con timeout habría reportado rojo un experimento que
   salió bien. Regla nueva: todo harness con `createServer` cierra conexiones y sale con
   `process.exit` sobre el resultado.
