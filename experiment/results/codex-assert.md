# Evaluación de `browser_assert` — F2 consumer validation

Fecha: 2026-07-31. Rama local `agent-lab`. No hice push ni modifiqué el código
del producto.

## Resumen ejecutivo

`browser_assert` ya tiene una interfaz que un runner puede consumir: los PASS y
FAIL llegan como resultados estructurados, no como errores ni como prosa que haya
que interpretar. La idea de una assertion semántica sobre el diff es buena.

Pero la promesa central del demo todavía no resiste CI hostil. La assertion
`changed:false` del botón no-op pasó inmediatamente y falló después de esperar
1,1 segundos: el tick del reloj entró al diff. Además, una assertion fallida
consume el baseline y no devuelve la evidencia completa que la hizo fallar. Hoy
no la pondría en un pipeline desatendido.

## Parte 1 — demo de referencia

Ejecuté `node packages/agent/demo-qa/run-demo.mjs` después de leer su README.

Resultados reproducidos:

| Caso | Resultado |
| --- | --- |
| T1 add-item: `changed + mustInclude + exists` | PASS, 3/3 |
| T2 botón Refresh no-op: `changed:false` | PASS, 1/1 |
| Mismo no-op con pixel diff | FAIL visual: 266 píxeles, 0,08 % |

Después repetí el runner completo cinco veces. T1 y T2 pasaron 5/5. El happy path
inmediato es estable en esta máquina.

### Intentos hostiles contra T2

Corrí una variante temporal por MCP sobre la misma `app.html`, sin modificar la
app ni el producto:

| Escenario | Resultado de `changed:false` |
| --- | --- |
| 1 click, assert inmediato | PASS, actual `false` |
| 1 click, espera de 1.100 ms | **FAIL**, actual `true` |
| 5 clicks no-op, espera de 2.500 ms | **FAIL**, actual `true` |

Esto rompe T2 con una condición normal de CI: que el worker sea pausado o tarde
más de un segundo entre acción y assertion. El README dice que el reloj y spinner
son ruido ambiental que el oracle ignora; en esta prueba, el reloj cruzando un
tick sí convirtió el diff en `changed:true`.

No pude probar resize mediante MCP porque la superficie no expone viewport ni
emulación. Para un producto de QA responsive, esa ausencia importa. Podría haber
redimensionado con Playwright por fuera, pero habría dejado de evaluar
`browser_assert` como lo consumiría un cliente MCP.

### Lifecycle durante el ataque

El server ahora declara ownership del daemon y no dejó procesos huérfanos. En
cada cierre intentó `SIGTERM` y luego recurrió a `SIGKILL`. Es una mejora respecto
de la ronda MCP anterior, aunque el daemon todavía no termina limpiamente dentro
del grace period.

## Parte 2 — mini suite propia

Elegí `https://www.npmjs.com/package/preact`. Todas las operaciones fueron por
MCP. Medí round-trip desde antes de escribir el request al stdin del server hasta
recibir la línea JSON completa, excluyendo mis pausas de razonamiento.

### Cinco assertions requeridas

| Assertion | Cobertura | Resultado | Llamadas | Wall |
| --- | --- | --- | ---: | ---: |
| `exists:"Weekly Downloads"` | existencia | PASS, 2 matches | 2 | 5.780,5 ms |
| `notCovered:"preact"` | elemento no tapado | PASS, clear | 1 | 4,6 ms |
| segundo click sobre search ya enfocado + `changed:false` | negativo fiel tras no-op real | PASS | 7 desde estado frío | 2.630,6 ms |
| cerrar banner + `mustInclude:{kind:"moved", role:"main", name:"preact"}` | efecto semántico kind+name | PASS, 2/2 | 4 | 1.221,7 ms |
| click Homepage + `url:"preactjs.com"` | URL tras navegación | PASS | 3 | 319,1 ms |
| **Total de los cinco casos exitosos** |  | **5/5** | **17** | **9.956,5 ms** |

El primer caso incluye el `browser_open` inicial, que fue un outlier de 5.775 ms.
El negativo fiel desde estado frío incluye abrir la página, enfocar una vez,
consumir ese cambio de foco como baseline, renovar el id, volver a clicar el input
ya enfocado y afirmar `changed:false`. La porción estrictamente no-op fueron tres
llamadas y 422,6 ms.

### El problema detrás del PASS de `mustInclude`

La assertion natural que escribí primero fue:

```json
{
  "changed": true,
  "mustInclude": [
    { "kind": "removed", "role": "button", "name": "Close notification" }
  ]
}
```

Falló:

```text
changed: true      PASS
mustInclude: absent FAIL
```

El banner desapareció, pero el diff priorizó 40 movimientos/resizes causados por
el cambio de layout. `browser_verify` mostró, entre otros, `moved main "preact…"`.
La versión que finalmente pasó fue:

```json
{
  "changed": true,
  "mustInclude": [
    { "kind": "moved", "role": "main", "name": "preact" }
  ]
}
```

Eso satisface técnicamente “kind + name”, pero es una assertion peor: verifica
una consecuencia de layout, no la intención “la notificación fue removida”. Se
acerca otra vez a una assertion visual frágil. Preparar este único caso requirió:

- intento intuitivo fallido: 3 llamadas, 404,1 ms;
- pasada de diagnóstico: 4 llamadas, 1.426,7 ms;
- assertion revisada: 4 llamadas, 1.221,7 ms.

La suite demuestra que el vocabulario existe, pero también que el modelado del
diff decide si el vocabulario es utilizable.

### Negative explícito sobre foco

El primer click sobre el search input produjo `changed:true`; es correcto porque
cambió el foco. Después de consumir ese estado como baseline, renové el id y
volví a clicar el mismo input. El segundo click pasó `changed:false`. Ése sí es un
no-op real, no simplemente “no ejecuté una acción”.

