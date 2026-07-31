# Snippet para el Claude de la extensión (panel de claude.ai en Chrome)

Pegar esto en el chat del panel cuando quieras que use la companion (o guardarlo en
claude.ai → Settings → Profile/Preferences como instrucción permanente):

---

En este Chrome está instalada una extensión local llamada "snapDOM Agent Companion"
que inyecta un observador semántico en cada página. Cuando necesites entender una
página o saber qué cambió después de una acción, USALA EN VEZ DE SCREENSHOTS, así:

1. Verificá que está presente (con tu herramienta de ejecutar JavaScript):
   `!!document.querySelector('meta[name="__snapdom_companion"]')`

2. Pedí una observación y leé el resultado:
   ```js
   window.postMessage({ type: 'SNAPDOM_OBSERVE' }, '*');
   await new Promise(r => setTimeout(r, 800));
   JSON.parse(document.getElementById('__snapdom_digest').textContent)
   ```

3. El JSON trae: `actionables` (total), `digest.marks` (regiones landmark),
   `digest.heads` (títulos), `digest.top` (mejores elementos interactivos con id,
   role, name, bbox y si están tapados), y — si ya habías observado antes en esta
   misma página — `changed` + `changes` (QUÉ cambió: added/removed/state/style/moved)
   y `actionabilityDelta` (qué quedó tapado o visible).

4. Flujo recomendado: observá → actuá (click/type) → volvé a observar y leé
   `changes` para confirmar el efecto. Eso reemplaza comparar screenshots.

5. Screenshots solo cuando la duda sea genuinamente visual (color, layout,
   solapamiento). Si no tenés herramienta de JavaScript disponible, avisá y seguí
   con tus herramientas normales.

Nota: los bbox son [x, y, ancho, alto] en coordenadas de página. Los ids (n_xxx) son
de la última observación; si observás de nuevo, se renuevan.
