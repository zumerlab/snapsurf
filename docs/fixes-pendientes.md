# Fixes pendientes — handoff

Hallazgos de las rondas 5–7 (2026-08-13), verificados. Este documento es
autocontenido: no hace falta la conversación donde salieron.

Repo: `snapdom-agent`. Todos los paths son relativos a la raíz.
Orden: por impacto sobre un agente real, no por esfuerzo.

---

## P1 — `open` observa antes de `window.onload`: los modales de carga no existen

**Archivo:** `tools/browse.mjs:1578`

```js
resp = await S.page.goto(full, { waitUntil: 'domcontentloaded', timeout: 45000 })
```

**Qué pasa.** Todo lo que la página pinta en `window.onload` —entry ads, cookie
banners, overlays tardíos— **no entra en el digest**, y el agente no recibe ninguna
señal de que falta algo. Ve una página con 2 actionables y la da por completa.

**Repro exacto:**

```bash
node tools/browse.mjs serve &
node tools/browse.mjs open "https://the-internet.herokuapp.com/entry_ad"
# → 2 actionables, sin modal, sin aviso. `find "Close"` no encuentra nada.
node -e 'await new Promise(r=>setTimeout(r,2500))'
node tools/browse.mjs look
# → CHANGES (15): added "This is a modal window", added "Close", …
```

**Descartado como causa:** no son las `CONTEXT_OPTIONS` (`tools/browse.mjs:394-399`).
Con `viewport`, `userAgent`, `bypassCSP` y `locale: 'es-AR'` idénticos, Playwright
pelado sí muestra el modal. Es el momento de la observación.

**Por qué importa más que otros bugs.** La clase de elemento que aparece en `onload`
es justo la que **bloquea clicks**. Un agente que no la ve no falla ruidosamente:
clickea "a través" del overlay y reporta éxito. En la ronda 5 le costó ~9 llamadas
al brazo de Claude y una sesión entera al de Codex, que reportó *"la primera sesión
no expuso el modal pese a re-habilitarlo y recargar"*.

**Fix sugerido.** Esperar `load` en vez de `domcontentloaded`, o mantener
`domcontentloaded` y añadir un settle corto con reobservación. Si se elige no
esperar, el digest DEBE decir que la página sigue cargando — el modo de falla
inaceptable es el silencio. Ojo con no romper el timeout de 45s en páginas con
recursos lentos: `load` espera imágenes.

---

## P2 — Wall con HTTP 200 y título normal que el detector no ve

**Archivo:** `tools/browse.mjs:1457-1510` (tabla `WALLS` + `detectChallenge`)

**Qué pasa.** Sweetwater sirve un desafío *press-and-hold* con **HTTP 200** y el
título normal de la página (`"special 20 harmonica key of C - Sweetwater"`). El
detector no lo marca: devuelve una observación común, **0 actionables**, sin
`blocked: true` ni `challenge`. Para el agente eso se lee como "no hay resultados".

**Evidencia capturada** (`outline` de esa observación):

```
div [375,354 530x48] "Mantenga pulsado para confirmarque es una persona (y no un bot)."
div [375,542 530x28] "ID de referencia e0682d10-9744-11f1-af41-8f088269f1b8"
```

**Por qué la entrada actual no alcanza.** La regla `perimeterx` (línea 1470) exige
`title: /access to this page has been denied/i`, y acá el título es legítimo. El
body tampoco trae `px-captcha`/`perimeterx`/`_pxhd` visibles en el texto renderizado.

**Contraste que lo confirma como bug propio:** en la misma tarea, el brazo nativo de
Codex (Playwright + shell) **sí** lo distinguió y lo reportó como bloqueo:
`"HTTP 403 y texto en pantalla: Press & Hold to confirm you are a human (and not a
bot)"`. Otro agente, mismo wall, detección correcta.

**Firma propuesta** (cualquiera de las dos, combinadas con `actionables === 0`):
- texto que matchee `/press\s*&?\s*hold|mantenga pulsado|hold to confirm/i`
- `/(ID de referencia|reference ID)\s*[:\s]\s*[0-9a-f-]{16,}/i`

Los tres walls de HTTP 403 de la misma corrida (Guitar Center/akamai,
Sam Ash/datadome, American Musical/datadome) **sí** se detectaron bien. El agujero es
sólo el 200-con-título-normal.

**Test:** agregar el caso a la suite de walls con un fixture que reproduzca ese
markup. No hace falta pegarle al sitio real.

