# Codex self-navigation v2: segunda ronda de SnapDOM Agent

Fecha: 2026-07-30  
Viewport: 1280×800, Chromium headless  
Comparación: sólo se repitió Agent; los números v1 vienen de
`results/codex-self.md`.

Conté cada comando operativo, incluidos los comandos fallidos. `open` ya entrega
la primera observación; después de acciones que cambian estado ejecuté `look`.
Respeté la caducidad de ids: ningún id atravesó un `look`; para objetivos fuera
del mapa hice `find` inmediatamente antes del click. No necesité imágenes porque
ninguna decisión quedó visualmente ambigua.

## Comparación v1 vs v2

| Tarea | Éxito v1 | Acciones v1 | Éxito v2 | Acciones v2 | Cambio |
|---|---:|---:|---:|---:|---:|
| T1 Hacker News | sí | 8 | sí | 4 | -4 |
| T2 GitHub issues | sí | 3 | sí | 3 | 0 |
| T3 eBay | sí | 10 | sí | 11 | +1 |
| T4 npm/preact | sí | 3 | sí | 3 | 0 |
| T5 Wikipedia | sí | 4 | sí | 4 | 0 |
| **Total** | **5/5** | **28** | **5/5** | **25** | **-3** |

El total v2 incluye un `look` fallido y su reintento en T3. Sin esa carrera habría
sido 24 comandos. Las dos rondas Agent usaron cero imágenes.

## Resultados y fricciones

### T1 — Hacker News

Resultado actual: **“Gemini Robotics 2 brings whole body intelligence to
robots”**, 382 comentarios, URL final `item?id=49111237`.

V2 necesitó `open → find "382 comments" → click → look`. El click imprimió:

```text
click ... sobre link "382 comments"
```

Eso corrige exactamente el fallo de v1: un id mal copiado ya no sería silencioso.
La confirmación llega en el resultado del comando, después de ejecutar el click,
pero al menos deja inequívoco qué resolvió el harness. T1 bajó de 8 a 4 comandos.
El `look` de una discusión de unos 33.800 px tardó aproximadamente 0,5 s.

### T2 — GitHub issues

Resultado: **0 abiertos, 338 cerrados**. Igual que v1:

```text
find "Open"   → Open0 (0)
find "Closed" → Closed338 (338)
```

Tres comandos en ambas rondas. Walk-only reduce trabajo interno, pero el `open`
total fue ~4,4 s porque incluye un settle fijo de 3,5 s. En páginas pequeñas la
mejora no se siente tanto como sugieren los microbenchmarks.

### T3 — eBay

Resultado: búsqueda `vinyl record`; primer resultado abierto en
`/itm/198526021172`.

La interacción normal fue rápida:

- `look` después del focus: ~0,30 s.
- `look` de resultados, al reintentar: ~0,28 s.
- `look` de la página del producto: ~0,12 s.

Pero el primer `look` inmediatamente posterior a Enter falló:

```text
Error: page.evaluate: TypeError:
Cannot read properties of null (reading 'nodeType')
```

`enter` ya había reportado la URL de resultados. Un segundo `look` recuperó la
sesión. Esto llevó T3 de 10 comandos en v1 a 11 en v2. Parece una carrera de
navegación: el handler intenta observar cuando `document.body` todavía es null.
Es una regresión operativa real aunque el camino feliz sea mucho más rápido.

El click final confirmó el título completo del primer resultado antes de mostrar
la URL `/itm/`, una mejora clara de auditabilidad respecto de v1.

### T4 — npm/preact

Resultado: **27.594.520 weekly downloads**.

Igual que v1:

```text
open → find "Weekly Downloads" → text <id>
```

Tres comandos. `text` sigue siendo la herramienta correcta para números y títulos;
evita usar píxeles o inferir el número desde un accessible name concatenado.

### T5 — Wikipedia

Resultado: navegación por un enlace real desde Argentina hasta
`/wiki/Mar_del_Plata`.

El flujo se mantuvo en cuatro comandos:

```text
open → find "Mar del Plata" → click <id> → look
```

La diferencia fue velocidad:

- v1: `open` fue descrito y medido aproximadamente en **20 s**.
- v2: `open` total tardó **~6,2 s**, incluidos 3,5 s de settle.
- v2: `look` final tardó **~0,5 s**.

La mejora es material. Aun así, el walk recorre 6.609 actionables y conserva la
geometría anómala de ~148.000 px. Ya no se paga además una captura completa, pero
la observación sigue siendo grande y el outline sigue siendo muy ruidoso.

## Rúbrica

### 1. Permission boundaries

Los verbos son una buena base como API explícita:

- Lectura semántica: `open`, `look`, `find`, `text`.
- Mutación: `click`, `type`, `enter`.
- Lectura visual deliberada: `snap`, con `shot` como fallback.

La separación walk/píxeles es especialmente buena: una observación ya no autoriza
implícitamente una captura. `snap <id>` expresa mejor el alcance que una captura
de página completa.

Pero todavía no es una frontera de permisos completa:

- `open` permite navegar a cualquier origen.
- `type` escribe en cualquier elemento que conserve foco; no declara el target.
- `click x,y` evita la confirmación semántica de role/name.
- `text` puede extraer contenido sensible sin una política distinta de `look`.
- Faltan verbos explícitos para `back`, `forward`, `wait`, scroll controlado,
  selección en combobox, clear, teclas generales, pestañas/popups,
  uploads/downloads y cierre de pestaña.
