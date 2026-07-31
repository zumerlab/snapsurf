# PLAN — del laboratorio al componente: fase comercial del oráculo

Fecha: 2026-07-31 · Rama: agent-lab (privado, nunca push) · Estado: aprobación pendiente

## Posicionamiento (decidido, no re-litigar)

**Capa de verificación de acciones para agentes.** No "reemplazo de screenshots"
(el mapa de página está comoditizado: Playwright snapshot, MCPs de browser). El
activo único, validado por tres evaluadores independientes en uso real:

1. **El diff semántico** — "un agente sin esa señal cree que actuó y sigue con
   estado falso". Evidencia: 2 errores silenciosos evitados (Reddit: comentario
   borrado explicado; lanacion: 3 no-ops detectados con `changed:false`).
2. **`match`/find dirigido** — 38 kB→2 kB medidos para el mismo resultado.
3. Oclusión proactiva (`covered`/`coveredBy`) — el a11y tree no la tiene.

Cliente objetivo: **builders de agentes de QA y automatización web** (el nicho que
ya paga; el diff reemplaza aserciones visuales frágiles). El caso MV3/embebido
(companion) queda como demo del pitch técnico, no como producto de consumo.

Ventana: componente integrable HOY, antes de que los runtimes de agentes absorban
la verificación de acciones. Nada se publica sin decisión explícita del user.

## Fase 1 — Servidor MCP (el vehículo) — ~1-2 sesiones

`packages/agent/mcp/`: servidor MCP stdio en Node que envuelve el daemon.

Tools (superficie mínima, nombres provisorios):
- `browser_open(url)` → digest compacto (obs #, mapa rankeado, secciones)
- `browser_find(text)` → matches full-snapshot (texto completo, href, selector)
- `browser_act(id | selector, action, text?)` → click/type/enter CON eco role/name
- `browser_verify()` → EL PRODUCTO: diff desde la última observación
  (changed, changes con kinds+names, actionabilityDelta) — es el reemplazo de la
  aserción visual
- `browser_checkpoint(name)` / `browser_diff(name)` → baselines con nombre
- `browser_screenshot(id?)` → píxeles snapdom solo como escalación

Decisiones de diseño ya tomadas en el lab que el MCP hereda: garantías
"único-o-ausente" (selectores verificados, secciones honestas), negativos fieles,
logs JSONL por sesión, política --readonly/--allow.

**Gate de fase**: (a) Claude Code y Claude Desktop lo consumen como tools nativas
sin skill ni snippet; (b) re-correr las 5 tareas de la comparativa vía MCP con
resultados ≥ iguales al CLI; (c) una ronda Codex a ciegas usando solo el MCP.

## Fase 2 — Benchmark QA (el número de venta) — ~1 sesión

Comparar sobre el corpus de 18 mutaciones (ya existe, con truth escrita a mano) +
el sweep de 35 sitios reales (ya medido) + 3-5 regresiones reales reproducidas:

| Métrica | Oráculo (diff) | Pixel-diff (pixelmatch/odiff) | a11y snapshot diff |
|---|---|---|---|
| Falsos positivos en reposo | (sweep: 18/35 cero ruido) | ? | ? |
| Detección de la mutación | ? | ? | ? |
| "Explica QUÉ cambió" | kinds+names+selector | no (% píxeles) | diff textual crudo |
| Costo (tokens/bytes/ms) | ? | ? | ? |

Deliverable: informe con la tabla completa + un repo demo "QA sin aserciones
visuales" (un test real que usa `browser_verify` donde antes había screenshot
assertion).

**Gate de fase**: un número citable del tipo "0 falsos positivos donde pixel-diff
reporta N%; explica el cambio en ~30 tokens".

## Fase 3 — Privacidad auditable (lo que pregunta el comprador) — ~1 sesión

La capa `privacy: {redact}` del core existe y está testeada; falta hacerla visible:
- Exponerla en digest/MCP (opción de sesión).
- **Reporte de redacción**: qué reglas matchearon, cuántos nodos, en qué campos —
  auditable, no un detalle enterrado.
- Doc de una página: exactamente qué texto viaja en un digest y qué no.

**Gate**: digest de una página con datos sensibles muestra las redacciones y el
reporte las lista; test automatizado.

## Fase 4 — Empaquetado como componente — ~1 sesión

- API pública mínima congelada (inspect/checkpoint/diff/agentMap + MCP) con las
  garantías escritas como contrato versionado ("único-o-ausente", negativos
  fieles, same-environment repeatability).
- companion/ → `demo/` con README ("el oráculo embebido sin CDP" — pitch #2 como
  demo viva).
- Decisión de licencia/nombre/pricing: DEL USER, explícitamente fuera de este plan.

**Gate**: integración en frío por un tercero (Codex) desde el README en <30 min,
sin ayuda.

## Orden y dependencias

F1 (MCP) primero: es vehículo de F2 (el benchmark se corre VÍA el MCP, así el
número de venta mide el producto real, no el laboratorio). F3 y F4 pueden
intercalarse. Después de cada fase: ronda de consumo real (panel/Codex) antes de
seguir — la metodología que funcionó estas 6 rondas.

## Qué NO está en el plan (a propósito)

- Publicar cualquier cosa (npm, Chrome Web Store, GitHub público).
- Extensión de consumo final.
- Autonomía total (restore de estado, permisos finos por campo) — sin consumidor
  real que lo pida, sigue diferido.
- Re-litigar el posicionamiento: verificación de acciones, QA primero.
