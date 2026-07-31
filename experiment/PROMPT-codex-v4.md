# Prompt para Codex — ronda 4: DURACIONES (copiar y pegar)

Cuarta ronda, foco único: **tiempos**. Tus hallazgos de v3 ya están aplicados en el
harness (mismo día): las denegaciones ya loguean `ok:false` (tu bug serio), `find`
loguea los matches completos `{id, role, name, href}` con href pathname-first (no la
cola de tracking), `look`/`open` loguean resumen (mapTotal/changed/#changes), y las
URLs del log van truncadas a origin+pathname. Además el ranking de `find` v2 entierra
los wrappers page-wide que concatenan toda la página. El bug de `snap` con scroll≠0
que validaste de pasada quedó cerrado en el core con test de regresión.

Tu misión: repetir las MISMAS 5 tareas (mismos criterios, tope 15 acciones) midiendo
duración de forma sistemática, y entregar la tabla de tiempos que le faltó a tus
rondas anteriores.

Metodología de medición (respetala para que sea comparable):

1. **Wall-time por tarea**: cronometrá desde el instante antes del primer comando de
   la tarea hasta el instante después del último (por ejemplo corriendo la cadena
   completa de comandos de la tarea en una sola invocación con `time`, o tomando
   timestamps antes/después). Ejecución pura del harness, sin tu tiempo de
   razonamiento en el medio — si no podés encadenar, anotá los dos números por
   separado (puro vs end-to-end) y decí cuál es cuál.
2. **Por comando**: sacá `durationMs` del JSONL de la sesión
   (`packages/agent/logs/<sesión>.jsonl`) — suma por tarea, y p50/máx de `open`,
   `find`, `look`, `click`.
3. Referencia para que contrastes (mi corrida de hoy, ejecución pura encadenada):
   total 5/5 · 20 comandos · 21,2 s de pared; opens 1,0–5,6 s; finds 1–8 ms;
   looks 94–413 ms; eBay entera 12,1 s. Si tus números difieren mucho, investigá
   por qué (¿comandos de a uno? ¿red? ¿página distinta?) en vez de promediar.

Entregable en `packages/agent/experiment/results/codex-self-v4.md`:

- Tabla por tarea: éxito · acciones · wall-time v4, con tus acciones de v1/v2/v3 al
  lado para historia (tiempos solo v3-aprox vs v4, que es lo que hay).
- Tabla por comando: p50/máx de open/find/look/click/enter, y el desglose completo
  de la tarea más lenta.
- Overhead del CLI: compará la suma de `durationMs` del JSONL contra tu wall-time
  por tarea — la diferencia es el costo de invocación por comando (~70-90 ms/cmd en
  mi corrida). Decí si a tu juicio amerita un modo batch (`browse.mjs run 'open X;
  find Y; click Z'`) o no.
- Spot-check de tus fixes de auditoría (2 minutos): forzá una denegación con un
  daemon `--readonly` y verificá `ok:false` en el JSONL; corré un `find` y verificá
  que los matches quedaron con role/name/href. Reportá si algo sigue mal.
- Fricciones nuevas si aparecen. Sin edulcorar, como siempre.

Notas operativas: daemon con `node packages/agent/tools/browse.mjs serve` en
background; los ids caducan por observación (`obs #N`); `snap`/`shot`/`text`/`find`
no re-observan; nada de clicks por coordenadas para adivinar (parent/map). Al final:
`stop` de todos los daemons que hayas levantado.
