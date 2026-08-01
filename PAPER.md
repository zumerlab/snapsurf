# snapDOM Agent: un oráculo semántico de cambios para agentes web — métricas medibles y reproducibles

Borrador v0.1 · 2026-07-31 · rama `agent-lab` (privada) · datos: `packages/agent/experiment/results/`

## Abstract

Los agentes que operan páginas web perciben mediante screenshots y árboles de
accesibilidad: canales caros en tokens, ciegos a cambios funcionales sin delta visual, y
propensos a *false greens* (creer que una acción funcionó cuando no). snapDOM Agent es un
oráculo de cambios post-layout que responde **qué cambió** entre dos observaciones del DOM
(kinds semánticos + rol + nombre + selector + oclusión), corre sin CDP (extensiones MV3,
copilots embebidos) y entrega píxeles y semántica del mismo instante. Este documento
presenta las métricas en tres capas — (1) calidad de representación sin modelo,
determinista y CI-able; (2) agente en el loop (task completion, acciones, tiempo, tokens);
(3) verificación de acciones y tasa de false-green — más una dimensión propia: robustez al
mal uso por parte de agentes. Todos los números citados salen de artefactos versionados en
este repo y se regeneran con los comandos del Apéndice A.

## 1. Qué se mide (y qué no)

La mayoría de las métricas "de agentes web" (task completion, grounding) miden el sistema
completo: modelo + prompt + harness + herramienta, mezclados. Para evaluar la
**herramienta** separamos tres capas:

- **Capa 1 — representación**: ¿la observación es correcta? Sin modelo en el loop,
  ground truth escrita a mano, 100% determinista. Es la capa donde el resultado es un
  hecho, no una tendencia.
- **Capa 2 — agente en el loop**: con un modelo fijo y tareas fijas, ¿cambia el resultado
  según el canal de percepción? Aquí sí aparecen task completion, pasos, tokens, costo.
- **Capa 3 — verificación**: ¿el agente *sabe* si su acción funcionó? Métrica que los
  canales baseline no pueden medirse a sí mismos: costo por tarea completada **y
  verificada**, y tasa de false-green.

**Regla anti-circularidad**: en las capas 2 y 3 el juez de éxito es siempre **externo a la
herramienta medida** (checks Playwright independientes o verificación manual contra la
página real), jamás el propio `assert` del oráculo.

**Baselines**: el stack que cada agente ya tiene, tal como lo tiene. (a) Sin CDP posible
(extensiones/copilots — el nicho principal): screenshot + read_page + find de la extensión
de Claude, y el equivalente nativo de ChatGPT. (b) Con CDP: a11y snapshot de Playwright +
pixel-diff perceptual.

## 2. Capa 1 — calidad de representación (determinista, sin modelo)

### 2.1 Detección de cambios con ground truth (`bench-qa`)

Corpus de 19 fixtures con truth manual: 11 cambios semánticos reales + 8 casos de RUIDO
(churn visual sin cambio semántico: animación corriendo, timestamp vivo, scroll, hover
residual, píxeles de canvas). El brazo oráculo corre **a través del servidor MCP**
(`browser_open` + `browser_verify`): mide el producto, no una API interna.

| Brazo | Correctos | Falsos positivos (ruido) | Cambios perdidos | Evidencia por caso |
|---|---:|---:|---:|---|
| **Oráculo (browser_verify)** | **19/19** | **0/8** | **0/11** | 360–958 B de kinds+names+selectors |
| Pixel-diff perceptual (clase pixelmatch, @zumer/snapdiff) | 13/19 | 5/8 | 1/11 | 2 screenshots (23–98 KB) |
| a11y-tree (Playwright) | 16/19 | 2/8 | 1/11 | 2 árboles JSON a diffear |

Detalle narrativo: el único cambio que pixel-diff **perdió** es un flip de `disabled` sin
delta visual — un cambio funcional invisible a píxeles. Los dos que a11y perdió incluyen
un font-swap tardío que sí altera el render. Fuente: `experiment/results/bench-qa.md`
(+ `.json` crudo); reproducción: Apéndice A.

### 2.2 Economía de tokens

- **Turno incremental (diff)**: p50 **19 tokens** vs ~**1.365 tokens** de un screenshot
  (~70×). Fuente: sweep de 35 sitios reales (`experiment/results/sweep.json`).
