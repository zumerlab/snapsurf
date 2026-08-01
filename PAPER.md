# snapDOM Agent: una forma fiable de comprobar qué cambió en una página web

Borrador reescrito · 2026-08-01 · rama privada `agent-lab`

## Resumen

Un agente web necesita saber dos cosas después de hacer clic, escribir o navegar:
qué cambió en la página y si su acción realmente funcionó. Una captura de pantalla puede
mostrar que algo se movió, pero no siempre distingue un cambio importante de una
animación, un reloj o un carrusel. Un árbol de accesibilidad describe controles y textos,
pero no explica bien cambios visuales ni si un elemento quedó tapado por otro.

snapDOM Agent añade a snapDOM una observación semántica del DOM ya renderizado. Antes de
una acción guarda un punto de referencia; después compara la nueva observación
con la anterior y devuelve cambios como `added`, `removed`, `content`, `state`, `style`,
`moved` o `resized`. También indica qué elemento cambió, cómo fue reconocido y si un
control quedó visible o cubierto.

La propuesta no es sustituir las capturas de pantalla. Es ofrecer una capa de
verificación para que un agente no confunda ruido visual con una acción exitosa. En un
corpus determinista de 19 casos, el oráculo resolvió correctamente los 19, sin falsos
positivos en los 8 casos de ruido ni cambios perdidos en los 11 casos reales. En un
benchmark formal de 120 ejecuciones, los cuatro métodos comparados completaron 119; la
única ejecución no completada fue declarada como fallo por el propio agente, por lo que
no hubo falsos positivos de éxito.

Este trabajo separa con cuidado tres preguntas: si la representación es correcta, si
ayuda a un agente a completar tareas y si permite verificar que una acción tuvo efecto.
Los resultados son prometedores, pero el número de tareas y sitios todavía es pequeño y
las comparaciones de tiempo no son perfectamente simétricas.

## 1. El problema

Los agentes que usan páginas web suelen observarlas mediante imágenes, árboles de
accesibilidad o una combinación de ambos. Esos canales son útiles, pero dejan tres huecos.

Primero, una imagen responde bien a “¿cómo se ve?”, pero no siempre a “¿qué cambió?”. Un
botón puede pasar de deshabilitado a habilitado sin cambiar de aspecto. A la inversa, un
reloj puede cambiar muchos píxeles aunque la aplicación siga exactamente en el mismo
estado.

Segundo, el árbol de accesibilidad describe la estructura semántica, pero no contiene
toda la información visual. Por ejemplo, puede no detectar que una fuente terminó de
cargar o que un cuadro de diálogo está tapando un botón.

Tercero, muchos agentes continúan trabajando después de una acción sin comprobar su
efecto. Si el clic no hizo nada y la página tenía movimiento de fondo, el agente puede
creer que avanzó. En este documento llamamos **falso positivo de éxito** —o
*false green*— a esa situación: el agente dice que la acción funcionó, pero un juez
independiente comprueba que no ocurrió el efecto esperado.

## 2. Qué hace snapDOM Agent

snapDOM Agent es un plugin privado de snapDOM. Se ejecuta dentro de la página, por lo que
no necesita Chrome DevTools Protocol (CDP) ni lanzar otro navegador. Esto permite usarlo
en extensiones Manifest V3, copilotos integrados en aplicaciones y webviews de Electron.

El flujo es sencillo:

1. El agente observa la página y guarda un `checkpoint`.
2. El agente realiza una acción.
3. El plugin vuelve a observar la página.
4. Compara ambas observaciones y devuelve una explicación estructurada.

Una respuesta típica puede decir: “el botón Guardar pasó de deshabilitado a habilitado”
o “el botón Comprar quedó cubierto por el diálogo de cookies”. Si nada relevante cambió,
devuelve `changed: false`, aunque un reloj o una animación hayan seguido moviéndose.

La herramienta ofrece cuatro piezas de información:

