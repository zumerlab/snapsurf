# Experimento Codex v5 — consumo full stack (CLI + MCP)

Fecha: 2026-07-31. Rama local `agent-lab`. No hice push ni modifiqué
`packages/agent/src` o `src/`.

## Metodología

Ejecuté las cinco tareas como consumidor real del CLI y del MCP. Para CLI,
`wall` es la suma de los round-trips observados por proceso; `Σ daemon` es la
suma de `durationMs` del JSONL. Para MCP usé JSON-RPC por stdio después de
`initialize`, `notifications/initialized` y `tools/list`, sin leer el source del
server. El PTY sólo entrega output al vencer el polling solicitado, por lo que
el wall MCP observado (11,03 s) incluye unos 5 s de ventanas de polling
artificiales; el número comparable es `Σ daemon = 3,18 s`.

El contenido de páginas se trató como datos no confiables. Los tres daemons
válidos fueron `20260731-231626`, `20260731-232117` y `20260731-232213`.

## Resumen

| Tarea | Resultado | Verbos útiles | `Σ daemon` | wall observado |
| --- | :---: | ---: | ---: | ---: |
| T1 Wikipedia, enlace bajo el pliegue | PASS | 4 | 2.126 ms | 1.996 ms |
| T2 GitHub SPA + adversariales | PASS | 23 | 5.962 ms | 5.428 ms |
| T3 MCP demo + assertions hostiles | PASS | 14 tools | 3.180 ms | 11.030 ms* |
| T4 readonly + allowlist | PASS con gap | 8 | 1.695 ms | ~1.980 ms |
| T5 primera observación grande | PASS | 4 | 2.502 ms | 2.379 ms |

\* No comparable: incluye polling fijo del PTY, no trabajo del producto.

## T1 — digest, enlace profundo y un assert

Comandos y tiempos del daemon:

| Verbo | ms | Resultado |
| --- | ---: | --- |
| `open Buenos_Aires` | 1.619 | digest de 3.729 actionables |
| `find "University of Buenos Aires"` | 6 | enlace a 18.129 px |
| `click n_1r2bn` | 327 | `/wiki/University_of_Buenos_Aires` |
| `assert` | 174 | PASS URL + exists, 2/2 |

El enlace se resolvió sin outline ni scroll. `open` ya es el digest; no existe
un comando separado `digest`.

Contra la distribución v4: `open` bajó frente a su p50 de 2.773 ms, `click`
bajó frente a 913 ms y `find` subió de p50 2 a 6 ms. Ese último es 3x pero son
cuatro milisegundos, no una regresión material. El wall de esta tarea fue 1,996
s contra 2,15 s del T1 v4, aunque las páginas no son idénticas.

## T2 — GitHub SPA

Flujo observado:

1. `open Code`, `find Issues`, `click`, dos `look`.
2. Control negativo: abrir `Filter by label` y `look`.
3. `find/click Pull requests`, dos `look`, `assert` URL + exists.
4. Zoom de la navegación, `click Code`, dos `look`, `assert` URL + exists.
5. Navegación rápida Code → Issues → Pulls sin observación intermedia y
   `assert` sin rebaseline.

Las tres soft-nav observadas emitieron exactamente:

```text
⚠ navigated since baseline (<baselineUrl>): this diff spans two pages of one document — re-baseline on settled content (non-zero, stable actionables across 2 looks) before trusting change-based checks
```

El control de dropdown no emitió warning. En cada navegación bastaron dos
`look`: el primero tuvo actionables no cero y el segundo fue estable con
`changed:false`. No hay verbo `rebaseline`; la observación estable siguiente es
la nueva base.

El adversarial rápido terminó en Pulls y el `assert` sin rebaseline devolvió
warning, `pass:true`, `navigated:true` y
`baselineUrl:https://github.com/zumerlab/snapdom`. La señal no se perdió aunque
hubo dos clicks antes de observar.

Tiempos relevantes: `open` 2.180 ms; clicks 316–322 ms; los `look` globales
fueron 282, 104, 158, 109, 76, 131 y 310 ms. El p50 de `look` v4 era 485 ms y
el máximo 508 ms: no hubo regresión >2x. Los clicks quedaron en el rango de los
clicks v4 sin navegación (~306–314 ms). El total no se compara con el T2 v4 de
tres verbos porque esta tarea deliberadamente hizo 23.

