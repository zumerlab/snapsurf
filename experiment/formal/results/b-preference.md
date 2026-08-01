# Fase B — Preferencia revelada del modelo

2026-08-01 · `claude-opus-5`, effort `high` · 6 misiones largas · 3 brazos ·
`experiment/formal/b-preference.mjs` · costo total **$10,61**

**La pregunta del user**: ¿al propio LLM le resulta preferible usar el oráculo antes que
sus herramientas habituales? El diseño elimina el sesgo: **sin la skill `agent-browse`**
(que le dice a Claude que use el oráculo), sin instrucción de preferencia, y con los dos
canales descritos en el mismo registro — nada de "recomendado" o "más barato". Los dos
canales operan **el mismo browser real**, así que cualquiera resuelve la tarea.

## Respuesta: sí, y por amplio margen

**En elección libre, el modelo eligió el oráculo en 63 de 81 pasos con canal (78%) —
y en las seis tareas, sin excepción.**

| brazo | pasos | píxeles | oráculo | tokens in | costo |
|---|---:|---:|---:|---:|---:|
| **Elección libre** | 93 | 18 | **63** | 537k | $3,09 |
| Solo píxeles (forzado) | 98 | 78 | — | 1.078k | $6,02 |
| Solo oráculo (forzado) | 80 | — | 71 | 216k | **$1,50** |

## Elección por tarea (brazo libre)

| tarea | tipo | píxeles | oráculo |
|---|---|---:|---:|
| m1 | extracción acumulada (5 historias de HN) | 2 | 17 |
| m2 | formulario + validación silenciosa | 5 | 9 |
| m3 | navegación profunda bajo el fold | 0 | 4 |
| m4 | ruido ambiental / verificación de no-op | 3 | 8 |
| m5 | SPA a medio hidratar | 2 | 8 |
| m6 | recuperación de acción bloqueada | 6 | 17 |

Ni una sola tarea con mayoría de píxeles. El patrón cualitativo: usa screenshot para
**orientarse** al principio, y pasa al oráculo para **operar y verificar**.

## Punto de cruce de tokens (deuda vieja, ahora medida)

Comparando los dos brazos forzados sobre la misma tarea:

| tarea | oráculo | píxeles | factor |
|---|---:|---:|---:|
| m3 navegación profunda | 13,7k | 199,3k | **14,5×** |
| m5 SPA a medio hidratar | 27,3k | **447,6k** | **16,4×** |
| m6 recuperación | 56,9k | 166,2k | 2,9× |
| m2 formulario | 39,4k | 103,9k | 2,6× |
| m1 extracción | 50,1k | 115,6k | 2,3× |
| m4 ruido ambiental | 28,6k | 45,2k | 1,6× |
| **total** | **216k** | **1.078k** | **5,0×** |

**El cruce no está en un turno fijo: está en el tipo de tarea.** Donde el objetivo está
fuera del viewport (m3) o la página cambia sin delta visual claro (m5), el canal de
píxeles no converge — m5 con píxeles **tocó el techo de 30 pasos** y gastó 447k tokens
donde el oráculo resolvió en 11 pasos y 27k. En tareas visuales simples (m4) el factor
cae a 1,6×, que es la cifra honesta a citar como piso.

## Lo que NO prueba

- **n=1 por celda.** Seis tareas, una corrida por brazo. Dimensiona el efecto; no lo
  establece. El plan pedía ≥3 reps y eso queda pendiente.
- **Un solo modelo** (`claude-opus-5`). Otro modelo podría elegir distinto.
- **Las tareas las escribí yo**, igual que en el benchmark formal — la Fase D corrige
  eso con tareas de terceros.
- El brazo libre **no midió calidad de respuesta contra un juez**: midió elección,
  pasos y tokens. Las respuestas se leyeron a mano y las seis eran correctas
  (incluida la detección de la falla silenciosa en m2: *"No, la suscripción NO se
  agregó a la lista"*).

## Falsación declarada de antemano — no ocurrió

El plan decía: *"si en el brazo libre el modelo elige las tools nativas en la mayoría de
los pasos y las tareas se completan igual, el valor percibido no existe"*. Eligió el
oráculo en el 78% de los pasos, así que la hipótesis sobrevive. Pero conviene decir el
matiz: **también usó píxeles en 18 pasos** — no los abandonó, los usó para orientarse.
El resultado apoya el encuadre híbrido del `LANDSCAPE`, no un reemplazo.

## Reproducir

```bash
export ANTHROPIC_API_KEY=...
node packages/agent/experiment/formal/b-preference.mjs --arm free    # o pixels | oracle
```

Datos crudos: `results/b-preference-{free,pixels,oracle}.json` (incluye la secuencia de
herramientas por paso y los tokens por turno).
