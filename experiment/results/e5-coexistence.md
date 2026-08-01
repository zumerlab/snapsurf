# E5 — Coexistencia: nuestro oráculo DENTRO de agent-browser

2026-08-01 · `experiment/e5-coexistence.mjs` · agent-browser 0.33.1

La pregunta estratégica del `LANDSCAPE.md`: si funcionamos dentro de su flujo sin
reemplazarlos, dejan de ser rival y pasan a ser **canal de distribución** — la
debilidad #1 que el relevamiento nos encontró.

## Funciona

| | |
|---|---|
| Bundle del oráculo | **45 KB** (observe + buildUi) |
| Vía de inyección | su propio `agent-browser eval --stdin` |
| `typeof window.__sdObserve` tras inyectar | `"function"` |
| Su flujo | **intacto**: `open` y `click` siguen siendo de ellos |
| Nuestro diff del mismo instante | `state button "Enviar"` + `style` + `moved` |

El flujo completo es: `open` (suyo) → inyectar 45 KB por su `eval` → checkpoint
(nuestro) → `click` (suyo) → diff semántico (nuestro). **Cinco comandos, ninguna
modificación de su herramienta.**

## Los dos diffs, mismo browser y misma acción

Su salida (diff textual del árbol de accesibilidad):

```
-- heading "Formulario" [level=2, ref=e1]      +- heading "Formulario" [level=2, ref=e4]
-- StaticText "--:--:--"                       +- StaticText "10:47:20"
-- button "Validar" [ref=e2]                   +- button "Validar" [ref=e5]
-- button "Enviar" [disabled, ref=e3]          +- button "Enviar" [ref=e6]
```

La nuestra:

```json
{ "changed": true, "changes": [
  { "kind": "state", "role": "button", "name": "Enviar" },
  { "kind": "style", "role": "button", "name": "Enviar" },
  { "kind": "moved", "role": "button", "name": "Validar" } ] }
```

**Honestidad sobre la comparación**: su diff **sí muestra** el flip de `disabled`
(desaparece de la serialización) — no lo pierde. La diferencia es la forma:

- Ellos entregan **cuatro líneas que cambiaron**, tres de las cuales cambiaron solo
  porque el ref se renumeró y una porque el reloj avanzó. El consumidor tiene que
  descubrir por su cuenta cuál importa.
- Nosotros entregamos **el hecho tipado**: `state` sobre el botón llamado "Enviar".
  Eso es directamente asertable (`mustInclude: [{kind:'state', name:'Enviar'}]`) sin
  que nadie escriba un parser.

**El reloj ensucia los dos diffs** en esta configuración. La diferencia es que el
nuestro se acota con `ignore: ['#clock']` — que es exactamente lo que la Fase C usó
para llegar a 0 falsos verdes.

## Lectura estratégica

1. **Deja de ser una elección excluyente.** Un equipo que ya usa agent-browser puede
   sumar la capa de verificación sin migrar nada: su CLI para operar, nuestro oráculo
   para decidir si la acción funcionó.
2. **Es la vía de distribución más barata que tenemos.** No requiere que adopten
   nuestro daemon, nuestro MCP ni nuestra extensión: requiere un `eval --stdin`.
3. **Y refuerza el encuadre**: lo que aportamos no es "otra forma de ver la página"
   —eso ya lo tienen— sino **la capa que decide si el efecto pretendido ocurrió**.

## Landmine encontrada al automatizar

La prueba manual funcionó a la primera y el script falló en silencio: `execFile` de
Node **no acepta la opción `input`** (es de `execFileSync`), así que la inyección
nunca ocurría y `typeof` daba `"undefined"`. Hay que escribir al stdin del hijo a
mano con `spawn`. Un fallo mudo idéntico al que este proyecto persigue en las páginas.

## Reproducir

```bash
npm install -g agent-browser
node packages/agent/experiment/e5-coexistence.mjs
```