- un mapa de los elementos con los que se puede interactuar, con rol, nombre y posición;
- un resumen jerárquico de la página preparado para un modelo;
- un checkpoint sin imagen ni DOM serializado para comparar observaciones;
- un diff semántico que explica los cambios y sus consecuencias para la interacción.

La imagen sigue estando disponible cuando hace falta comprobar apariencia o diseño. La
semántica y los píxeles se obtienen como parte de la misma captura de snapDOM. En páginas
grandes, el recorrido puede dividirse en intervalos cortos para no bloquear la interfaz;
si la página cambia mientras el recorrido está pausado, la observación se marca como
`torn` en vez de presentarse como una captura perfectamente atómica.

## 3. Cómo representa una página

### 3.1 Identidad de los elementos

Comparar dos DOM no consiste en comparar posiciones. Un framework puede destruir y crear
de nuevo un nodo aunque, para la persona usuaria, siga siendo el mismo botón. También
puede reciclar una fila visual para mostrar otro dato.

El comparador combina varias señales: `data-testid`, rol accesible, nombre accesible,
ruta semántica, orden entre hermanos, texto y contexto de los antepasados. No expone una
probabilidad difícil de interpretar. Clasifica cada coincidencia como `exact`, `strong`,
`ambiguous`, `new` o `removed`.

Cuando la posición y el texto se contradicen, el sistema no afirma que conoce la
identidad. Devuelve `possible-replacement`. Esta decisión es importante en listas
reordenadas y virtualizadas: es preferible declarar una duda que inventar un cambio de
contenido.

### 3.2 Tres firmas distintas

Cada nodo mantiene tres tipos de firma:

- **contenido**: etiqueta, rol, texto propio, estado interactivo y un subconjunto de
  estilos visuales;
- **subárbol**: una firma Merkle que resume el nodo y sus descendientes;
- **geometría**: posición y tamaño relativos al contenedor más cercano que posiciona o
  desplaza contenido.

La geometría se mantiene separada. Así, mover un botón no se confunde con cambiar su
texto o su estado, y el movimiento de un hijo no se propaga como si todo el árbol hubiera
cambiado.

### 3.3 Estado, privacidad y límites

El sistema detecta estados como `disabled`, `checked`, `expanded`, `pressed`, `selected`
y `open`. Los valores de campos se firman para poder detectar una edición, pero el
checkpoint solo guarda una máscara. Contraseñas, correos, teléfonos, códigos de un solo
uso y tarjetas reciben tratamiento sensible.

También se pueden definir reglas de redacción. La búsqueda no permite usar esas reglas
como un canal lateral para confirmar si existe un texto oculto. Las capturas de pantalla,
sin embargo, son píxeles y no quedan protegidas por la redacción semántica.

Canvas se declara como contenido visible pero sin semántica disponible. Los
iframes inaccesibles también se marcan como no observables. La herramienta no pretende
entender información que solo existe en píxeles.

## 4. Cómo se evaluó

La evaluación tiene tres capas para no mezclar la calidad de la herramienta con la del
modelo que la usa.

### Capa 1: calidad de la representación

No participa ningún modelo. Cada caso tiene un resultado correcto escrito a mano. Esto
permite medir detección, falsos positivos y cambios perdidos de forma determinista.

### Capa 2: agente dentro del ciclo

Un agente resuelve tareas reales con distintos canales de percepción. Se miden tareas
completadas, acciones, tiempo y, cuando la interfaz lo expone, tokens. Esta capa evalúa el
sistema completo, por lo que sus resultados dependen del modelo, el prompt y el entorno.

### Capa 3: verificación

Se compara lo que el agente cree que ocurrió con un juez independiente. El juez nunca
usa el propio resultado de snapDOM Agent como verdad. Emplea APIs públicas, constantes
conocidas, patrones de URL o el estado real de una aplicación de prueba.

Esta separación evita un razonamiento circular: la herramienta evaluada no decide si
ella misma acertó.

## 5. Resultados

### 5.1 Detección de cambios

