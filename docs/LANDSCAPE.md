# Percepción y verificación en agentes de browser: estado del arte, Reddit, y dónde está snapDOM Agent

2026-08-01 · Metodología: dos barridos independientes — (1) Reddit vía el archivo
arctic-shift (Reddit bloquea el crawler de Anthropic y todos los mirrors; el archivo
fue la única vía de datos, ver §1.0) y (2) papers/benchmarks/docs de vendors leídos de
fuente primaria. Etiquetas: **[medido]** = número del propio paper/eval ·
**[auto-reportado]** = eval corrida por el vendor · **[terceros]** = cobertura secundaria.
El contraste final (§3) es deliberadamente objetivo: incluye dónde este desarrollo está
atrás.

---

## 1. Lo que dice Reddit

Muestra: 954 posts descubiertos (17 subreddits × 16 keywords, post jun-2024) y 32 hilos
leídos completos (cuerpo + top comments) vía el archivo arctic-shift. IDs de post entre
paréntesis → `reddit.com/r/<sub>/comments/<id>/`. Datos crudos: `discovered.json` /
`threads.json` (scratchpad de la sesión).

### 1.0 Nota de acceso y de higiene (metodológica)

Reddit excluye al crawler de Anthropic (WebSearch filtra reddit.com, WebFetch no puede
traerlo), el JSON público devuelve 403, old.reddit pide login y los mirrors están detrás
de challenges; la única vía reproducible fue el archivo arctic-shift. Y un hallazgo que
es en sí mismo un dato: **este discurso está fuertemente astroturfeado** — en al menos 5
de los 32 hilos los propios comentaristas acusan a respuestas (u OPs) de ser bots o
marketing ("the amount of ai slop astroturfing in these comments is insane"). Todo
elogio de producto de un solo comentario en estos subs es evidencia débil.

### 1.1 Temas, con nivel de acuerdo

**T1 · El costo de percepción es la queja #1 de los builders (2026) — casi consenso.**
Screenshots por paso o dumps completos del a11y tree queman 100k+ tokens/página; todo
pitch de vendor lidera con reducción de tokens. Datos concretos de los hilos:
- Benchmark del equipo de Opera (r/AI_Agents 1ukm69c, jul-2026): 35 corridas × 4
  formatos de snapshot — chrome-devtools-mcp crudo 179k tokens promedio, CLI de
  referencia 102k, formato comprimido 36k — **pass rate idéntico (100%) en los cuatro**:
  la representación cambia el costo ~5×, no el resultado (en tareas alcanzables).
- "Computer use is 45x more expensive than a structured API call" (1tgyg5r, may-2026,
  benchmark de vendor): 53 pasos vs 8; el mejor comentario: "el cuello no es la calidad
  de la visión, es la CANTIDAD de screenshots que exige la interfaz".
- OpenBrowser MCP (r/OpenAI 1rb6pgy, feb-2026): "One Wikipedia page? 124K+ tokens.
  Every. Single. Call." — contra los dumps por llamada de los MCP de browser.
- Recepción temprana de computer use de Anthropic (1ga1q15, oct-2024): "okay, but very
  expensive".

**T2 · Selectores CSS < marcas numeradas < role+nombre accesible — acuerdo alto entre
los que shippean.** Repetido independientemente en ≥3 hilos (1v7m7q3, 1tnfgel,
1sesyo9): "css selectors break on every redeploy, but numbers break on every dom
change… role + accessible name as the primary locator, then numbered refs from a scoped
snapshot"; cadenas de resolución "ax_role+name → ax_identifier → css → ocr+pixel"; el
a11y tree como el binding más estable ante rediseños (con el caveat reconocido de
Electron/canvas).

