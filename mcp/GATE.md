# Gate F1 — servidor MCP

## (a) Consumo como tools nativas — ✅ 2026-07-31

Registrado a nivel user (`claude mcp add --scope user snapdom-agent`, ✔ Connected).
Las sesiones de Claude Code lo ven sin skill ni snippet. Claude Desktop: mismo
registro apuntando a `packages/agent/mcp/server.mjs`.

## (b) Las 5 tareas vía MCP puro — ✅ 2026-07-31

Runner por `tools/call` exclusivamente (scratchpad `mcp-gate.mjs`), mismos criterios
que la comparativa CLI:

| Tarea | Resultado | Llamadas | Wall |
|---|---|---|---|
| T1 HN top story comments | ✓ "114 comments" (/item?id=49118781) | 2 | 1,6 s |
| T2 GitHub issues | ✓ Open0 · Closed338 | 3 | 1,8 s |
| T3 Wikipedia link profundo | ✓ /wiki/Mar_del_Plata | 4 | 5,1 s |
| T4 npm downloads | ✓ 27.689.392 (dato vivo, cambió con la semana) | 4 | 1,2 s |
| T5 eBay 1er resultado | ✓ "Alice Cooper…" /itm/287458494065 | 8 | 11,5 s |
| **Total** | **5/5** | **21** | **21,2 s** |

Referencia CLI: 5/5 · 20 cmds · 21,2 s. La llamada extra: T4 probó ids del find
hasta dar con el número (el flujo CLI conocía el id bueno de antemano). Paridad.

## (c) Ronda Codex a ciegas solo-MCP — ✅ 2026-07-31

`results/codex-mcp.md`: **5/5 · 25 llamadas · 19,98 s puros** (mejor wall que ambas
referencias), solo con tools/list como documentación. Veredicto: "integrable hoy
para experimentación y agentes con modelo en el loop; no tal cual para QA
desatendido" + 9 pedidos.

## Endurecimiento post-(c) — ✅ mismo día

De los 9 pedidos, 6 aplicados y verificados:
1. **Lifecycle del daemon (blocker CI)**: el server es dueño del daemon que levanta
   y lo termina en EOF/SIGINT/SIGTERM. Dos landmines medidas en el camino:
   `ChildProcess.kill()` devuelve true SIN entregar la señal (usar
   `process.kill(pid)`), y una señal seguida de `process.exit` inmediato tampoco se
   entrega (el emisor debe sobrevivir al envío) → patrón TERM → 400ms → KILL.
   Verificado: 0 huérfanos por ambos caminos.
2. **Envelope v1 del daemon** (`{ok, text, error, epoch, url, meta}` con
   `envelope:true` en /cmd; el CLI sigue igual) → **structuredContent** en cada
   respuesta MCP: changed/matches/resolved/settle/epoch/url como CAMPOS, no prosa.
3. `browser_act` con schema condicional (oneOf por acción).
4. CLI-ismos traducidos al dialecto MCP en el borde ("corré look" → browser_verify…).
5. `browser_page {view:"zoom", id}` — el zoom regional que faltaba.
6. Negativo `changed:false` ahora estructurado (verificado en fixture).

Diferidos a F2 (features, no fixes): `browser_assert` determinista, causalidad
target-vs-ambiente en verify, `browser_query` con orderBy, redacción auditable
(ya es F3). Gate (b) re-corrido tras el endurecimiento: 5/5 · 21 · 21,8 s.