El corpus contiene 19 casos: 11 cambios reales y 8 casos de ruido. Entre los cambios
reales hay texto actualizado, un botón habilitado, nodos reemplazados, listas reordenadas
y contenido en Shadow DOM. El ruido incluye un reloj, scroll, hover residual, una
animación CSS, regeneración de CSS-in-JS y cambios de píxeles en canvas.

| Método | Casos correctos | Falsos positivos en 8 casos de ruido | Cambios perdidos en 11 casos reales |
|---|---:|---:|---:|
| **snapDOM Agent** | **19/19** | **0** | **0** |
| Diferencia perceptual de píxeles | 13/19 | 5 | 1 |
| Diferencia de árbol de accesibilidad | 16/19 | 2 | 1 |

La diferencia de píxeles perdió un cambio de `disabled` sin diferencia visual. El árbol
de accesibilidad perdió, entre otros, un cambio tardío de fuente que sí alteró el render.
Estos resultados están en `experiment/results/bench-qa.json` y
`experiment/results/bench-qa.md`.

### 5.2 Cantidad de información

En un barrido de 36 sitios, el diff incremental tuvo una mediana de 19 tokens (en los
sitios sin ruido en reposo; 36 tokens tomando los 36) frente a
unos 1.365 tokens por captura de pantalla: aproximadamente 70 veces menos. Esta ventaja
solo corresponde al diff después de una observación inicial.

El primer mapa completo puede ser caro. En 30 de los 36 sitios, el outline inicial era
más costoso que una captura. El digest compacto redujo un caso de Wikipedia de 12,4 KB a
3,4 KB, pero la conclusión no cambia: la principal ventaja está en comunicar cambios
pequeños, no en describir por primera vez una página enorme.

### 5.3 Ruido en sitios reales

En reposo, 18 de 36 sitios no produjeron cambios. Los otros 18 contenían movimiento real,
como carruseles o marquesinas. Las animaciones CSS conocidas se ignoran automáticamente,
incluso cuando un contenedor animado mueve a sus descendientes. El movimiento generado
por JavaScript o una página que todavía está cargando contenido puede requerir limitar la
observación a una región o configurar una regla de ruido.

Por tanto, `changed: false` es fiable bajo las reglas observadas, pero no debe
interpretarse como una garantía universal para cualquier página sin estabilización.

### 5.4 Rendimiento

El recorrido escala aproximadamente de forma lineal con el número de nodos, con valores
medidos de 24 a 46 microsegundos por nodo en páginas sintéticas de 282 a 14.000 nodos. En
una página de unos 13.000 nodos, el trabajo total fue cercano a 1,1 segundos. Al dividir
el recorrido en intervalos con un presupuesto de 40 ms, el bloqueo máximo observado del
hilo principal quedó entre 42 y 69 ms.

El costo sigue siendo relevante en documentos muy grandes. La solución práctica es
observar una región cuando el agente ya conoce dónde está trabajando. Además, el
checkpoint completo no siempre es pequeño: en una medición anterior, el de Wikipedia
llegó a ser mayor que el DOM serializado. El diff incremental sí permaneció pequeño.

### 5.5 Despliegue sin CDP

La prueba de una extensión Manifest V3 funcionó en tres de tres sitios bajo CSP real,
incluido GitHub. La companion pasó 27 de 27 comprobaciones de contrato, presupuesto de
bloqueo, oclusión, ausencia de cambio y navegación SPA.

Este punto define el nicho del proyecto: dentro de una extensión o aplicación embebida,
Playwright y CDP pueden no estar disponibles, mientras que un script en el contexto
aislado de la extensión sí puede observar la página.

### 5.6 Piloto con un modelo

Un piloto de diez tareas comparó cuatro formas de percibir la página con el mismo modelo.
Fue una sola repetición por combinación, así que sirve para descubrir patrones, no para
establecer una ventaja estadística.

| Canal de percepción | Éxito | Pasos medios |
|---|---:|---:|
| Captura nativa | 9/10 | 3,4 |
| Oráculo semántico | 8/10 | 3,3 |
| Captura nativa + oráculo | **10/10** | 3,1 |
| Captura de snapDOM + oráculo | **10/10** | **2,9** |