**T3 · Los loops LLM-por-paso derrochan y derivan; el patrón emergente es
plan-una-vez + ejecutor determinista + ASSERTS.** (1tnfgel, may-2026: la loop
browser-use/Stagehand costaba 20-50 llamadas y $0,50-3,00 por tarea con "half the runs
drifted off-task"; plan-then-execute la cortó 50×.) El comentario más votado articula la
doctrina: compilar a "selectors / assertions / fallbacks", ejecutar con Playwright pelado
y "only call the model again if an assertion fails in a new way". **Es la articulación
Reddit más clara de lo que la literatura llama el gap de verificación: nadie confía en
que el agente diga que su acción funcionó.** Acuerdo alto.

**T4 · Los agentes de consumo 2025 (Operator y familia) fueron juzgados como no
valiendo la pena — sentimiento dominante en hilos de alto score.** "Can't even book a
simple flight" (r/OpenAI 1jesec7, mar-2025, score 232/92 comentarios; top comment: la
analogía de los groceries punto-com); "Too many restrictions… captcha interruptions…
Everything I wanted to do was faster if done myself" (1l2ozip, jun-2025); browser-use
entrando en loop en Amazon y "Computer use: do a really shitty job at everything"
(1jwgclf, abr-2025). Contra-anécdotas existen (pizza de Dominos, reservas) pero
enmarcadas como novedad. En 2026 sigue: "nada es rápido Y confiable a la vez" (1uc0bbi:
browser-use rápido/mediocre, agent-browser de Vercel "the worst one in speed",
TinyFish confiable/cerrado/lento).

**T5 · CAPTCHA se considera muerto contra modelos de visión; la carrera se movió a
comportamiento e infraestructura.** El hilo de mayor engagement del barrido (r/webdev
1uxfzav, jul-2026, **score 4.316 · 491 comentarios**): un captcha de video que a un
modelo frontera le tomó "10 minutes and 100k tokens"; la sala puntúa que un agente con
control total del browser invalida las defensas DOM/iframe. "CAPTCHA is 100% solvable
by AI" (1qzqe7f) aceptado como premisa; el reemplazo por biometría de tecleo,
destrozado por falsos positivos.

