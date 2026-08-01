# WebVoyager-25 — el benchmark del competidor, corrido contra el oráculo

Réplica reproducible de la evaluación que publica **lumen** (Om Labs,
[omxyz/lumen](https://github.com/omxyz/lumen), MIT) sobre el benchmark **WebVoyager**
([MinorJerry/WebVoyager](https://github.com/MinorJerry/WebVoyager), Apache-2.0), con
nuestros brazos de percepción en lugar de los suyos.

La pregunta no es "¿quién gana?" sino **¿qué aporta el canal de percepción?**. Por eso
todos los brazos comparten loop, modelo, prompt, set de acciones, juez y métricas: la
única variable es **qué ve el modelo en cada turno**.

## Qué hace lumen (para saber qué estamos replicando)

lumen es un agente de navegador *vision-first*: loop de percepción sobre CDP donde el
modelo recibe **solo screenshots** (nada de DOM ni selectores), decide una acción
(click / type / scroll / goto) y observa el resultado. Encima del loop pone cuatro cosas
que no son percepción sino andamiaje: compresión de historia en dos niveles, `SiteKB`
(conocimiento por sitio precargado), `ActionVerifier` (heurística post-acción) y
`ModelVerifier` (una segunda llamada al modelo que hace de portero antes de declarar la
tarea terminada).

Su suite (`evals/webvoyager/run.ts`) hace:

1. Carga los 642 tasks de `WebVoyager_data.jsonl`.
2. Adapta fechas obsoletas (2023/2024) hacia el futuro conservando los gaps relativos.
3. Toma **25 tasks** con muestreo estratificado por sitio y RNG mulberry32 **semilla 42**.
4. Corre cada task con `maxSteps = 50`, timeout 600 s y **hasta 3 intentos**; si el juez
   reprueba, reinyecta el motivo del juez en la instrucción del intento siguiente.
5. Juzga con **gemini-2.5-flash**: recibe la pregunta, el razonamiento/acciones del
   agente y el **último screenshot**, y devuelve YES/NO con fundamentos.
6. Reporta `passRate`, `avgSteps`, `avgTokens`, `avgDurationMs` — **del intento que
   quedó registrado**, no de la suma de los 3.

Sus números publicados (en `baselines/`, son sus archivos, no re-runs nuestros):
lumen 25/25 · browser-use 25/25 · stagehand 19/25.

## Qué replicamos exactamente

| pieza | estado |
|---|---|
| dataset | **idéntico** — `data/WebVoyager_data.jsonl` es byte-idéntico al de ambos repos |
| selección de los 25 tasks | **idéntica** — `dataset.mjs` reproduce sus 25 ids en el mismo orden (verificable: `node dataset.mjs`) |
| adaptación de fechas | **port fiel** de su `run.ts` (mismo texto de instrucción) |
| maxSteps / timeout / trials | **idénticos** (50 / 600 s / 3 con feedback del juez) |
| juez | **mismo contrato**: mismo system prompt, mismo schema YES/NO, misma evidencia (traza + screenshot final). Backend gemini-2.5-flash si hay `GEMINI_API_KEY` |
| schema del reporte | **superset** del suyo — sus campos más `pass@1`, `tokensIn/Out`, costo y las trazas |

El screenshot final se le pasa al juez **en todos los brazos**, incluido el que nunca
vio píxeles. La evidencia de evaluación es igual para todos.

## Los brazos

| brazo | qué ve el modelo en cada turno |
|---|---|
| `pixels` | solo screenshot JPEG del viewport — la premisa vision-first, nuestro control |
| `oracle` | primer turno: outline + `agentMap`; después: **solo el diff** (`changes`, `actionabilityDelta`) — el producto |
| `hybrid` | screenshot + oráculo |
| `snap` | **una** captura snapdom → píxeles y semántica del *mismo instante* (agente embebido) |

Los brazos con oráculo tienen además dos verbos que no cuestan tokens de modelo porque
corren en la página: `find` (buscar texto en TODA la página, no solo en lo visible) y
`read` (leer el texto alrededor de un nodo). Es exactamente la ventaja que el producto
dice tener, y está declarada, no escondida.

## Cómo correrlo

```bash
# 1. Gratis: valida los 25 sitios, mide el payload de primer turno por brazo y estima costo
node packages/agent/experiment/webvoyager/run.mjs --dry --headless

# 2. Verificar que corremos los MISMOS 25 tasks que lumen
node packages/agent/experiment/webvoyager/dataset.mjs

# 2b. Gratis: humo del loop completo con una política scripteada (cero llamadas al modelo)
node packages/agent/experiment/webvoyager/run.mjs --mock --headless \
  --arms oracle,pixels,hybrid,snap --trials 1 --steps 6 --tasks "GitHub--25" --tag mock

# 3a. GRATIS: actor y juez sobre el tier gratuito de Google AI Studio
export GEMINI_API_KEY=...            # aistudio.google.com/apikey
node packages/agent/experiment/webvoyager/run.mjs --model gemini-2.5-flash --arms oracle,pixels

# 3b. Pago, para replicar el modelo exacto de lumen (requiere ANTHROPIC_API_KEY)
node packages/agent/experiment/webvoyager/run.mjs --arms oracle,pixels
node packages/agent/experiment/webvoyager/run.mjs --arms oracle --limit 5 --trials 1   # piloto barato

# 4. Tabla comparativa (nuestros results/ + sus baselines/)
node packages/agent/experiment/webvoyager/report.mjs --out RESULTS.md
```

Flags: `--arms` `--limit` `--trials` `--steps` `--model` `--tasks id,id` `--headless`
`--timeout` `--tag`. Modelo por defecto `claude-sonnet-4-6`, el mismo que usaron ellos.

## Correrlo sin gastar (backend Gemini)

El proveedor se elige por el id del modelo: `gemini-*` → Google AI Studio, cualquier otro
→ Anthropic. Con una key gratuita de AI Studio el benchmark completo cuesta **$0** sin
tocar el método: mismo loop, mismos brazos, tokens medidos igual (vienen de
`usageMetadata`), mismo juez.

Lo que hay que saber antes:

- **El tier gratis limita rate y requests por día.** Cada llamada (actor y juez) pasa por
  `retry.mjs`: back-off exponencial ante 429/5xx respetando `retry-after`. La corrida no
  se cae, se estira — planificá horas, no minutos, para los 25 tasks × 3 intentos.
- **Cambia el actor, y eso debilita la comparación EXTERNA.** Si el actor es
  `gemini-2.5-flash` y el de ellos era `claude-sonnet-4-6`, una diferencia contra sus
  filas puede ser del modelo y no del canal. La comparación **interna** (`oracle` vs
  `pixels`, mismo modelo, mismo loop) no se ve afectada, y es la que responde la pregunta
  del producto.
- **Privacidad**: en el tier gratuito Google puede usar los datos enviados para mejorar
  sus modelos. Acá se mandan screenshots y outlines de sitios públicos, pero conviene
  saberlo.
- El costo que reporta el JSON usa el precio de lista del tier pago (ver `../cost.mjs`),
  como referencia de "cuánto habría salido". En el tier gratis el gasto real es $0.

## Lecturas honestas antes de mirar cualquier número

**El 100% de lumen es pass@3 con pistas del juez.** Su harness reintenta hasta 3 veces y
le pasa al agente el motivo por el que el juez lo reprobó. Eso es una ayuda externa que
un agente en producción no tiene. El dato es recuperable de sus propios archivos: un
resultado registrado con `trial > 1` significa que el intento 1 fue reprobado. Corriendo
`report.mjs` sobre sus JSON:

| run | pass@3 (su titular) | pass@1 (derivado de sus archivos) |
|---|---|---|
| lumen | 25/25 (100%) | 23/25 (92%) |
| browser-use | 25/25 (100%) | 25/25 (100%) |
| stagehand | 19/25 (76%) | 16/25 (64%) |

Por eso nuestro reporte publica **las dos** columnas siempre.

**Sus `avgSteps`/`avgTokens` son del intento que quedó**, no del costo total de resolver
la tarea. Un task resuelto en el intento 3 aparece con los pasos del intento 3 y cero
mención de los dos anteriores. Nosotros guardamos ambos: `avgSteps`/`avgTokens` (mismo
criterio que ellos, comparable) y `avgStepsAllTrials`/`avgTokensAllTrials`/`usdAllTrials`
(lo que realmente costó).

**Lo que comparamos no es "producto vs producto".** lumen es un agente completo con
SiteKB, verificadores y caché de acciones; nuestros brazos son un loop mínimo cuya única
diferencia entre sí es el canal de percepción. Contra sus filas, nuestras filas miden
*canal*, no *producto*: si `pixels` queda por debajo de lumen, parte de esa distancia es
su andamiaje, no su canal. La comparación **interna** (`oracle` vs `pixels`, mismo loop)
es la única que aísla el canal, y es la que importa para el producto.

**Sitios vivos, no estacionarios.** Amazon/Booking/Google Flights cambian entre corridas
y pueden desafiar al harness. El `--dry` del 2026-08-01 dio 25/25 sitios cargados sin
bloqueos (`results/dry.json`), pero eso caduca; re-correlo antes de cada run pago.

## Estado de verificación (2026-08-01, sin gastar un centavo)

- `dataset.mjs` → los 25 ids y su orden coinciden con los de lumen: **sí**.
- `--dry` sobre los 25 sitios → 25/25 cargan, 0 bloqueos/captchas, payload medido por
  sitio (`results/dry.json`).
- Camino Gemini verificado contra un stub local del endpoint (`GEMINI_BASE_URL` apuntando
  a un servidor de prueba): request bien formado (imágenes como `inlineData`, schema sin
  `additionalProperties`, que Gemini no acepta), 429 reintentado y absorbido, tokens
  leídos de `usageMetadata`, juez invocado con el screenshot final, reporte escrito. Falta
  probarlo contra el endpoint real, que puede diferir del stub.
- `--mock` sobre los 4 brazos en sitios reales → los 4 completan sin error. Payload por
  turno en GitHub (chars de texto / bytes de imagen base64):

  | brazo | turno 1 | turno 2 | turno 3 |
  |---|---|---|---|
  | `oracle` | 25.363 / 0 | 12.271 / 0 | 3.359 / 0 |
  | `pixels` | 851 / 86.012 | 920 / 62.304 | 966 / 80.104 |
  | `hybrid` | 25.588 / 86.016 | 12.496 / 62.172 | 3.584 / 62.172 |
  | `snap` | 25.588 / 325.848 | 10.304 / 369.644 | 3.584 / 369.644 |

  Se ve el comportamiento esperado del oráculo: el turno 1 paga el outline completo y los
  siguientes son diffs (25K → 3,4K chars), mientras `pixels` paga una imagen entera en
  cada turno. Ojo con `snap`: el PNG de snapdom pesa ~4× el JPEG del screenshot nativo en
  bytes (el costo en tokens depende de las dimensiones, no de los bytes, pero el tiempo de
  subida no).

**Lo que falta**: la corrida paga. Nadie midió todavía aciertos con estos brazos; las
únicas filas con resultados en `RESULTS.md` son las de ellos.

## Costo

Del `--dry` del 2026-08-01 (payload real medido por sitio, cota superior asumiendo que
ninguna tarea termina antes de los 50 pasos, 3 intentos, 25 tasks):

| brazo | payload 1er turno (mediana) | peor caso USD |
|---|---|---|
| `pixels` | 1.365 tok (imagen 1280×800) | $30,5 |
| `oracle` | ~6.200 tok | $36,5 |
| `hybrid` | ~7.500 tok | $56,8 |

La cota es deliberadamente pesimista para el oráculo: asume que cada paso vuelve a
costar un tercio del primer turno, cuando en la práctica los turnos siguientes son solo
el diff (p50 medido en `../results/sweep*.json`: decenas de tokens). El costo real
esperado es una fracción de esto porque las tareas terminan mucho antes de 50 pasos.

## Archivos

- `dataset.mjs` — carga, adaptación de fechas, muestreo semilla-42, y el self-check de
  que nuestros 25 ids son los suyos.
- `judge.mjs` — el juez de ellos (gemini-2.5-flash), con fallback Anthropic declarado.
- `run.mjs` — el loop, los 4 brazos, trials, reporte incremental (se guarda tras cada
  task: matar la corrida no pierde lo hecho).
- `report.mjs` — tabla comparativa + matriz por task.
- `data/` — dataset WebVoyager vendorizado (Apache-2.0, ver `data/NOTICE`).
- `baselines/` — los JSON publicados por lumen para lumen / stagehand / browser-use.
- `results/` — lo nuestro (`dry.json` y `webvoyager-<brazo>-<modelo>-<ts>.json`).

NOT FOR PUBLICATION — parte del workspace privado `packages/agent`.