- **Primer turno (mapa inicial)**: honestidad — el outline completo era MÁS caro que un
  screenshot en 31/35 sitios; motivó el digest compacto (Wikipedia 12,4 KB → 3,4 KB,
  −73%). La ganancia estructural está en el diff, no en el primer vistazo.
- Ejemplo puntual del demo QA: aserción de no-op = **61 bytes** de evidencia del oráculo
  vs 264 px de diff espurio en el brazo pixel (§4).

### 2.3 Costo de cómputo y escalado

- Walk troceado por presupuesto de tiempo (MessageChannel, slices de 40 ms): página de
  13k nodos = **~1,1 s de walk total, bloqueo máximo del main thread 42–69 ms** (antes:
  1,3–7 s monolíticos). Cada observación registra `walkDetail:{slices,maxSliceMs}` en
  JSONL — el presupuesto es auditable por observación, no declarado.
- Costo por nodo **plano** (no supra-lineal): 24–46 µs/nodo de 282 → 14k nodos sintéticos;
  lanacion 43 µs vs Wikipedia 30 µs/nodo (`experiment/scaling.mjs`). El "35×" observado en
  entornos CDP throttleados se reprodujo y explicó como efecto umbral ambiental (tic de
  ~1 Hz del instrumento), no del bundle.
- Referencia de proporción: el walk (0,3–1 s) contra ~4,2 s de una llamada al modelo.

### 2.4 Cobertura de deployment (el argumento estructural)

- **MV3 / CSP real**: 3/3 sitios OK en isolated world bajo CSP real (incluido GitHub)
  (`experiment/mv3/`). Donde Playwright/CDP no puede existir, esto funciona.
- Sweep 35 sitios reales: 18/35 con CERO ruido en reposo; los 17 restantes son movimiento
  decorativo real (carruseles/marquesinas) → mitigable con `noise.ignore`/scoped roots.
- Gate automatizado de la companion: **22/22 checks** (contrato fail-loud, presupuestos de
  bloqueo, oclusión corroborada contra `elementFromPoint`, no-op fiel, SPA `navigated`).

## 3. Capa 2 — agente en el loop

### 3.1 Piloto con modelo vía API (brazos de percepción, mismo modelo y tareas)

10 tareas reales (Wikipedia, eBay, npm, Python docs), sonnet-5, juez por golden path.
**Estatus: piloto** (n=1 por celda) — dimensiona el efecto, no lo establece.

| Brazo (canal de percepción) | Éxito | Pasos prom. | Nota |
|---|---:|---:|---|
| A — screenshot nativo | 9/10 | 3,4 | |
| B — oráculo solo | 8/10 | 3,3 | gana la tarea bajo el fold en 1 paso; pierde por ceguera de verificación en npm |
| C — screenshot + oráculo | **10/10** | 3,1 | único brazo perfecto con captura nativa |
| D — snapdom PNG (`clip:'viewport'`) + oráculo, misma captura | **10/10** | **2,9** | mejor promedio de pasos; render snapdom = model-grade |

Costo total de la serie: **$2,12**. Lectura de producto: con captura disponible, el
oráculo suma lo que los píxeles no dicen (C > A); sin captura posible (embebidos, el nicho
sin competencia), D entrega la configuración ganadora en una sola llamada.
Fuente: `experiment/results/realloop*.json`.

### 3.2 Head-to-head contra tooling nativo de Claude (claude-in-chrome), sitios reales

5 tareas (HN, GitHub, Wikipedia-link-a-73k-px, npm, eBay), tope 15 acciones, mismo
ejecutor corriendo ambos brazos. Ronda 2 con tiempos de pared en ambos:

| Métrica | snapDOM Agent (CLI/daemon) | Claude nativo (extensión Chrome) |
|---|---|---|
| Tareas | **5/5** | 2/4 útil + 1 DNF de entorno |
| Acciones | 20 comandos | 27 llamadas (una llegó al tope de 15) |
| Tiempo total | **21,2 s** de pared (19,7 s de daemon) | 219 s end-to-end |
| Peor tarea | eBay 12,1 s | eBay 124,7 s (falló) |

- Ejecución pura 5–25× más rápida por tarea; el peor caso del agente (12 s) ≈ el mejor
  caso end-to-end del nativo (14 s).
- Caso insignia (T3): el `find` nativo muere con `299.206 tokens > 200.000` y `read_page`
  trunca a 50 KB — el link a 73.687 px nunca entra. El agente: `find` in-page 1–8 ms +
  click por id con auto-scroll, 4 comandos.