**T6 · Sesión logueada real > stealth, pero NADIE recomienda el perfil de uso diario —
unánime donde se discute.** (1v7m7q3: "a warm session beats a 'perfect' fresh
fingerprint"; y a la vez "attaching an agent to a daily-use profile full of email,
payments, and admin sessions is convenient until one bad page instructs it…"). El
razonamiento de blast-radius/prompt-injection ya es vocabulario estándar, incluido el
paper compartido en r/LocalLLaMA (1n8bgtr): **el a11y tree mismo como vector de
inyección** — el canal "limpio" también es superficie de ataque.

**T7 · Contrarian: "los agentes no deberían usar interfaces humanas" — score alto,
rebatido en sala.** "Atlas… is just accruing architectural debt" (1od8vv0, oct-2025,
score 437): la web semántica como precedente fallido ("Nobody wants to give their own
data away") y el contraargumento clave: los sitios complejos tienen APIs **cerradas a
propósito** — navegar como humano es cómo los agentes las rodean, no ingenuidad.

### 1.2 Qué NO apareció

r/QualityAssurance y r/softwaretesting no rindieron hilos on-topic por búsqueda de
título (la conversación de asserts visuales flaky usa otro vocabulario allí);
r/ClaudeAI/r/Anthropic nada distintivo. Notable para nosotros: **no se encontró ningún
hilo pidiendo o discutiendo "diff semántico" como primitive** — la demanda aparece
expresada como "asserts deterministas + no confiar en el agente" (T3), no con nuestro
vocabulario.

---

## 2. Fuentes serias

### 2.1 Las tres familias de percepción — y la convergencia al híbrido

**Familia píxeles** (screenshot → coordenadas):
- Anthropic computer use (docs): loop screenshot→click(x,y); la resolución declarada
  debe coincidir o las coordenadas salen sistemáticamente mal; verificación = otro
  screenshot. [auto-reportado] Claude 3.5 Sonnet 14,9% OSWorld screenshot-only (oct-2024)
  vs 7,7% del siguiente.
- OpenAI CUA/Operator (ene-2025): GPT-4o fine-tuned sobre píxeles crudos, sin DOM.
  [auto-reportado] 38,1% OSWorld · 58,1% WebArena · 87% WebVoyager. Operator fue
  absorbido por "agent mode" (jul-2025) y deprecado standalone (ago-2025).
- Google Project Mariner (dic-2024): screenshots → Gemini en la nube. [auto-reportado]
  83,5% WebVoyager.
- Magnitude (OSS 2025): visión pura anti-DOM. [auto-reportado] 94% WebVoyager.
- UGround (ICLR'25 oral): la mejor defensa académica de píxeles-solo — grounding
  entrenado con 10M elementos; [medido] +20 puntos absolutos sobre grounding visual
  previo; agentes vision-only superando a agentes con a11y+texto.

**Familia estructura** (a11y tree / DOM destilado):
- WebArena (ICLR'24): observación canónica = accessibility tree. [medido] mejor GPT-4:
  14,41% vs humanos 78,24%.
- Playwright MCP (Microsoft): a11y snapshot con refs estables; cada tool que actúa
  devuelve snapshot fresco (loop percibir-actuar-percibir integrado). [doc primaria]
  snapshot ~200-400 tokens vs ~3.000-5.000 el screenshot; "determinista"; screenshots
  solo recomendados para canvas/charts.
- Stagehand/Browserbase: migró de DOM crudo a a11y tree vía CDP; [auto-reportado]
  −80-90% de datos vs DOM crudo.
- vercel-labs/agent-browser: mismo paradigma refs-de-a11y en CLI.
- browser-use: DOM destilado + índices de elementos (+screenshot opcional).
  [auto-reportado, con caveats declarados por ellos] 89,1% WebVoyager — admiten haber
  modificado harness/prompts y re-juzgado a mano los fails: ilustración honesta de por
  qué los números WebVoyager de vendors no son comparables.
- Agent-E (2024): DOM destilado + **"change observation"** — tras cada acción el
  ejecutor reporta al planner qué cambió (verificación liviana explícita).
  [paper] 73,2% WebVoyager, +20% sobre text-only previo.
- AgentOccam (Amazon 2024): sin visión, solo alineación cuidadosa de observación/acción.
  [medido] +9,8 puntos absolutos de SOTA en WebArena — la ingeniería del espacio de
  observación rinde tanto como la arquitectura.

**Convergencia:** [medido] EntWorld (2026): screenshot+a11y combinados = mejor
configuración; screenshot-solo = la peor. SeeAct (ICML'24): el mejor grounding combina
HTML+visual, y set-of-marks NO funcionó bien en páginas web densas. VisualWebArena:
hay tareas imposibles sin píxeles (text-only falla sistemáticamente). Chrome DevTools
MCP: snapshot estructurado + screenshot opcional, framing explícito de "ojos para
VERIFICAR". El consenso 2025-26: híbrido, con estructura como canal barato por defecto
y píxeles bajo demanda.

### 2.2 El cuello de botella es el grounding, no el plan

- [medido] SeeAct: GPT-4V genera el plan textual correcto en 51,1% de tareas si un
  humano hace el grounding a elementos — el grounding automático es lo que falla.
- [medido] ScreenSpot-Pro (2025): el mejor modelo de grounding: 18,9% en UIs
  profesionales de alta resolución. Cita estándar de "el grounding visual está lejos de
  resuelto fuera de páginas de consumo".
- [medido] Mind2Web: elegir el elemento ~53% vs emitir la acción completa correcta 11,2%.

### 2.3 Verificación: el eslabón más débil y la mejor palanca

- **False success cuantificado** [medido] (arXiv 2606.09863, 2026): en 9.876
  trayectorias × 8 familias de modelos frontera, el éxito falso (el agente declara éxito
  y el estado programático lo desmiente) = **44-52% de todas las fallas** en dominios
  sin verificador independiente, **75,8%** en AppWorld para arquitecturas con señal
  explícita de completado — y cae a **~3%** cuando existe verificación independiente
  del estado. Un orden de magnitud, medido.
- [medido] ST-WebAgentBench (IBM, ICML'25): "Completion under Policy" < ⅔ del
  completion nominal — un tercio de los "éxitos" viola políticas.
- [medido] Tree Search de Koh et al. (2024): value function que puntúa estados
  resultantes (verificación explícita) = +28-40% relativo sobre el mismo agente
  reactivo.
- [medido] "An Illusion of Progress?" (2025): en 300 tareas vivas sobre 136 sitios, los
  agentes actuales rondan **~30% de éxito real vs 60-90% reportado** en benchmarks
  previos; los auto-judges (incluido el de WebVoyager) sobreestiman; su WebJudge llega
  a ~85% de acuerdo con humanos.
- Cómo verifican los vendors hoy: re-percepción (otro screenshot/snapshot) o aprobación
  humana (Atlas pausa en acciones sensibles) — no chequeo programático de estado.
- WebSight (2025): agente dedicado de verificación en el loop; patrón "alta precisión,
  cobertura incompleta" (97,1% de respuestas correctas en tareas que completa; 68%
  WebVoyager).

### 2.4 Los benchmarks mismos están inflados o rotos

- [terceros, auditoría] Epoch AI sobre OSWorld: ~10% de tareas con errores serios;
  ~15% resolubles solo por terminal y ~30% por terminal/Python (mide coding, no GUI);
  baseline humano 72% ⇒ ambigüedad en hasta 28% de tareas.
- [primaria] OSWorld-Verified (jul-2025): los mantenedores arreglaron 300+ issues;
  scores pre/post no comparables.
- WebVoyager saturado: 94% (Magnitude) y 98,5% (Alumnium) auto-reportados en 2025 —
  ya no discrimina; tratar todo SOTA de WebVoyager como marketing.
- WebCanvas/Mind2Web-Live: evaluar en sitios VIVOS con "key nodes" intermedios;
  [medido] mejor agente 23,1% — los competitivos offline no lo son online.

### 2.5 Economía de tokens de la percepción

- Playwright MCP [primaria]: snapshot 200-400 tokens vs 3.000-5.000 por screenshot.
- Stagehand [auto-reportado]: a11y tree −80-90% vs DOM crudo.
- Markdown vs HTML [terceros/Cloudflare vía Firecrawl]: 3.150 vs 16.180 tokens (−80%).
- "The Complexity Trap" (2025) [medido]: los tokens de observación dominan el contexto
  del agente y se re-facturan cada paso (crecimiento ~cuadrático con los pasos) — por
  eso la percepción screenshot-heavy es cara; masking simple ≈ summarization.

---

## 3. Contraste objetivo: dónde está snapDOM Agent

Referencias internas: `PAPER.md` (bench-qa 19/19·0FP, benchmark formal 4 brazos × 3
reps × 10 tareas, 119/120 con juez externo, 0 false-greens), `FIELD.md`,
`experiment/results/`.

### 3.1 Dónde estamos alineados con el consenso (ni adelante ni atrás)

- **Híbrido estructura+píxeles**: nuestra conclusión C/D del piloto (screenshot+oráculo
  gana; snapdom-PNG+oráculo con menos pasos) es exactamente la ablación de EntWorld y
  la recomendación de Playwright MCP. No es diferenciación: es el estado del arte.
- **Economía de percepción**: nuestro p50 de 19 tokens por diff vs ~1.365 del
  screenshot es consistente con (y del mismo orden que) los 200-400 vs 3.000-5.000 de
  Playwright MCP. La queja de costo que domina Reddit valida el problema, pero los
  players grandes ya lo atacan con a11y snapshots.
- **Observación fresca tras actuar**: Playwright MCP ya devuelve snapshot tras cada
  acción; Agent-E ya reporta "qué cambió" al planner. La idea de re-observar no es
  nuestra; la *forma* del reporte sí (ver 3.2).

### 3.2 Dónde hay diferenciación real, con respaldo externo

- **El diff semántico como capa de verificación es exactamente lo que el campo midió
  que falta.** El resultado más fuerte de la literatura 2026 (false success 44-76% de
  las fallas sin verificador independiente → ~3% con él) es el caso de negocio de
  `browser_verify`/`assert` — nuestro false-green rate 0/120 en el benchmark formal es
  la misma métrica que ese paper define, medida con juez externo. Nadie de los vendors
  relevados ofrece verificación programática de efecto como primitive: re-perciben o
  piden aprobación humana.
- **Diff con identidad y kinds, no diff de texto.** El `diff snapshot` de agent-browser
  es diff textual del a11y tree (sin identidad entre mutaciones, sin geometría, refs
  explícitamente inestables); Playwright MCP no diffea — entrega el snapshot nuevo y el
  modelo compara. Nuestro diff clasifica (added/removed/content/state/moved/resized/
  possible-replacement) con matching por fingerprints y oclusión proactiva
  (`coveredBy`). En bench-qa eso da 19/19·0FP contra 13/19·5FP del pixel-diff y
  16/19·2FP del a11y-diff — pero ver 3.3 sobre quién escribió ese corpus.
- **El nicho sin CDP existe y nadie lo cubre.** Todo el stack serio relevado (Playwright
  MCP, agent-browser, Stagehand, CUA, Mariner) requiere CDP o browser propio. Extensiones
  MV3 y copilots embebidos no pueden usarlos; nuestro walk en isolated world (3/3 bajo
  CSP real) es la única oferta relevada para ese caso. El riesgo simétrico: puede que el
  nicho sea chico o que los runtimes lo absorban (3.3).
- **Fail-loud como contrato** (specs inválidos → rojo diagnóstico; probing de términos
  redactados → bloqueado; 0 false-greens bajo misuse en rondas reales): ST-WebAgentBench
  muestra que el campo recién empieza a medir esto (CuP); no vimos un equivalente de
  "assert que se niega a mentir" en los vendors relevados.
- **La demanda del practitioner existe, con otras palabras.** La doctrina emergente en
  Reddit (T3: plan-una-vez + ejecutor determinista + asserts, re-invocar el modelo solo
  ante falla nueva) es exactamente el patrón que `browser_act`+`browser_assert` cubren
  con un vocabulario listo (changed/mustInclude/exists/notCovered + retry). Y varias de
  nuestras decisiones ya tomadas coinciden con lo que la comunidad valida por las malas:
  click por role+nombre con eco antes que selectores CSS (su T2), daemon aislado con
  `--readonly`/`--allow` en vez del perfil diario (su T6), y output de página fenced
  como dato-no-instrucción (el paper del a11y tree como vector de inyección que circuló
  en r/LocalLLaMA le da respaldo externo a esa regla nuestra).

### 3.3 Dónde estamos atrás, y los riesgos (la parte incómoda)

- **Escala de evidencia.** Nuestro benchmark formal: 10 tareas × 3 reps × 4 brazos,
  9 sitios. WebArena: 812 tareas; Mind2Web: 2.350 tareas/137 sitios; Online-Mind2Web:
  300 tareas/136 sitios. Con n=10 no podemos afirmar generalización — solo que el
  harness es honesto. El 100% de éxito en nuestras 10 tareas además sugiere que son
  FÁCILES comparadas con las de los benchmarks públicos (donde los mejores agentes
  rondan 30% real): nuestra suite no discrimina capacidad, discrimina canal de
  percepción en tareas alcanzables.
- **Autoevaluación.** El corpus de bench-qa (19 fixtures, truth manual) y la task suite
  lo escribió el mismo equipo que construyó el oráculo; los baselines los corrimos
  nosotros. La mitigación real (truth publicada, baselines estándar, juez externo,
  replicación ciega de Codex) es seria, pero no equivale a un benchmark de terceros:
  la lección de "Illusion of Progress" (60-90% reportado → 30% real) aplica a cualquiera
  que se auto-mide, incluidos nosotros.
- **Cero validación en benchmarks públicos.** No corrimos WebArena/VisualWebArena/
  Online-Mind2Web/OSWorld. Hasta hacerlo, no hay número comparable con nadie. Es la
  brecha más citable que tenemos.
- **El matcher no está probado contra grounding público** (ScreenSpot-class): nuestra
  identidad de nodos funciona en nuestro corpus; no sabemos su tasa en el long tail de
  UIs profesionales donde el campo mide 18,9%.
- **Distribución y ecosistema: inexistentes.** browser-use tiene decenas de miles de
  stars y financiamiento; Playwright MCP es el default de facto con Microsoft detrás;
  Chrome DevTools MCP viene del equipo de Chrome. Nosotros: repo privado, 0 usuarios
  externos, validación por 2 agentes evaluadores (Codex, panel) que nosotros mismos
  orquestamos. El mejor diff del mundo sin distribución pierde contra un diff mediocre
  integrado en el runtime que todos ya usan.
- **Riesgo de absorción.** Playwright MCP ya hace percibir-actuar-percibir; agregarle un
  differ semántico es un incremento natural para Microsoft/Google (Chrome DevTools MCP
  ya se define como "ojos para verificar"). La ventana de "componente integrable antes
  de que los runtimes absorban la verificación" (nuestro propio análisis estratégico)
  está respaldada por este relevamiento — pero es una ventana, no un foso.
- **Riesgo de la apuesta visual.** UGround y la línea CUA muestran progreso real en
  grounding visual entrenado; si en 2-3 años el grounding por píxeles se vuelve fiable
  y barato, el argumento "la semántica es más precisa que los píxeles" se debilita
  (el argumento de costo y el de no-CDP sobreviven mejor que el de precisión).
- **Sin capacidades que el campo ya considera básicas** para agentes de producción:
  multi-tab/ventanas, auth/sesiones gestionadas, dominios de descarga/clipboard,
  restore real de estado, permisos finos. agent-browser ya trae varias.
- **Nadie pide "diff semántico" por ese nombre.** En 954 posts no apareció un solo hilo
  usando nuestro vocabulario; la necesidad se expresa como "asserts deterministas" y
  "no confiar en el agente". Eso significa mercado por educar: el pitch tiene que
  entrar por el dolor que la gente SÍ nombra (costo de tokens, asserts flaky, drift)
  y no por la categoría que inventamos.
- **En tareas alcanzables, la representación no cambia el resultado.** El benchmark de
  Opera en Reddit (4 formatos, pass rate idéntico, solo cambia el costo) coincide con
  nuestro propio benchmark formal (4 brazos, 119/120): en tareas fáciles todos llegan;
  la diferencia es costo/latencia/cola. La ventaja de éxito del canal semántico solo
  sería demostrable en tareas más duras que ninguno de los dos benchmarks incluye.

### 3.4 Qué adoptar del estado del arte (accionable, barato)

1. **Correr Online-Mind2Web (o un subset de WebArena)** con los 4 brazos del harness
   formal — reemplaza "nuestras 10 tareas" por tareas de terceros y da el número
   comparable que falta. Es la mejora de credibilidad más grande por peso invertido.
2. **WebJudge-style judge** además del juez determinista: nuestro juez fetch-puro es
   fuerte pero cubre poco; el patrón key-nodes de WebCanvas (estados intermedios
   anotados) haría las tareas largas juzgables.
3. **Métrica CuP** (completion under policy) de ST-WebAgentBench para el brazo de
   misuse: ya tenemos el vocabulario (fail-loud, redact, readonly); formalizarlo con su
   métrica lo hace citable.
4. **Citar la literatura de false-success** (2606.09863) en PAPER.md §4: es la
   validación externa exacta de la capa 3 y hoy el paper no la referencia.

### 3.5 Resumen en una línea

Estamos **alineados** con el consenso técnico (híbrido, estructura barata), con **una
diferenciación real y externa-mente respaldada** (verificación programática de efecto
vía diff con identidad — el hueco más grande medido por la literatura 2025-26 — más el
nicho sin CDP), y **atrás en todo lo que rodea al core**: escala de evidencia,
benchmarks de terceros, capacidades de producción, distribución y comunidad. La ciencia
del pitch está mejor respaldada de lo que sabíamos; el producto alrededor del pitch es
donde el relevamiento nos deja peor parados.
