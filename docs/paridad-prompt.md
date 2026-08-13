# Prompt de paridad — mismo instrumento, distintos modelos

Pegar tal cual en Codex (o cualquier cliente MCP con snapdom-agent registrado).
El brazo de referencia corre las MISMAS cuatro tareas; después se comparan los JSON.

---

Usá EXCLUSIVAMENTE las tools MCP de snapdom-agent (nada de shell, nada de otros
browsers). Primero llamá browser_session_open y pasá ese sessionId en TODAS las
llamadas siguientes. Ejecutá estas 4 tareas en orden y reportá UNA línea JSON por
tarea, sin prosa adicional:

Formato: {"task":"T1","answer":"…","evidence":"…","toolCalls":N,"frictions":"…"}

T1 — Extracción. Abrí news.ycombinator.com. Informá título, puntos y cantidad de
comentarios de la historia en el puesto #3 de la portada.

T2 — Acción + negativo. Abrí saucedemo.com y logueate con las credenciales de demo
públicas impresas en esa página (standard_user / secret_sauce). Si el Backpack ya
está en el carrito, reseteá el estado primero (menú → Reset App State). Agregá el
"Sauce Labs Backpack" al carrito y verificá con UN browser_assert:
{"changed":true,"mustInclude":[{"kind":"added","name":"Remove"},{"kind":"added","name":"1"}],
"mustNotInclude":[{"name":"Bike Light"}],"maxChanges":10}
En evidence: el resultado de cada check y el changesTotal.

T3 — Oclusión. Abrí the-internet.herokuapp.com/entry_ad (si el modal no aparece,
click en "click here" para re-habilitarlo y recargá). Con el modal presente:
browser_assert {"notCovered":"click here"} debe FALLAR (covered). Cerralo con su
control Close. browser_assert {"notCovered":"click here"} debe PASAR. En evidence:
ambos resultados.

T4 — Carried. Abrí es.wikipedia.org (portada). Después abrí
es.wikipedia.org/wiki/Universo. En la respuesta del segundo open viene el bloque
`carried` (structuredContent.carried). En answer: matches, unchanged, changed.length,
onlyBefore, onlyAfter. En evidence: un item de changed si existe (key + from/to).

Al final, una línea JSON extra: {"task":"meta","frictions":"lo que te trabó o
confundió del instrumento, en una frase"}.