El oráculo solo perdió información visual en una tarea. La combinación con imagen
resolvió las diez. El resultado apoya un diseño híbrido: semántica para localizar y
verificar; píxeles para apariencia y casos no observables.

### 5.7 Benchmark formal

El benchmark formal usó cuatro brazos, diez tareas y tres repeticiones por brazo. Las
tareas incluyeron extracción de datos, navegación profunda, búsqueda, formularios y una
acción que deliberadamente no cambia el estado. Cada tarea tuvo un máximo de 15 acciones.

| Brazo | Resultado por repetición | Falsos positivos de éxito | Acciones medianas por tarea | Tiempo p50 | Tiempo p95 |
|---|---|---:|---:|---:|---:|
| Claude + snapDOM Agent | 10/10 · 10/10 · 10/10 | 0 | 5 | 7,0 s | 29 s |
| Codex + snapDOM Agent | 10/10 · 10/10 · 10/10 | 0 | 6 | 8,0 s | 25 s |
| Claude + extensión nativa | 10/10 · 10/10 · 10/10 | 0 | 3 | 22 s | 84 s |
| Codex + herramientas nativas | 10/10 · 9/10 · 10/10 | 0 | 2 | 4,4 s | 61 s |

En total, el juez externo aprobó 119 de 120 ejecuciones. La ejecución restante fue un
DNF: eBay devolvió HTTP 403 tanto a `curl` como a Playwright. El agente indicó que no
había completado la tarea, por lo que no fue un falso positivo de éxito.

Los tiempos necesitan contexto. Codex nativo midió principalmente la ejecución del
navegador y no todas las pausas de razonamiento; los brazos de Claude incluyeron más del
tiempo completo del runner. Además, una ejecución de script de Codex contó como una
acción aunque contuviera varias operaciones, mientras que la extensión de Claude tendía
a realizar una operación por turno. Por eso estos datos describen las interfaces tal
como se usaron, pero no son una comparación controlada de velocidad pura.

Los modos de fallo fueron distintos. Codex nativo perdió tiempo con selectores CSS que
ya no existían. La extensión de Claude superó el límite de contexto al buscar un enlace
muy profundo en Wikipedia y tuvo clics sintéticos sin efecto. Los brazos con snapDOM
Agent buscaron dentro de la página en milisegundos y actuaron mediante identificadores
que repiten el rol y el nombre del objetivo.

### 5.8 Comprobación de acciones

La aplicación `demo-qa` contiene un reloj y un spinner que generan ruido visual. Al
añadir “Buy milk”, el oráculo detectó el elemento añadido y las tres comprobaciones
pasaron. Al pulsar un botón que no modifica el estado, devolvió `changed: false` aunque
el método de píxeles encontró 264 píxeles distintos. La evidencia semántica de esa
ausencia de cambio ocupó 61 bytes.

En uso real también se registraron un comentario borrado en Reddit y tres acciones sin
efecto en La Nación que el canal visual parecía confirmar. Estos casos no son un
benchmark controlado, pero explican por qué la verificación debe ser una capacidad de
primer nivel.

## 6. Robustez cuando el agente se equivoca

Los modelos cometen errores al usar herramientas: escriben mal una especificación,
reutilizan un identificador antiguo, buscan un texto inexistente o intentan verificar sin
crear antes una referencia válida.

El contrato de snapDOM Agent intenta fallar de forma visible. Un objetivo ambiguo o
ausente no produce una confirmación verde. Antes de actuar, la herramienta repite el rol
y el nombre del elemento resuelto. Si está fuera de pantalla o tapado, rechaza o explica
la acción. En las pruebas de mal uso observadas no apareció ningún falso positivo, y la
recuperación típica necesitó una o dos llamadas adicionales.

Queda un riesgo: un identificador antiguo usado en otra sesión podría coincidir con otro
elemento. La repetición del rol y el nombre reduce ese riesgo, pero no constituye una
garantía criptográfica de identidad.