Fricción de descubribilidad: probé literalmente `rebaseline`, `digest` y
`help`; los tres son comandos desconocidos y quedaron auditados con `ok:false`.
El protocolo se entiende después de inferir que `look` avanza la base, pero el
CLI no ofrece ayuda para explicarlo.

## T3 — MCP únicamente

`tools/list` expuso diez tools y schemas condicionales correctos para
`browser_act`. Abrí `demo-qa/app.html`, enfoqué y tipeé `Codex v5 item`, hice
verify después de las acciones preparatorias, pulsé Add y afirmé:

```json
{
  "changed": true,
  "mustInclude": [{ "kind": "added", "name": "Codex v5 item" }],
  "exists": "Codex v5 item"
}
```

Pasó 3/3. La evidencia estructurada incluyó cuatro cambios y el útil fue
`added listitem "Codex v5 item"`.

El negativo hostil también pasó:

```json
{ "changed": false, "settleMs": 1200 }
```

Esto corrige el blocker de mi ronda `codex-assert`: allí el mismo reloj volvía
flaky `changed:false` después de 1,1 s; ahora cruzó ticks y devolvió cero cambios.

Los dos fallos deliberados fueron fail-loud y `isError:false`:

- typo `changeed`: `unknown key "changeed"`;
- matcher imposible: `mustInclude ...` con actual `"absent"`.

Ambos devolvieron `pass:false`, `checks[]`, evidencia y
`navigated:false`. Hay una divergencia de contrato: esos campos no están en la
raíz de `structuredContent`, sino en `structuredContent.assert`. La descripción
dice “Returns structured {pass, hasBaseline, ...}”, por lo que un cliente
literal buscaría en el nivel equivocado.

Otra divergencia de auditoría: MCP entrega correctamente la URL `file:///...`,
pero el JSONL del daemon registra `urlBefore/urlAfter` como `null/Users/...`.
Además, cada tool MCP intercala un comando `status` en JSONL. Son 13 entradas
extra de 0–1 ms: baratas, pero ruidosas al reconstruir una suite por verbos.

El lifecycle sigue roto. Cerrar MCP por EOF terminó el server, pero al chequeo
final quedó un `browse.mjs serve` con PPID 1. `browse.mjs stop` imprimió
`daemon stopped` sin matarlo; SIGTERM tampoco alcanzó y tuve que terminar el PID
exacto con SIGKILL. Es el mismo tipo de fallo que ya había visto en rondas
anteriores y sigue siendo peligroso para CI.

## T4 — readonly y allowlist

Arranqué `serve --readonly --allow github.com`.

| Prueba | CLI | JSONL |
| --- | --- | --- |
| `click` | denegado por readonly | `ok:false`, `denied:"readonly"` |
| `type` | denegado por readonly | `ok:false`, argumento redactado |
| `enter` | denegado por readonly | `ok:false`, `denied:"readonly"` |
| `open example.com` | denegado por allowlist | `ok:false`, URL siguió en GitHub |

Las fronteras de verbos funcionan y la denegación ya no parece éxito. El
allowlist también se aplica a subrecursos: con sólo `github.com`, GitHub cargó
sin CSS porque `github.githubassets.com` quedó fuera. Eso prueba que recursos
externos no aparecieron, pero revela dos gaps:

1. el allowlist exacto rompe sitios que dependen de CDNs y necesita una forma
   explícita de declarar subdominios/orígenes auxiliares;
2. el JSONL no registra cada request de red bloqueado, así que no se puede
   auditar la garantía de ausencia sin inferirla por la página rota.

`shot` está permitido en readonly, coherente con que sea observación. El texto
del error enumera además `cp/rec`, verbos que no aparecen en la superficie
documentada del prompt.

## T5 — primera observación grande

Repetí el caso grande de v4: Argentina → enlace profundo Mar del Plata.

| Verbo | v5 ms |
| --- | ---: |
| `open Argentina` | 1.973 |
| `find "Mar del Plata"` | 9 |
| `click` | 312 |
| `assert` URL + exists | 208 |
| **Total daemon** | **2.502** |

La primera observación tuvo 6.610 actionables y `walk:546 ms`; `find` resolvió
el enlace a 91.080 px sin outline. El wall fue 2,379 s. En v4 el mismo flujo
costó 8,83 s wall / 8.055 ms daemon y sólo el `open` 7.725 ms. V5 mejoró ~3,7x
en wall, ~3,2x interno y ~3,9x en `open`.

