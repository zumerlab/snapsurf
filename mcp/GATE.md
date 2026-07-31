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

## (c) Ronda Codex a ciegas solo-MCP — PENDIENTE

Prompt en `PROMPT-codex-mcp.md`. Criterio: con SOLO las descripciones de las tools
(sin skill, sin transcript previo del CLI), completar las 5 tareas y evaluar si la
superficie alcanza.