- **Asimetrías declaradas**: el CLI encadena N comandos por turno del modelo, la extensión
  fuerza ~1 acción/turno (ese turnaround ES parte de operar esa interfaz, pero se reporta
  separado). El DNF de T1 (bloqueo noprocrast de la cuenta del usuario) es costo de operar
  EN el browser del usuario, no del tooling — se excluye del marcador y se reporta.
- Ronda 1 (pre-fixes de ranking): 4/5·27 vs 4/5·27, fallas complementarias. Los fixes que
  salieron de esa falla (find rankeado, `parent`, `map`) llevaron el brazo agente a
  5/5·21. Fuente: `experiment/results/claude-vs-chrome.md`.

### 3.3 Replicación independiente (Codex, a ciegas)

Codex (agente de OpenAI) corrió las mismas 5 tareas usando el snapDOM Agent, sin acceso a
nuestros resultados, en 5 rondas sucesivas (v1→v5, `experiment/results/codex-self*.md`):

- v2: 5/5 · 25 acciones · cero imágenes; v3: 5/5 · 27 · opens −47%; v4: 5/5 · 20 · 27,6 s
  (con desglose de duraciones); v5: 5/5, veredicto volteado a "act→assert es una primitive
  útil, la usaría hoy como capa de observación/verificación".
- Vía MCP puro (solo `tools/list`, sin docs): 5/5 · 25 calls · 19,98 s.
- Valor metodológico: números casi idénticos a los nuestros por un ejecutor independiente
  con incentivo crítico (cada ronda entregó objeciones que produjeron fixes).

**Nota honesta**: esto es Codex *usando* el snapDOM Agent — no es todavía el brazo
"ChatGPT nativo vs snapDOM Agent". Ese brazo se define en §6.

## 4. Capa 3 — verificación de acciones y false-green

La métrica que los baselines no pueden medirse a sí mismos: ¿el agente sabe si su acción
tuvo efecto?

- **Demo reproducible** (`demo-qa/`, corre TODO vía MCP): app con ruido ambiental
  deliberado (reloj vivo + spinner). T1 add-item: PASS 3/3 checks con `added "Buy milk"`.
  T2 **no-op**: `changed:false` mientras el reloj corre — el brazo pixel muestra **264 px
  de diff en el mismo no-op** (aserción visual flaky). Evidencia oráculo: 61 bytes.
- **Incidentes de campo** (uso real, FIELD.md): un comentario borrado en Reddit y 3 no-ops
  consecutivos en lanacion que el canal visual dio por buenos — el diff los expuso. Un
  agente sin esta señal continúa con estado falso.
- En bench-qa (§2.1), el único miss de pixel-diff es exactamente esta clase: cambio
  funcional sin delta visual.

Métricas propuestas para el benchmark formal: **false-green rate** (acciones reportadas
como exitosas que el juez externo marca sin efecto) y **costo por tarea completada Y
verificada** (no solo completada).

## 5. Robustez al mal uso (la herramienta la operan agentes)

Los consumidores son LLMs: van a pasar specs con typos, ids stale, asserts sin
re-baseline. El contrato es *fail-loud*: bajo confusión, el default es ROJO diagnóstico,
nunca verde.

Datos de campo (rondas de consumo real con Claude-panel y Codex):
- 5/5 fail-loud en la ronda GitHub fueron errores del consumidor (spec/timing), todos
  expuestos con razón legible; 2/2 specs malos deliberados de Codex → rojos diagnósticos.
  **False-green bajo misuse observado: 0.**
- Recuperación típica: 1–2 llamadas, sin humano.
- La tasa de misuse se usa como telemetría de diseño: de ahí salieron `help`, el flag
  `navigated` post-SPA, y los docs de hidratación.
- Gap conocido de la clase: ids stale cross-sesión pueden resolver a OTRO elemento;
  defensa = eco de role/name antes de actuar + click que rehúsa ruidoso si el target está
  clipeado (`denied:offscreen` nombrando el contenedor).

El benchmark formal agrega un **brazo de misuse** (typos de spec, ids stale, assert sin
re-baseline post-SPA, strings inexistentes, specs vacíos) contra cada método: se mide qué
canal miente bajo error del operador.

## 6. Benchmark formal: 4 brazos, reproducible — CORRIDO (n=3 por brazo)