## 7. Qué se puede concluir

Los resultados respaldan tres conclusiones.

1. Un diff semántico puede distinguir mejor que los baselines probados entre cambios de
   aplicación y ruido visual en un corpus controlado.
2. La combinación de imagen y semántica es más completa que cualquiera de los dos canales
   por separado: los píxeles explican apariencia; la estructura explica identidad,
   estado y posibilidad de interacción.
3. La contribución más útil es verificar acciones. Saber que un clic no hizo nada evita
   que el agente siga trabajando sobre una suposición falsa.

No se puede concluir todavía que snapDOM Agent sea universalmente más rápido, más barato
o más preciso que cualquier sistema nativo. Las muestras son pequeñas, los sitios reales
cambian y los runners tienen capacidades y formas de contabilizar acciones distintas.

## 8. Amenazas a la validez y trabajo pendiente

- El corpus determinista fue creado por el mismo equipo que construyó la herramienta.
  Las respuestas esperadas están publicadas por caso y los baselines usan
  implementaciones estándar, pero falta un corpus independiente más grande.
- El piloto con modelo tiene una sola repetición por celda.
- El benchmark formal tiene tres repeticiones y diez tareas. Es suficiente para detectar
  fallos cualitativos, no para afirmar superioridad general.
- Los sitios reales no son estacionarios. Contenido, bloqueos, experimentos A/B y
  protecciones anti-bot cambian entre ejecuciones.
- Los tiempos de los cuatro brazos no incluyen exactamente los mismos componentes.
- El texto completo de una página grande puede superar el costo de una imagen. Hay que
  usar digest, búsqueda y observaciones por región.
- Las animaciones controladas por JavaScript y el contenido que sigue cargando pueden
  producir cambios legítimos pero irrelevantes para la tarea.
- Canvas e iframes inaccesibles necesitan una escalada visual o una integración
  específica.
- La repetibilidad solo se afirma dentro del mismo entorno; no entre navegadores,
  motores o configuraciones distintas.

El siguiente paso útil es repetir la evaluación con tareas creadas por terceros,
interfaces de tiempo más comparables y un conjunto explícito de errores de uso. También
conviene medir por separado el costo por tarea completada **y verificada**, no solo el
porcentaje de tareas completadas.

## Apéndice A. Reproducción

Los datos están versionados dentro de `packages/agent/experiment/results/` y los
resultados del benchmark formal en `packages/agent/experiment/formal/results/`.

| Evaluación | Comando desde la raíz del repositorio | Resultado esperado |
|---|---|---|
| Detección de cambios | `node packages/agent/experiment/bench-qa.mjs` | 19/19; 0 falsos positivos; 0 cambios perdidos |
| Companion | `node packages/agent/companion/gate.mjs` | 27/27 |
| Escalado | `node packages/agent/experiment/scaling.mjs` | costo aproximadamente lineal por nodo |
| Barrido de sitios | `node packages/agent/experiment/sweep.mjs` | 18/35 sin ruido en reposo |
| Demo de verificación | `node packages/agent/demo-qa/run-demo.mjs` | cambio real detectado; no-op como `changed:false` |
| Juez formal | `node packages/agent/experiment/formal/judge.mjs <archivo.json>` | veredicto y falsos positivos por entrada |
| Resumen formal | `node packages/agent/experiment/formal/report.mjs` | tablas agregadas por brazo y tarea |

## Apéndice B. Artefactos principales

- `src/`: implementación del snapshot, identidad, matching, diff, queries, privacidad y
  plugin.
- `test/`: pruebas de API, corpus, integración, rendimiento y privacidad.
- `corpus/`: páginas, mutaciones y resultados correctos escritos a mano.
- `experiment/`: runners, puntuación, tareas y comparaciones.
- `docs/adr/`: decisiones de arquitectura y correcciones realizadas a partir de las
  pruebas.
- `FIELD.md` y `EXPERIMENT.md`: notas completas de campo y evolución experimental.
