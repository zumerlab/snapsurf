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

## P7 — Convivencia multi-server en el puerto único — RESUELTO (2026-08-13, tarde)

**Hallazgo** (salido del propio reinicio del daemon): varios servers MCP del mismo
usuario (sesiones CLI, app de escritorio) comparten el puerto 8377, y un cliente con
`SNAPDOM_AGENT_TOKEN` en env nunca leía el token file — no podía autenticarse contra
el daemon de OTRO server: 401 → intento de criar hijo propio → EADDRINUSE → 40×500ms
→ *"daemon did not respond within 20s"*, mudo, por llamada. Peor: el path de
descubrimiento por defecto vivía en `tmpdir()`, que es entorno por-proceso — un daemon
criado por una app publicaba su token en una isla que el `tmpdir()` de otro consumidor
jamás nombraba. Ni `stop` lo veía ("daemon not running" con el puerto tomado).

**Resolución** (endurecida tras una ronda de revisión adversarial de 28 agentes —
ver más abajo; el token nunca viaja por el wire):

1. **Path canónico estable**: `~/.claude/snapdom-agent/daemon-<port>.token` — el home
   es el único path que todo proceso del mismo usuario resuelve igual (TMPDIR no).
   Ese cambio SOLO ya cierra el deadlock de islas: daemon y clientes computan el mismo
   path. El path viejo de tmpdir queda como fallback de LECTURA para daemons viejos aún
   corriendo. `SNAPDOM_AGENT_TOKEN_FILE` sigue mandando. (`tools/daemon-client.mjs`,
   `browse.mjs`, `mcp/server.mjs`.)
2. **`GET /owner`**: cédula de identidad del daemon, sin auth (loopback + Host, como
   todo), con `{v, daemon, pid, startedAt, logSession, port, tokenFile}`. Es
   **puramente diagnóstica**: nombra al dueño en el error y distingue "otro daemon
   snapdom" de un listener ajeno/ausente. **NO es fuente de descubrimiento de token.**
3. **Adopción segura + errores con nombre**: ante mismatch de HMAC contra un daemon
   vivo, CLI y MCP server releen el token SOLO de los archivos canónico/legacy que el
   propio cliente resuelve (0600 del mismo uid) y ADOPTAN el daemon corriendo. Si nada
   autentica: *"owned by another snapdom daemon (pid X, since Y…)"*, *"answers HTTP but
   not /owner — likely an older snapdom daemon"*, o *"does not speak the snapdom daemon
   protocol"*. `ensureDaemonOnce` clasifica adoptable / ajeno-inadoptable / puerto
   cerrado; el loop de espera trata el fallo de adopción como TRANSITORIO (la ventana
   bind→publish del ganador) y sólo nombra al dueño si se agota el presupuesto. Un hijo
   que muere antes de servir reporta su exit code. Watchdog `ppid === 1` en el server
   MCP (15 servers huérfanos de sesiones muertas observados en una tarde).

**Frontera de seguridad (lo que la revisión corrigió).** Un borrador previo metía el
`tokenFile` que nombra `/owner` —una respuesta SIN autenticar servida por quien tenga el
puerto— primero en la lista de candidatos a leer. Un usuario de OTRO uid que ocupe el
puerto podía apuntar ese path a un archivo world-readable con un token elegido por él y
ser adoptado como daemon de confianza (recibiendo URLs, texto tipeado, reglas de
`--redact`, y devolviendo diffs forjados). La raíz de confianza es *"sólo un lector
same-uid del archivo 0600 es de fiar"*: por eso la adopción NUNCA lee un path venido del
wire, sólo `TOKEN_FILE`/`LEGACY_TOKEN_FILE` client-resueltos. Además: adopción
serializada tras una promesa compartida y verificación de cada candidato con token
EXPLÍCITO (se publica al global recién tras verificar) — antes el trial mutaba el global
y llamadas concurrentes se corrompían; `/owner` se valida por identidad
(`daemon==='snapdom-agent' && v===1`), no por "tiene un pid numérico"; y un fallo de
lectura de token en el CLI cae a discovery `/owner` en vez de mentir "not running".

Tests ("dos servers, un puerto", en `audit-daemon-mcp`, 42/42): adopción con token
ajeno (~120ms donde antes había 20s), **squatter con `/owner.tokenFile` malicioso NO
adoptado** (regresión de seguridad, `cmdServed===0`), `/owner` con pid numérico sin
identidad ⇒ "alien", CLI sin token legible ⇒ nombra al dueño (no "not running"),
squatter no-daemon ⇒ diagnóstico veloz, y N llamadas concurrentes adoptan sin fallos
espurios.

**Revisión adversarial (28 agentes, 4 lentes).** Confirmó 8 hallazgos sobre el borrador
inicial: 2×HIGH de impersonación cross-uid vía `/owner.tokenFile` (seguridad y compat),
1×HIGH de corrupción por concurrencia en el global de trial, 1×HIGH de deshonestidad
("not running" con daemon vivo), y 4×MEDIUM (races bind→publish, `/owner` medio-válido
mal etiquetado, `foreignDaemonError(null)` sobre-afirmando, tests que no fijaban el
discovery). Todos aplicados.

**Nota operativa:** los gates que comparten el 8377 (contract-gates, doc-contract)
fallan en cascada si un daemon-isla pre-fix pisa el puerto — así se re-descubrió este
bug. Con el path canónico esa clase de entorno deja de poder existir.

## Contexto original de las mediciones

Fixtures y protocolos: `docs/ronda5-protocolo.md`, `docs/ronda5-resultados.md`,
`test/fixtures/side-effect-shop.html`. Salidas crudas de los brazos de Codex en
`scratchpad/r5-*.out`, `r6-*.out`, `r7-*.out`. El handoff original con el detalle
de cada hallazgo vive en el historial de git de este archivo (commit a9613e6).