Lo anterior separa lo **ganado** (capa 1, determinista) de lo **piloteado** (capa 2, n
chico). El benchmark formal cierra la brecha y agrega el brazo ChatGPT. **El harness
completo está en `experiment/formal/`**: suite de tareas (`TASKS.md`), juez externo
(`judge.mjs`), agregador (`report.mjs`) y un PROMPT por brazo.

### 6.1 Resultados (2026-07-31, 3 reps × 4 brazos × 10 tareas)

| brazo | juzgado (por rep) | false greens | acciones (mediana/tarea) | wall p50 | wall p95 |
|---|---|---:|---:|---:|---:|
| claude-agent (snapDOM) | 10/10 · 10/10 · 10/10 | 0 | 5 | **7,0 s** | 29 s |
| codex-agent (snapDOM) | 10/10 · 10/10 · 10/10 | 0 | 6 | 8,0 s | **23 s** |
| claude-native (extensión Chrome) | 10/10 · 10/10 · 10/10 | 0 | 3 | 22 s | 84 s |
| codex-native (Playwright propio) | 10/10 · 9/10 · 10/10 | 0 | 2 | 4,4 s¹ | 61 s |

**119/120 celdas pass con juez externo · 0 false-greens en los 4 brazos.** La única
celda no-pass es un DNF honesto (eBay devolvió 403 a curl Y a Playwright en la rep 2 de
codex-native; el runner reportó `claimed: false` — el contrato de honestidad funcionó).

¹ Asimetrías de medición declaradas (en las notes de cada results file): codex-native
reporta solo tiempo de ejecución de browser (excluye sus pausas de razonamiento) y cuenta
1 ejecución de script = 1 acción; los brazos claude incluyen el turnaround del runner en
wall. El p95 — donde pegan los timeouts de selectores (30–60 s) — es la columna más
comparable, y ahí los brazos snapDOM ganan 2,4–3,7×.

**Hallazgos cualitativos con evidencia en los results files:**
- El "nativo" de ChatGPT ES CDP: Codex resolvió el brazo escribiéndose Playwright. En el
  nicho sin CDP (MV3/embebidos) ese baseline no existe — quedó medido por construcción.
- Modos de falla por canal, complementarios: codex-native pierde tiempo en selectores CSS
  vencidos (timeouts de 30–60 s en 3 tareas, `li.s-item` muerto); claude-native sufrió
  `find` muerto por contexto (299k tokens > 200k en Wikipedia grande, 3ª reproducción),
  clicks sintéticos que no-opean (verificado en 2 reps con screenshot+DOM) y falsos
  positivos del sanitizador; los brazos snapDOM no tuvieron ninguno de los dos (find
  in-page 1–8 ms, click por id con eco role/name).
- Cloudflare (npm): bloqueó al Playwright fresco de Codex (fallback a API) y al daemon
  una vez (cedió al reabrir); nunca apareció en el Chrome real logueado del usuario.
  Operar en el browser del usuario corta en ambas direcciones y quedó documentado.
- claude-native mejoró 55→35→26 acciones entre reps aprendiendo el método (js-driver):
  las reps no son independientes dentro de un runner — declarado en los results files.
- eBay confirmado no-estacionario para todos los brazos (3 primeros orgánicos distintos
  en 12 corridas); el juez solo exige un aterrizaje `/itm/` real.

**Diseño (implementado)**
- **Tareas**: 10 en v1, tipadas (extracción ×4, navegación profunda ×2, búsqueda+selección
  ×2, formulario/efecto + verificación de no-op sobre `demo-qa` — el control determinista
  con truth conocida). Cap de 15 acciones por tarea. `experiment/formal/TASKS.md`.
- **Brazos**: `claude-native` (extensión claude-in-chrome tal como viene) ·
  `codex-native` (Codex/ChatGPT con su propio stack tal como viene — su elección de
  método se registra como dato) · `claude-agent` y `codex-agent` (snapDOM Agent vía
  CLI/MCP, mismo runner que el nativo correspondiente para aislar el canal).
- **Repeticiones**: ≥3 por celda; se reportan p50/p95, DNFs con causa, sin descartar
  corridas.
- **Juez**: `experiment/formal/judge.mjs` — fetch puro + constantes (API de HN,
  raw.githubusercontent, api.npmjs.org, patrones de URL, truth del demo), externo a los
  cuatro brazos. Anti-circularidad estricta. El gap `claimed` vs veredicto del juez ES la
  métrica de false-green.
