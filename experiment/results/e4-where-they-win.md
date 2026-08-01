# E4 — Dónde gana agent-browser (auditoría para nuestro backlog)

2026-08-01 · agent-browser 0.33.1 · $0 (todo con la CLI instalada) ·
verificado ejecutando, no leyendo el README.

Un head-to-head donde el rival no gana nada está mal hecho. E1/E2/C midieron dónde
ganamos nosotros; esto mide lo contrario, y sale directo al backlog.

## Lo que ellos tienen y nosotros no

| Capacidad | Ellos | Nosotros |
|---|---|---|
| **Confirmación por categoría de acción** | `--confirm-actions <lista>` → la acción devuelve `confirmation_required` con un id; `confirm <id>` / `deny <id>` la aprueban o rechazan; **auto-deny a los 60 s** | Solo `--readonly` (todo o nada) |
| **Política de acciones declarativa** | `--action-policy <archivo.json>` | No existe |
| **Confirmación interactiva** | `--confirm-interactive`, con **auto-deny si stdin no es TTY** | No existe |
| **Restore de estado con validación** | `--restore [nombre]` (cookies + localStorage), `--restore-save auto\|always\|never`, y **tres validadores del estado restaurado**: `--restore-check-url`, `--restore-check-text`, `--restore-check-fn` | `cp` es checkpoint de observación, **no restore** (decisión, no bug) |
| **Auth vault** | `auth save/login/list`, `--password-stdin`, resolución de credenciales por plugin (`--credential-provider`), override de selectores por login | No existe |
| **Multi-tab** | `tab new\|list\|close\|<n>` | No existe |
| **Sesiones con nombre** | `session`, `session list` | Una sola sesión por daemon |
| **Interceptación de red** | `network route <url> --abort\|--body`, `unroute`, `requests --filter` | Solo bloqueo por allowlist (`--allow`) |
| **Observabilidad** | trace de DevTools, profiler, `console`, `errors`, **dashboard** en `:4848` | JSONL + `prof` por protocolo |
| **Providers remotos** | browserbase, kernel, browseruse, browserless, agentcore, iOS/Safari, + plugins | Solo Chromium local |
| **Emulación** | `viewport`, `device <name>`, `geo`, `offline`, `media dark\|light\|reduced-motion` | No existe |

## Verificado ejecutando

**El gate de confirmación es real, no una promesa del README.** Con
`--confirm-actions click`, el click devuelve:

```
Confirmation required:
  click
  Run: agent-browser confirm r415975
  Or:  agent-browser deny r415975
```

y la acción **no se ejecuta** hasta aprobarla. Es la capa de permisos que nuestro
`--readonly` no puede expresar: nosotros solo sabemos decir "nada de clicks", no
"este click sí, con aprobación".

**Detalle de diseño que vale copiar**: `--allowed-domains` no solo restringe dominios —
además **rechaza CDP, auto-connect, perfiles, replay de estado, providers de página
directa, argumentos de arranque inseguros e iOS/Safari**. O sea: al endurecer, cierran
también las vías de escape. Nuestro `--allow` restringe la red pero no desactiva nada
más; un consumidor podría creerse aislado y no estarlo.

**Confirmación indirecta de E1**: sus refs no sobreviven entre invocaciones —
`click @e1` tras reabrir la página da `Unknown ref: e1`. Lo encontré peleando con
este test, no buscándolo, y refuerza el hallazgo de E1 por una vía independiente.

## Lo que quedó sin resolver

Quise medir si un **typo en la categoría** (`--confirm-actions clik`) desactiva el gate
en silencio — el fallo mudo que nuestro contrato fail-loud persigue. El test resultó
flaky por la volatilidad de sus refs entre invocaciones y **lo dejo sin respuesta** en
vez de reportar un resultado que no sostengo. Vale la pena retomarlo: si un typo abre
el gate sin avisar, es exactamente la clase de bug que a nosotros nos costó una ronda
adversarial entera cerrar.

## Qué de esto va a nuestro backlog, y con qué prioridad

Siguiendo el criterio ya acordado (lo que sirve al caso de uso validado primero):

1. **Confirmación por categoría de acción.** Es lo que más se parece a nuestro encuadre
   (runtime de verificación): un consumidor que corre asserts querrá gatear acciones
   destructivas. Nuestro `--readonly` es demasiado grueso para eso.
2. **Multi-tab.** Aparece en tareas reales (links que abren ventana; lo sufrimos en
   `claude-native` r1) y hoy no tenemos nada.
3. **Emulación de viewport/device.** Barato y necesario para QA responsive, que es la
   playa de desembarco elegida.
4. **Restore con validación** — la parte interesante no es el restore, son los
   `--restore-check-*`: restaurar estado y **verificar que el estado restaurado es el
   correcto** encaja perfecto con nuestra tesis de postcondiciones.
5. Auth vault, providers remotos, dashboard: **diferir**. Son producto-autonomía, no el
   caso de uso validado, y sin consumidor real que los pida no los pagamos.

## Lectura honesta

En superficie de producto **nos ganan cómodo**: permisos, sesiones, tabs, auth,
emulación, red, observabilidad y providers. Lo nuestro es más chico y más nuevo.

La diferencia sigue siendo de naturaleza, no de tamaño: ellos construyeron un **harness
de operación** muy completo; nosotros una **capa de verificación** que ellos no tienen
(Fase C: 0 falsos verdes contra sus 6). Y E5 mostró que las dos cosas conviven en el
mismo browser con un `eval --stdin`. Eso refuerza el encuadre: no competir por
superficie de harness — que es una carrera perdida — sino ser la capa que decide si la
acción funcionó, encima del harness que el equipo ya tenga.
