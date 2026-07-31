# Snippet para el Claude de la extensión (panel de claude.ai en Chrome)

Pegar esto en el chat del panel cuando quieras que use la companion (o guardarlo en
claude.ai → Settings → Profile/Preferences como instrucción permanente):

---

En este Chrome está instalada una extensión local llamada "snapDOM Agent Companion"
que inyecta un observador semántico en cada página. Cuando necesites entender una
página o saber qué cambió después de una acción, USALA EN VEZ DE SCREENSHOTS, así:

1. Verificá que está presente (con tu herramienta de ejecutar JavaScript):
   `!!document.querySelector('meta[name="__snapdom_companion"]')`

2. Pedí una observación y esperá la señal de listo (no un sleep fijo):
   ```js
   const obsId = Date.now();
   const ready = new Promise(r => {
     const h = e => { if (e.data && e.data.type === 'SNAPDOM_DIGEST_READY' && e.data.obsId === obsId) { removeEventListener('message', h); r(); } };
     addEventListener('message', h);
     setTimeout(r, 2000); // red de seguridad
   });
   window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId }, '*');
   await ready;
   JSON.parse(document.getElementById('__snapdom_digest').textContent)
   ```
   El JSON ecoa tu `obsId`, así verificás que es TU observación y no una vieja.
   (Se llama obsId a propósito: tu puente censura claves llamadas "token".)

2b. **Para BUSCAR algo puntual en toda la página, usá `match` en vez de agrandar el
   digest** — busca el snapshot completo (no solo el top-N) y devuelve SOLO lo que
   matchea, con texto completo (300 chars), href, selector y section, en ~2 KB:
   ```js
   window.postMessage({ type: 'SNAPDOM_OBSERVE', obsId, match: 'gaucho de las redes' }, '*');
   // → { matches: [{ id, role, text, href, selector, section, bbox, vbox }] }
   ```
   Con `match` no viene digest (es la herramienta para portadas largas donde top:100
   no alcanza y cuesta 38 KB).

3. El JSON trae: `actionables` (total), `digest.marks` (regiones landmark),
   `digest.heads` (títulos), `digest.top` (mejores elementos interactivos con id,
   role, name, `bbox` en coords de página, `vbox` en coords de VIEWPORT, `selector`
   CSS accionable, y si están tapados), y — si ya habías observado antes en esta
   misma página — `changed` + `changes` (QUÉ cambió: added/removed/state/style/moved,
   siempre con nombre o texto del nodo, y su selector) y `actionabilityDelta`.
   Cada entrada de `heads` y `top` trae además `section`: el título del contenedor
   acotado más cercano (heurística — en portadas con bloques mezclados puede agrupar
   de más; confiá en ella para ubicar, verificá si el dato es crítico).
   Cada link de `top` trae también `href` (pathname+query) — con name+href+selector el
   digest alcanza solo para listas de resultados. `section` puede venir ausente en
   listas planas (mejor ausente que equivocada).
   Podés pedir más: `postMessage({type:'SNAPDOM_OBSERVE', top: 60, heads: 40}, '*')`
   (tope 100/60), y `fullUrl: true` si necesitás la URL con query (p. ej. saber qué
   se buscó) — el default viene saneado.

4. Flujo recomendado: observá → actuá usando el `selector` de cada elemento (con tu
   herramienta de click, o `document.querySelector(sel).click()`) → volvé a observar
   y leé `changes` para confirmar el efecto. Eso reemplaza comparar screenshots.
   Para LEER contenido largo (artículos, hilos), tu get_page_text sigue siendo mejor:
   el digest es mapa y cambios, no texto completo.

5. Screenshots solo cuando la duda sea genuinamente visual (color, layout,
   solapamiento). Si no tenés herramienta de JavaScript disponible, avisá y seguí
   con tus herramientas normales.

Nota: los bbox son [x, y, ancho, alto] en coordenadas de página; `vbox` en px CSS del
viewport. El JSON trae `viewport: {width, height, dpr, scrollX, scrollY}` — si tus
screenshots vienen reescalados, tu factor es `anchoDeTuScreenshot / viewport.width`;
multiplicá el centro del vbox por ese factor antes de clickear por coordenadas (o
mejor: usá el `selector`). Los ids (n_xxx) son de la última observación; si observás
de nuevo, se renuevan.