- **Métricas por celda**: éxito juzgado · acciones/llamadas · tiempo de pared end-to-end y
  tiempo de herramienta · tokens de percepción (donde el canal los expone) · false-green
  rate (capa 3) · comportamiento bajo el brazo de misuse (§5).
- **Presupuesto estimado**: $10–30 de API + corridas manuales del brazo ChatGPT.
  Infraestructura ~80% existente (realloop, JSONL con duraciones, token accounting).

**Limitaciones de medición declaradas de antemano**
- El brazo ChatGPT nativo es caja cerrada: tokens internos no observables → se reporta
  éxito, acciones visibles, tiempo de pared, y tokens quedan "n/a (no expuesto)". No se
  estiman.
- Asimetría de interfaz (acciones-por-turno) se reporta como en §3.2.
- **Landmine operativa**: jamás correr dos brazos/rondas de consumo en paralelo — el
  puerto 8377 del daemon es compartido y contaminó una ronda (documentado en codex v5).

**Definición del brazo ChatGPT (decidida)**: Codex con su propio stack, tal como viene
(regla única: nada de `packages/agent/*`). Si su stack resuelve tareas por curl/scripts
en vez de browser, el método queda registrado por tarea; si no puede operar una página
(T8/T9 requieren runtime), eso es un hallazgo del paper, no ruido: el nicho sin browser
programable no tiene baseline.

## 7. Amenazas a la validez

- Capa 2 actual es piloto (n=1 por celda); solo capa 1 tiene estatus de resultado firme.
- Sitios reales no son estacionarios (portadas cambian entre corridas; eBay demostró no
  ser determinista para NINGÚN brazo — por eso el harness deja el porqué auditable en
  JSONL, y el formal usa ≥3 reps + demo-qa como control con truth).
- El ejecutor de §3.2 corrió ambos brazos (mismo sesgo para ambos); la replicación Codex
  (§3.3) mitiga pero usa el agente, no compite contra él.
- El corpus de bench-qa lo escribió el mismo equipo; mitigación: truth manual publicada
  por fixture, y los brazos baseline corren con implementaciones estándar (pixelmatch
  perceptual, a11y de Playwright), no strawmen.
- Higiene de instrumento: dos falsas alarmas de perf se rastrearon al entorno de medición
  (tic 1 Hz del panel CDP; maxSliceMs mal leído) y están documentadas — medir el ruido de
  fondo del instrumento antes de culpar al sistema.

## Apéndice A — reproducibilidad

Todo corre desde la rama `agent-lab`, working tree limpio, `npm run compile` previo.

| Qué | Comando | Resultado esperado hoy |
|---|---|---|
| Capa 1: bench de detección | `node packages/agent/experiment/bench-qa.mjs` | oráculo 19/19 · 0 FP · 0 miss (tabla §2.1) |
| Gate de la companion | `node packages/agent/companion/gate.mjs` | GATE GREEN 22/22 |
| Escalado por nodo | `node packages/agent/experiment/scaling.mjs` | costo/nodo plano (§2.3) |
| Sweep de ruido, 35 sitios | `node packages/agent/experiment/sweep.mjs` | 18/35 cero ruido en reposo |
| Suite de tests | `npx vitest run packages/agent --browser.headless` | 55/55 |
| Demo capa 3 (vía MCP) | `node packages/agent/demo-qa/run-demo.mjs` | T1 PASS · T2 no-op `changed:false` con reloj vivo |
| Piloto capa 2 (sin gastar) | `node packages/agent/experiment/realloop.mjs --dry` | golden paths validados |
| Benchmark formal: juzgar un run | `node packages/agent/experiment/formal/judge.mjs <results/…​.json>` | veredictos + false-greens por entrada |
| Benchmark formal: agregar | `node packages/agent/experiment/formal/report.mjs` | tablas resumen + matriz tarea×brazo |

Datos crudos: `experiment/results/*.json` (bench-qa, sweep, mv3, scaling, realloop,
loop-raw) · logs de operación: `packages/agent/logs/*.jsonl` (ts/seq/epoch/duración/
walkDetail por comando) · rondas de evaluadores: `experiment/results/codex-self*.md`,
`codex-mcp.md`, `codex-assert.md`, `claude-vs-chrome.md` · campo: `FIELD.md`.