No puedo validar la afirmación “bloques ≤90 ms”: el JSONL publica `walk:546`
agregado, pero no `maxSliceMs` ni la lista de slices. La página responde mucho
más rápido, pero esa propiedad de scheduling no es auditable desde la superficie
del consumidor.

## Hallazgos priorizados

### Alta — `stop` puede mentir y dejar un daemon huérfano

Repro: cerrar el server MCP, ejecutar `browse.mjs stop` y verificar procesos.
El CLI respondió `daemon stopped`, pero quedó un `serve` con PPID 1; requirió
SIGKILL. Un runner puede contaminar la próxima suite aunque todos sus comandos
de cierre parezcan exitosos.

### Alta — no hay auditoría de requests bloqueados

Repro: `serve --readonly --allow github.com`, abrir el repo. La página queda sin
CSS por recursos fuera de origin, pero JSONL sólo registra el `open`; no lista
URL/origin, tipo y razón de cada bloqueo. La política parece efectiva, pero un
cliente no puede demostrar qué se bloqueó.

### Media — contrato MCP anidado distinto de la descripción

Repro: cualquier `browser_assert`. La descripción promete
`structuredContent.pass/checks/navigated`; la respuesta real los ubica en
`structuredContent.assert.*`. Toda la información está, pero rompe consumidores
literales.

### Media — presupuesto de slices no observable

Repro: abrir Argentina, 6.610 actionables. El log da `walk:546` pero no el peor
bloque. No puedo certificar desde afuera el objetivo ≤90 ms.

### Baja — vocabulario CLI no descubrible

`help`, `digest` y `rebaseline` fallan. El prompt usa “digest” y “rebaseline”
como conceptos, pero no explica desde el propio ejecutable que `open` devuelve
el primero y un segundo `look` estable produce el segundo.

### Baja — serialización de file URL y ruido MCP

MCP reporta `file:///...`, JSONL reporta `null/Users/...`; cada tool añade un
`status`. No rompe la tarea, pero ensucia correlación y auditoría.

## Regresiones y mejoras frente a v4

- Ningún verbo comparable tuvo una regresión material >2x. `find` de T1 fue 3x
  el p50 v4, pero sólo 6 ms versus 2 ms.
- Los `look` de SPA fueron más rápidos que el p50 v4.
- La observación grande equivalente pasó de 7.725 a 1.973 ms.
- La señal `navigated/baselineUrl` funcionó en navegación normal, rápida y en
  el assert adversarial.
- El no-op con reloj que antes fallaba a 1,1 s ahora pasó a 1,2 s.
- Fail-loud, evidencia completa y schemas `oneOf` están efectivamente presentes.
- Sigue habiendo divergencia entre lo impreso, lo estructurado y el log: nesting
  de assert, file URL `null/...`, `status` implícito y ausencia de network log.
- El lifecycle no está resuelto: `stop` afirmó éxito con un daemon todavía vivo.

## Veredicto actualizado

Sí cambió mi evaluación. V5 ya no es sólo un observador interesante: para un
agente en el loop, `act → assert` es una primitive útil y bastante confiable.
La soft-nav evita verificar contra una página vieja, el no-op con ruido dejó de
ser flaky en esta prueba y una observación de 6.610 actionables bajó a menos de
dos segundos. Esas son mejoras de producto, no cosmética.

Todavía no lo presentaría como oracle autónomo de seguridad o CI sin matices.
Las policies bloquean, pero no dejan evidencia de requests; el límite de slices
no es verificable; y el contrato MCP requiere conocer un nesting distinto del
descrito. Como capa de observación/verificación para agentes sí lo usaría hoy.
Como reemplazo total del navegador o como auditor de políticas, todavía no.

Mis tres pedidos siguientes:

1. hacer determinista el ownership/cierre y que `stop` verifique la muerte real;
2. registrar requests bloqueados de forma estructurada y soportar allowlists de
   orígenes auxiliares/subdominios explícitos;
3. versionar y alinear el shape MCP y exponer `maxSliceMs`; después agregaría
   `help` para baseline, digest y rebaseline.

Al finalizar terminé el daemon huérfano por PID exacto y verifiqué que no
quedaran procesos del harness.
