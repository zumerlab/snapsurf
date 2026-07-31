# Prompt para Codex — ronda MCP a ciegas (gate F1c) (copiar y pegar)

Ronda distinta a las anteriores: esta vez NO usás el CLI de browse.mjs ni la skill.
Vas a consumir el oráculo como **servidor MCP**, igual que lo haría un cliente que
no conoce nada del laboratorio.

Setup:
- Server: `node packages/agent/mcp/server.mjs` (transporte stdio, JSON-RPC por
  línea). Registralo en tu tooling MCP si podés; si no, hablale por stdio crudo
  (initialize → tools/list → tools/call).
- El server levanta el daemon del browser solo. No corras browse.mjs a mano.

Regla de oro de la ronda: **jugá a ciegas**. Tu única documentación son las
descripciones que devuelve `tools/list`. No uses tu conocimiento de rondas
anteriores sobre comandos, ids o flujos del CLI — si una descripción no alcanza
para saber cómo usar la tool, eso es un HALLAZGO, anotalo (es exactamente lo que
esta ronda mide: ¿la superficie MCP se explica sola?).

Tareas: las mismas 5 de siempre (HN top story + comments; issues open/closed de
zumerlab/snapdom; Wikipedia Argentina → link Mar del Plata; npm preact weekly
downloads; eBay "vinyl record" → primer resultado /itm/). Tope 15 llamadas por
tarea. Medí wall-time por tarea y por llamada.

Reporte en `packages/agent/experiment/results/codex-mcp.md`:
1. Tabla: éxito · llamadas · wall por tarea, comparada contra tus números CLI de
   v4 (27,6 s total) y la referencia MCP del gate (5/5 · 21 · 21,2 s).
2. **Evaluación de la superficie**: ¿las descripciones de las 9 tools alcanzaron
   para operar sin documentación externa? ¿Cuál te confundió, cuál te faltó, qué
   tool inventarías? ¿browser_verify te cambió el flujo (verificar en vez de
   re-observar)?
3. Fricciones del transporte: latencias, tamaños de respuesta, errores del
   protocolo si los hubo.
4. Veredicto para un builder externo: ¿esto es integrable tal cual? ¿Qué le falta
   para que lo pongas en un pipeline de QA?

Sin edulcorar. Al final, matá el server y verificá que no quede ningún daemon de
browse.mjs corriendo (pgrep -f browse.mjs).
