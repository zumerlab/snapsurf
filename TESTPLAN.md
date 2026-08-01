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
| S1 | **Core SDK** | `snapdom(el,{plugins:[agentOracle()]})` / `inspect()` | Código de producto: extensión MV3, copiloto embebido, webview | No | 58 tests |
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
| Corrección del diff | ✅ 58 tests | — | ✅ bench-qa 19/19 | ✅ gate | — |
| Performance / bloqueo | ✅ scaling | ⚠️ JSONL | — | ✅ gate throttled | — |
| Fail-loud del assert | ✅ tests | ✅ smoke | ✅ codex-assert | ✅ gate | — |
| Privacidad / redacción | ✅ 8 tests | ✅ smoke | ✅ smoke | ✅ gate ×5 | — |
| Tarea real end-to-end | — | ✅ benchmark | ✅ benchmark | ✅ rondas panel | ⚠️ uso diario |
| **Paridad entre superficies** | ❌ **nadie** | ❌ | ❌ | ❌ | ❌ |
| **Preferencia del LLM** | — | ❌ sesgado por skill | ❌ | ❌ | ❌ |
| **vs frameworks reales** | ❌ | ❌ | ❌ | ❌ | ❌ |

Las tres filas en negrita son este plan.

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

Caveats declarados (el resultado vale menos de lo que parece si no se dicen):
- **S2 y S3 no son independientes**: el MCP es un traductor fino sobre el daemon, así
  que comparten motor. Las vías genuinamente independientes son tres: SDK crudo,
  familia daemon, y bundle de la companion.
- **Cobertura parcial vs lo planificado**: faltan los 2 casos de SPA y los 2 de
  oclusión que este plan pedía. La paridad está probada sobre cambios de contenido/
  estado/estructura y sobre ruido, no sobre navegación blanda ni `becameCovered`.
- El corpus es el mismo contra el que se desarrolló el oráculo: esto prueba
  consistencia entre vías, **no** corrección en páginas nuevas.

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

## 3. Orden propuesto y criterio de corte

```
A (paridad, $0)  →  C (false-green diferencial, decisivo)  →  B (preferencia)  →  D (terceros)
```

- **A primero** porque es gratis y porque mostrarle a un tercero superficies que no
  concuerdan entre sí quema credibilidad.
- **C antes que B** porque C decide si hay producto; B refina el pitch. Si C sale
  mal, B es un ejercicio sobre algo que no importa.
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
- Multi-tab, restore, permisos finos: se difieren hasta que un consumidor real los pida.
- Publicar cualquier cosa (npm, store, repo público).
