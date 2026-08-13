# Fixes de las rondas 5–7 — RESUELTOS (2026-08-13)

Los seis hallazgos del handoff original están cerrados. Antes de aplicar cada uno se
lo filtró por un criterio pedido por el dueño: **¿es un agujero en el sentido de la
herramienta** (el contrato "nunca silencio, nunca dato mentiroso") **o una confusión
sobre su uso?** — como el reporte retirado de `browser_session_open`, que resultó ser
un registro MCP viejo en el cliente y no un bug del árbol.

Veredicto por ítem: P1, P2 y P4 eran violaciones directas del contrato (silencio).
P5 era un límite del modelo "card = contenedor" frente a layouts de tabla. P6 era
confusión de uso *causada por la herramienta* (dos vocabularios para un concepto).
P3 era mitad y mitad: mentir el UA era el instrumento mintiendo sobre sí mismo
(se arregló); la evasión de fingerprint no es el sentido de la herramienta (se
resolvió por diseño con el companion, no por disfraz).

Suites: daemon/MCP 36/36 · vitest 121/121 · doc-contract 26/26 · contract-gates 17/17
· gate companion VERDE (fixture torn reforzado, ver abajo).

---

## P1 — `open` observaba antes de la primera pintura tardía — RESUELTO

**Corrección al diagnóstico original**, medida contra el sitio del repro: el modal
de `entry_ad` NO sale en `window.onload` — un script inline arma
`setTimeout(showAd, 500)` al *parsearse*. Sin red y sin mutación hasta que dispara,
el settle de DOM-quieto salía honesto y temprano igual. El fix cubre las dos
mecánicas de la clase "primera pintura tardía que bloquea clicks":

1. Espera de `load` **acotada** tras el goto en `domcontentloaded`
   (`SNAPDOM_LOAD_WAIT_MS`, default 5000ms; 0 la apaga). Si al final
   `readyState !== 'complete'`, meta lleva `loading: {readyState, waitedMs}` y la
   prosa `⚠ page still LOADING…` — nunca silencio sobre un documento incompleto.
2. Ventana de vigilancia del documento fresco hasta `SNAPDOM_OPEN_WATCH_MS`
   (default 1200ms) desde la respuesta de navegación: una mutación en la ventana
   re-settlea acotado antes del único walk, y meta lleva `latePaint: true`.
   Páginas estáticas pagan solo idle, una vez, en `open` — `look` sigue rápido.

Verificado contra el sitio real: el primer digest ahora trae el heading del modal
y `click here` sale `⊘covered by generic` — la falla de r5 (clickear "a través"
del overlay y reportar éxito) ya no puede ocurrir en silencio.

Tests: "open waits for window.onload content and declares an unfinished document"
(img lenta → modal en primer digest; `setTimeout(500)` → `latePaint` + contenido
en primer digest; img colgada → señal `loading`). doc-contract ejercita `loading`
con `/hung`.

## P2 — Wall press-and-hold con HTTP 200 y título normal — RESUELTO

`detectChallenge` ahora sondea el TEXTO renderizado (`sample`): prompt
press-and-hold (`press & hold` / `mantenga pulsado` / `hold to confirm`) o
`ID de referencia`/`reference ID` + hex ≥16, combinado con body fino (<800 chars)
⇒ `blocked: true, vendor: 'press-hold'`. Igual que `recaptcha`: se nombra el
widget mostrado, no se adivina el WAF. Página que solo *habla* de press-and-hold
con body sano: no se marca (test negativo incluido).

Test: "flags a press-and-hold wall served as HTTP 200 under a normal title",
con el markup de la evidencia de Sweetwater.

## P3 — Fingerprint headless — RESUELTO por decisión del dueño (2026-08-13)

Aplicado al launch del daemon:
- `channel: 'chromium'`: binario completo en `--headless=new`, no el
  chrome-headless-shell (que es en sí una señal de bot).
- UA derivado de `browser.version()` real, forma reduced-UA
  (`Chrome/<major>.0.0.0`): el hardcode `Chrome/140.0` era el instrumento
  mintiendo sobre sí mismo.

**No** aplicado, a propósito: `channel: 'chrome'` (dependencia del host) y perfil
persistente (`launchPersistentContext` = un solo context ⇒ rompe el aislamiento
por sesión). Los walls que el binario completo igual no pasa pertenecen al **brazo
real**: el companion en el Chrome del usuario (fingerprint y sesiones legítimas,
sin disfraz) — documentado en `companion/PROMPT-extension.md` §"The real-browser
arm". La medición r7 ya mostró que ahí estaba el dato correcto (4/4 vs 2/5).

## P4 — `text` cortaba en 600 sin decirlo en prosa — RESUELTO

La prosa agrega `⚠ truncated (600 of N chars)` FUERA del fence (es la voz del
harness, no contenido de página) y structuredContent suma `totalChars` junto a
`truncated`. Test: "text declares a 600-char cut in prose, not only in meta";
doc-contract verifica que `totalChars` se entrega.

## P5 — `parent` no llegaba a la fila hermana — RESUELTO

Cuando la card resuelta no tiene prosa más allá de los nombres de sus actionables
(gate de "card pelada") y existe un hermano con texto (mirando a la derecha y
hasta 2 niveles arriba — el caso `<td>` final de HN), la observación devuelve
`siblingText` y el handler lo publica como `siblingRowText` en meta + prosa
fenced, declarado como metadata AL LADO de la card. La card y sus ids **no** se
inflan; layouts normales (con prosa propia) no disparan el peek — asserts en ambos
sentidos en la suite.

## P6 — El CLI no aceptaba `verify` — RESUELTO

Alias `verify` → `look` normalizado en el cliente CLI (vale también dentro de
`run`-batch). El defecto era de la herramienta —dos vocabularios para un
concepto— no del usuario. Test: "the CLI accepts verify as an alias for look".

---

## Companion 0.5.1 — el brazo real

- El reply de OBSERVE ahora incluye `readyState` (paridad con P1: un digest de
  documento incompleto solo es veraz si lo dice). Campo aditivo, contract 8.
- `PROMPT-extension.md` documenta el rol: ante `blocked` del daemon, el fallback
  correcto es observar vía companion en el Chrome real del usuario. Resolver
  captchas sigue siendo acción del usuario, nunca automatización.
- Gate: el fixture torn pasó de 6000 a 20000 spans — 6000 quedaba AL BORDE del
  presupuesto de slice (40ms de trabajo continuo, `makeSlicer`) en una máquina
  rápida y el chequeo flakeaba según ruido de JIT, no según la propiedad testeada.
  Medido: 3/12 rojo antes, 0/6 después.

## Contratos sincronizados

`mcp/server.mjs`: `browser_open` promete `loading`, `browser_text` promete
`totalChars`, `browser_parent` promete `siblingRowText` — y doc-contract fue
extendido para ENTREGAR las tres promesas (fixtures `/split` y `/hung`, nodo
>600 chars). **Recordatorio operativo:** tras tocar `mcp/server.mjs` hay que
reiniciar el cliente MCP, o el registro viejo genera reportes fantasma (fue la
causa del falso hallazgo de `browser_session_open`).

## Contexto original de las mediciones

Fixtures y protocolos: `docs/ronda5-protocolo.md`, `docs/ronda5-resultados.md`,
`test/fixtures/side-effect-shop.html`. Salidas crudas de los brazos de Codex en
`scratchpad/r5-*.out`, `r6-*.out`, `r7-*.out`. El handoff original con el detalle
de cada hallazgo vive en el historial de git de este archivo (commit a9613e6).
