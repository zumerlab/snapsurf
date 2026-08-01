# E1 — `vercel-labs/agent-browser` como cuarto brazo determinista

2026-08-01 · agent-browser **0.33.1** (`npm install -g agent-browser`) · mismas 19
fixtures con truth escrita a mano que `bench-qa.md` · sin modelo, 100% determinista.

Primera vez que corremos al rival más comparable: hasta ahora solo lo teníamos
fichado a nivel documental en `docs/LANDSCAPE.md`. Leer un README no es medir.

## Resultado

| Brazo | Correctos | Falsos positivos (ruido) | Cambios perdidos |
|---|---:|---:|---:|
| **Oráculo (browser_verify)** | **19/19** | **0/8** | **0/11** |
| agent-browser + normalización sin refs | 17/19 | 1/8 | 1/11 |
| a11y-tree (Playwright) | 16/19 | 2/8 | 1/11 |
| pixel-diff (clase pixelmatch) | 13/19 | 5/8 | 1/11 |
| **agent-browser `diff snapshot` tal cual sale** | **11/19** | **8/8** | 0/11 |

## Los dos números de agent-browser, y por qué son dos

**Tal cual sale (11/19, 8/8 falsos positivos):** sus refs `@eN` **se renumeran en cada
snapshot**, y su `diff` es textual sobre el árbol serializado — así que el ruido de
refs domina todo. Medido de forma aislada: una página **100% estática**, diffeada
contra sí misma, reporta `3 additions, 3 removals`. Consecuencia: **todo caso de
ruido da "cambió"**. Para QA, tal cual sale, no es utilizable.

**Con normalización sin refs (17/19):** borrando ` ref=eN` de ambos lados antes de
comparar —un post-proceso que cualquier consumidor razonable escribiría— pasa a ser
**el mejor competidor del corpus**, por encima del a11y-tree de Playwright y bastante
por encima de pixel-diff. Sus dos errores:

- **`live-timestamp` (falso positivo)**: el reloj cambia el texto, y un diff textual
  no puede saber que eso no es estado de la aplicación. Es exactamente el caso que
  nuestro `rawTextHash` + supresión causal resuelven.
- **`font-swap-late` (perdido)**: una fuente que termina de cargar no tiene
  representación textual en el árbol de accesibilidad. Invisible para ese canal.

### Antes de aceptar el número as-is se agotaron las alternativas

Para no ganar por configurarlo mal (regla del TESTPLAN), se probó:
- flujo in-session sin `-b` → peor (`4 additions, 0 unchanged` en página estática);
- `--compact` → los refs igual se renumeran;
- no existe flag que omita refs del snapshot.

No hay configuración documentada en la que una página estática diffee limpio.

## Lectura honesta

1. **La tesis se sostiene, con margen más chico del que creíamos.** Contra un
   agent-browser bien normalizado la distancia es 19/19 vs 17/19 — no 19/19 vs 13/19
   como contra pixel-diff. La ventaja real está concentrada en dos clases: **ruido
   textual** (relojes, timestamps) y **cambios sin representación textual** (fuentes,
   y por extensión todo lo visual sin semántica).
2. **La hipótesis que llevábamos era parcialmente falsa y hay que corregirla.**
   Suponíamos que un diff de texto del a11y tree perdería el flip de `disabled`.
   **No lo pierde**: `[disabled]` viaja en la serialización, así que lo detecta.
   Lo que sí rompe su diff es la identidad, no la representación del estado.
3. **El problema de identidad que documentábamos es real y medible**: sus refs no
   sobreviven un re-snapshot, y eso convierte cada observación en "todo cambió".
   Nuestros ids derivados de contenido existen precisamente para eso.
4. **Para el pitch**: contra este rival no alcanza con "detectamos más". El argumento
   defendible es *"tu diff necesita que le escribas la normalización, y aun así se
   come los relojes y no ve lo que no tiene texto"*.

## Reproducir

```bash
npm install -g agent-browser
node packages/agent/experiment/e1-agent-browser.mjs
```

Datos crudos por fixture: `results/e1-agent-browser.json`.