### URL assertion

`browser_find("Homepage")` devolvió el link externo `preactjs.com`, pero su href
estructurado fue sólo `/`, perdiendo el origin. El click sí siguió la pestaña y
`browser_assert({url:"preactjs.com"})` pasó con actual
`https://preactjs.com/`. La assertion funciona; el match previo no describe bien
el destino cross-origin.

## Parte 3 — evaluación

### 1. ¿Alcanza el vocabulario?

Alcanza para demos y smoke tests simples:

- URL contains;
- changed boolean;
- presencia de cambios por kind/role/name;
- existencia textual;
- no cubierto.

No alcanza para la suite de QA que escribiría normalmente. Faltan:

1. `notExists` y conteos tipados (`count`, min/max, exactamente N).
2. Texto exacto, regex y normalización configurable; `exists` hoy es substring.
3. Estado actual de controles: value, checked, selected, disabled, expanded,
   focused y atributos.
4. URL por componentes: origin/host/path/query/hash, exact y regex.
5. Scoping: buscar/assert dentro de una región o target concreto.
6. `mustExclude` o “sólo ocurrieron estos cambios”, para detectar efectos
   secundarios inesperados.
7. Espera/retry/stability window incorporados.
8. Ignorar nodos/atributos dinámicos de forma explícita y auditable.
9. Causalidad: cambios del target/acción separados de mutaciones ambientales.
10. Configuración de viewport/device para QA responsive.

Los puntos 7–9 no son comodidad: el ataque de 1,1 s demuestra que son necesarios
para que `changed:false` sea una garantía.

### 2. ¿`{pass, checks[]}` evita parsear prosa?

Para **ejecutar una assertion ya escrita**, sí. Usé solamente:

```json
{
  "assert": {
    "pass": true,
    "checks": [
      { "type": "url", "expected": "preactjs.com", "actual": "https://preactjs.com/", "pass": true }
    ]
  }
}
```

Un FAIL sigue teniendo `isError:false`, como debe ser. Un runner puede decidir su
exit code sin leer `content[].text`.

Para **diagnosticar o escribir** la assertion, no. El FAIL de `mustInclude`
devolvió solamente `actual:"absent"`; no incluyó los cambios candidatos ni la
evidencia del diff. `browser_verify.structuredContent` tenía `changed:true` y
`changes:40`, pero no el array de cambios. Tuve que leer la prosa para descubrir
`moved main "preact"`.

Recomendaría que cada check incluya evidencia estructurada y que el resultado
superior incluya el diff completo o un `diffId` consultable. Los actuals también
deberían ser tipados: `matchCount:2`, no el string `"2 match(es)"`.

Encontré además un bug al enviar `browser_find` y `browser_act` en pipeline: el
texto de act confirmó el click, pero su `structuredContent` heredó `matches` del
find anterior en lugar de devolver `resolved`. Serializando requests no ocurrió.
MCP admite múltiples requests pendientes; un runner externo puede hacer esto sin
estar violando el protocolo.

### 3. ¿Consumir el baseline es footgun?

Hoy es un footgun.

Me mordió dos veces:

- En HN, un click a `hide` quedó momentáneamente en `/hide?...`; el assert
  inmediato vio `changed:false`, falló y consumió el baseline antes de poder
  observar el redirect esperado.
- En npm, el `mustInclude removed button` falló y consumió la única evidencia del
  acto. Para diagnosticar tuve que recargar, repetir el click y usar verify.

Opciones razonables:

- `consume:false` para peek/assert de diagnóstico;
- consumir sólo al pasar;
- devolver un token de baseline explícito;
- incluir siempre el diff completo en el resultado fallido;
- `browser_assert_retry` que mantenga el baseline original durante la ventana de
  estabilidad.

Avanzar automáticamente puede estar bien en el happy path `act → assert`, pero no
debería destruir la evidencia cuando el test falla. Precisamente en un FAIL es
cuando más se necesita.

### 4. ¿Lo pondría en QA desatendido?

Todavía no. La lista más corta para que cambie mi respuesta es:

1. **Estabilidad temporal:** wait/retry integrado y política explícita para ruido
   ambiental; T2 debe seguir pasando con 0–5 s de scheduling variable.
2. **Evidencia y baseline:** diff estructurado completo en FAIL y control de
   consumo/retry.
3. **Assertions de estado:** exact/notExists/count/value/checked/disabled más
   scoping por target.
4. **Concurrencia MCP:** respuestas estructuradas aisladas por request; test de
   pipelining.
5. **Navegación estructurada:** href cross-origin completo y URL por componentes.

Después añadiría viewport/device y un modo de “no hubo cambios fuera de los
esperados”.

## Veredicto

`browser_assert` es una dirección de producto correcta, no maquillaje sobre el
MCP. Los resultados estructurados, `isError:false` en FAIL y la capacidad de
afirmar un segundo foco no-op son valiosos. También eliminó completamente el
parseo de prosa del camino de ejecución de assertions predefinidas.

Pero el demo sobrevende hoy el negativo fiel: una espera de 1,1 s lo vuelve
flaky por el mismo reloj que afirma ignorar. Y el caso del banner muestra que
`mustInclude` sólo es tan semántico como el diff subyacente; si el evento útil se
pierde detrás de 40 movimientos, el usuario termina afirmando layout.

Lo usaría ya como oracle experimental y para recolectar evidencia comparativa.
No lo usaría aún como reemplazo de assertions visuales en CI sin supervisión.

Al finalizar cerré todos los servers y verifiqué con `pgrep` que no quedaran
procesos `browse.mjs`, `server.mjs` ni relays temporales activos.
