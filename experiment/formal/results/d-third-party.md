# Fase D — Benchmark de terceros (Mind2Web-Live / WebCanvas)

2026-08-01 · `claude-opus-5`, effort `high` · `experiment/formal/d-third-party.mjs`

Nuestro benchmark formal da **119/120 (99%)** con tareas que escribimos nosotros. Esta
fase corre tareas que **no** escribimos, sobre sitios vivos, juzgadas con criterios que
**no** escribimos: el subconjunto de `iMeanAI/Mind2Web-Live` cuyos "key nodes" son 100%
evaluables por URL (`url_included_match` / `url_exactly_match`) — 23 de las primeras 40
tareas; se corrieron 8. La métrica (key nodes completados) es de WebCanvas, no nuestra.

## El resultado que importa

| Benchmark | Éxito |
|---|---:|
| Nuestro benchmark formal (tareas propias) | **99%** (119/120 celdas) |
| **Mind2Web-Live, brazo oráculo (tareas de terceros)** | **28%** (8/29 key nodes) |
| Tareas con TODOS sus key nodes | 1 de 8 |

**Nuestras tareas eran fáciles.** El 28% cae exactamente donde la literatura sitúa a los
agentes actuales en web viva (~30%, *An Illusion of Progress?*, 2025). Es la confirmación
empírica de la advertencia que el `LANDSCAPE.md` ya nos había hecho, y la razón por la
que el 119/120 **no debe usarse como prueba de capacidad** — mide el canal en tareas
alcanzables, no la capacidad del agente.

## Por tarea (brazo oráculo, corrida completa)

| # | tarea | key nodes | pasos | tokens |
|---|---|---:|---:|---:|
| 5 | overview de submission of releases | **2/2** | 6 | 15k |
| 0 | Gamestop más cercano al 90028 + set as home store | 1/2 | 25 | 126k |
| 1 | comparar planes de AeroAPI en flightaware | 1/3 | 22 | 90k |
| 3 | estado del tren S92 en new.mta.info | 1/3 | 6 | 7k |
| 8 | buscar persona por dirección en yellowpages | 1/5 | 22 | 133k |
| 10 | malla enteriza talle plus más barata | 1/8 | 25 | 138k |
| 12 | Tesla Model 3 2022 en carmax | 1/3 | 19 | 91k |
| 4 | estado de reparación de iPhone en apple | 0/3 | 11 | 26k |

Patrón: llega al sitio (primer key node) casi siempre, y se pierde en los pasos
intermedios — filtros, formularios de varios campos, flujos con login o estado previo.

## El brazo de píxeles quedó INCOMPLETO — no lo comparo

Se agotó el crédito de la API a mitad de la corrida. De las 8 tareas, **solo 3 llegaron
a ejecutarse**; las otras 5 devolvieron `400 credit balance too low` con 0 pasos.

Sobre esas 3 tareas comparables, los números son:

| # | oráculo | píxeles |
|---|---:|---:|
| 0 | 1/2 | 1/2 |
| 1 | 1/3 | **2/3** |
| 3 | 1/3 | **2/3** |
| total | 3/8 | **5/8** |

**Con n=3 tareas esto no sostiene ninguna conclusión** — pero la dirección va en contra
nuestra, no a favor, y por eso queda escrito. La afirmación honesta es: **esta fase no
aporta evidencia de que el canal semántico mejore el éxito en tareas de terceros**; su
ventaja medida está en costo y en verificación (Fases B y C), no en capacidad.

## Higiene: un fallo mudo propio, otra vez

La primera corrida del brazo de píxeles reportó "17% de key nodes" con cinco episodios de
0 pasos. Mi `catch { break }` **silenciaba el error de la API** y los episodios muertos
se leían como fallos legítimos del agente. Corregido: reintento con backoff ante 429/5xx
y el error registrado en cada resultado. Es la tercera vez en este ciclo que el fallo
mudo aparece en mi propio harness — el mismo patrón que el producto persigue en las
páginas.

## Qué haría falta para cerrarla

- Reponer crédito y correr el brazo de píxeles completo (8 tareas ≈ $4).
- Ampliar a las 23 tareas URL-evaluables y ≥2 reps (≈ $25-30).
- Los key nodes de `element_path` quedan fuera: evaluarlos requiere replicar el harness
  de DOM de WebCanvas.

## Reproducir

```bash
export ANTHROPIC_API_KEY=...
node packages/agent/experiment/formal/d-third-party.mjs --arm oracle --tasks 8
```

Datos crudos: `results/d-third-party-oracle.json` (incluye URLs visitadas y el detalle
de cada key node).