- No hay allowlist por dominio, clasificación de acciones riesgosas, dry-run ni
  confirmación previa para Submit/Buy/Delete/Login.

Conclusión: los verbos hacen visible la intención, pero hoy son comandos, no una
política de autorización. Para ser una API de permisos deberían asociarse a
capabilities concedidas por sesión/origen y distinguir lectura pública, lectura
sensible y mutación irreversible.

### 2. Recovery

El producto genera checkpoints serializables internamente, pero el harness no me
dejó usarlos como puntos de recuperación:

- no existe `checkpoint save <nombre>`;
- no existe `checkpoint list/show/export`;
- no existe `look --from <checkpoint>`;
- no existe `restore <checkpoint>`.

El checkpoint actual sólo vive en `window.__lastCp` y cada `look` lo reemplaza.
Cuando T3 falló, mi único recovery fue repetir `look`. No pude volver al baseline
anterior ni inspeccionar qué checkpoint había quedado vigente.

También hay que separar dos conceptos:

1. Restaurar un checkpoint como baseline de observación/diff.
2. Deshacer efectos reales de clicks, navegación o requests.

El checkpoint semántico sólo puede resolver (1). Para (2) harían falta snapshots
de contexto del navegador, navegación atrás, recarga, estado de storage o una
acción compensatoria específica de la aplicación. El CLI debería evitar llamar
“restore” a algo que sólo cambia el baseline.

### 3. Auditabilidad

La salida humana mejoró: `click` registra coordenadas, role, name y URL resultante.
Con un transcript completo pude reconstruir la intención general de las cinco
tareas.

No alcanza para una auditoría fuerte. Falta un log durable y estructurado con:

- timestamp, session id y número de secuencia;
- comando y argumentos, con texto tipeado redactado o resumido;
- origen/pestaña y URL antes/después;
- generación/epoch del snapshot del que salió el id;
- id, role/name y coordenadas resueltas;
- checkpoint id/hash antes y después;
- duración, éxito/error y stack o código de error;
- navegación/popup disparado por cada acción;
- path y hash de imágenes de `snap`/`shot`;
- política/capability que autorizó la acción.

Los ids se reutilizan visualmente entre páginas (`n_1...`) y caducan sin que el id
codifique su epoch. Eso dificulta correlacionar transcripts. Además, `click`
confirma el objetivo después de actuar; para acciones riesgosas debería existir
`resolve`/`click --dry-run` o una confirmación previa.

### 4. Velocidad percibida vs v1

La mejora es real y grande en páginas extensas:

- Wikipedia `open`: ~20 s → ~6,2 s.
- Looks grandes observados en v2: ~0,12–0,50 s.

En páginas pequeñas, `open` sigue tardando ~4–5,5 s porque el settle fijo de 3,5 s
domina. Por eso T2 y T4 no se sienten cinco veces más rápidas aunque el trabajo
del oracle sí haya bajado.

La experiencia interactiva después de abrir es mucho mejor. El coste restante se
concentra en:

- settle fijo no adaptativo;
- walk completo de documentos enormes;
- output textual de hasta 12 KB aunque el objetivo sea simple;
- carreras de navegación, como la de eBay.

## `snap` y píxeles

No invoqué `snap` en estas cinco repeticiones porque ninguna decisión quedó
visualmente ambigua. Hacerlo sólo para demostrar el comando habría violado el
principio bajo prueba: pagar píxeles únicamente cuando cambian una decisión.

La interfaz es conceptualmente correcta (`snap <id>`), pero hay dos límites
visibles en el propio harness:

- captura `document.body` con `clip: 'viewport'`, no un crop real del elemento;
- el id debe seguir vigente, por lo que un `look` entre `find` y `snap` obliga a
  repetir `find`.

Debe registrar además qué elemento/epoch originó la imagen y el hash del archivo.

## Veredicto actualizado

Sí cambió parcialmente mi veredicto anterior.

Ya no sostengo que el harness sea inviable como observador completo **por pagar
una captura en cada turno**: esa objeción fue corregida. Walk-only convierte los
`look` posteriores en operaciones de subsegundo incluso sobre páginas largas, y
Wikipedia pasó de dolorosa a tolerable.

Pero todavía no lo usaría sin reservas como observador completo de una sesión
larga. Las razones ahora son más precisas:

1. el walk sigue siendo global y produce outputs enormes;
2. `open` conserva un settle fijo y puede tardar más de seis segundos;
3. existe una carrera real después de navegación;
4. los checkpoints no están expuestos para recovery;
5. no hay log estructurado ni epochs de ids;
6. los verbos expresan intención, pero no aplican una política de permisos.

Lo usaría ya como **observador semántico primario para navegación asistida**, con
`snap <id>` como escalamiento visual y con límites por origen/acción alrededor.
No lo presentaría todavía como runtime autónomo recuperable y auditable. La
arquitectura dio un paso importante; el cuello de botella dejó de ser SnapDOM
capturando siempre y pasó a ser disciplina operacional: lifecycle, recovery,
permissions y logging.