---

## P3 — Fingerprint headless: el daemon pierde contra un browser común

**Archivo:** `tools/browse.mjs:381`

```js
const browser = await chromium.launch({ headless: !ARGS.includes('--headed') })
```

**Medición (ronda 7, misma tarea, tres brazos):**

| brazo | sitios con dato | bloqueados |
|---|---|---|
| Browser pane (browser real) | 4 de 4 | 0 |
| Codex + Playwright headless | 3 de 6 | 3 |
| **este daemon** | 2 de 5 | 3 + 1 sin detectar |

Sweetwater y Guitar Center frenaron al daemon y al Playwright de Codex, y dejaron
pasar al browser real sin fricción. **El dato correcto estaba detrás del wall**: el
daemon reportó $74.99 de una variante *Country-tuned*, mientras el browser real
encontró el producto pedido, `Hohner Special 20 Harmonica - Key of C, $50.00`.

**Fix sugerido** — ninguno requiere resolver captchas:
- `chromium.launch({ channel: 'chrome' })` (Chrome real en vez de Chromium bundled)
- headless nuevo (`chrome-headless-shell` NO; el modo `--headless=new`)
- contexto persistente con perfil, para tener historial de cookies
- coherencia del UA con la versión real del binario — hoy `CONTEXT_OPTIONS`
  (`:396`) declara `Chrome/140.0` a mano, y si el binario no es 140 eso es
  justamente una señal de bot

**DECISIÓN DEL DUEÑO, no aplicar sin consultar:** cambia cómo se lanza el browser
para todo el producto, no sólo para esta prueba. Puede afectar determinismo de tests,
consumo de memoria y el contrato de aislamiento entre sesiones.

---

## P4 — `text` corta en 600 caracteres y la prosa del CLI no lo dice

**Archivo:** `tools/browse.mjs:1813-1826`

`structuredContent` sí trae `truncated: true`, pero el cliente CLI imprime sólo el
texto: **un valor cortado se lee como un valor completo.** En la ronda 5 el listado de
Hacker News se cortó a mitad del item #35 y hubo que recuperarlo con otra búsqueda;
el brazo de Codex reportó la misma forma del problema en `outline`
(*"truncó el contenido y omitió los puntos"*).

**Fix:** que la prosa del CLI marque el corte (una línea `⚠ truncado (600 de N)`).
Barato y elimina una clase entera de dato silenciosamente equivocado.

---

## P5 — `parent` no llega a la fila hermana

**Archivo:** verbo `parent` en `tools/browse.mjs` (~`:1702`)

Sube al ancestro con ≥2 actionables. En el `<table>` de Hacker News eso es el `<tr>`
del título, y los puntos/comentarios viven en el `<tr>` **hermano** — la "card"
queda incompleta y hay que caer a `text` sobre la tabla entera (que además trunca,
ver P4).

**Fix posible:** cuando el contenedor resuelto no tiene texto más allá del título,
considerar el hermano inmediato. Cuidado con no inflar la card en layouts normales.

Prioridad baja: es incomodidad, no dato equivocado.

---

## P6 — El CLI no acepta `verify`

`verify` es el nombre de la tool MCP; en el CLI el verbo es `look` y `verify`
devuelve `unknown command: verify`. Costó una llamada en la ronda 5.

**Fix:** alias de `verify` → `look` en el CLI. Una línea.

---

## Ya arreglado — no tocar

- **Descripción de `browser_session_open`.** Un reporte previo decía que el texto
  afirmaba que las sesiones comparten cookies. **Es falso en el árbol actual:**
  `mcp/server.mjs:347` dice *"Each session owns a private BrowserContext,
  cookie/storage jar…"*, coherente con `browser.newContext()` por sesión
  (`tools/browse.mjs:453`). El reporte vino de un registro MCP viejo cargado en el
  cliente, no del repo. Misma causa por la que `browser_scroll` y `browser_parent`
  no aparecían como invocables: **hay que reiniciar el cliente MCP tras tocar
  `mcp/server.mjs`.**

## Contexto de las mediciones

Fixtures y protocolos en el repo: `docs/ronda5-protocolo.md`,
`docs/ronda5-resultados.md`, `test/fixtures/side-effect-shop.html`.
Salidas crudas de los brazos de Codex en `scratchpad/r5-*.out`, `r6-*.out`,
`r7-*.out`.
