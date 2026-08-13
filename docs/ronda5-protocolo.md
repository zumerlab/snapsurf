# Ronda 5 — grilla 2×2: {Claude, Codex} × {snapdom-agent, nativo}

Cuatro brazos, tres tareas congeladas, sitios sin bot-wall (la grilla mide percepción,
no suerte con WAFs). Prompts en `scratchpad/` (se regeneran con este doc como fuente).

## Las tres tareas (idénticas para los cuatro brazos)

- **T-A · Lazy scroll.** Hacker News → https://news.ycombinator.com/news?p=2 (página 2,
  puestos 31–60). Reportar título + puntos + comentarios de los items en los puestos
  **#33, #34, #35**. Estos viven bajo el fold: exige scroll real. (El brazo snapdom
  estrena `browser_scroll`; el nativo usa su scroll propio.)
- **T-B · Negativo fiel.** SauceDemo (standard_user / secret_sauce, login público).
  Resetear estado si el Backpack ya está en el carrito. Agregar **solo** el Sauce Labs
  Backpack. Verificar TRES cosas: (1) su botón pasó a Remove, (2) el badge del carrito
  dice 1, (3) **ningún otro producto cambió**. La clave es (3): cómo se PRUEBA que nada
  más se movió.
- **T-C · Oclusión + estado.** the-internet.herokuapp.com/entry_ad. Con el modal
  presente: probar que el link "click here" NO es clickeable (cubierto). Cerrar el modal
  por su control Close. Probar que "click here" SÍ es clickeable ahora. Reportar la
  evidencia de ambas verificaciones.

## Qué se mide por celda

Cada brazo reporta UNA línea JSON por tarea:
`{"task","stack","answer","evidence","toolCalls","proof":"demostrado|afirmado","frictions"}`

- **proof** es la columna que responde la pregunta de eficacia:
  `demostrado` = transición tipada / negativo fiel / occlusion-fact (el instrumento lo
  emite como dato); `afirmado` = lo miré en pantalla/DOM y lo declaro. Esta distinción,
  no el conteo de llamadas, es el resultado central.

## Ejecución (evita la colisión de sesiones que ya pagamos)

Cada brazo en su sesión aislada del daemon (los brazos snapdom) o su browser propio (los
nativos). El daemon debe estar corriendo con el código actual:

```bash
node tools/browse.mjs serve   # (o dejar el global; ya tiene browser_scroll)
```

Codex (background, uno por archivo):
```bash
codex exec --approve-for-me --skip-git-repo-check "$(cat scratchpad/r5-codex-snapdom.txt)" > scratchpad/r5-codex-snapdom.out 2>&1
codex exec --approve-for-me --skip-git-repo-check "$(cat scratchpad/r5-codex-nativo.txt)" > scratchpad/r5-codex-nativo.out 2>&1
```

Claude (esta sesión, o la próxima): brazo snapdom por MCP/CLI con `--session s_X`;
brazo nativo por el Browser pane. Prompts congelados en `r5-claude-*.txt` como guía.

## Salida

Grilla final 4×3 con proof-column + fricciones nuevas → candidatas al próximo fix.
Balance acumulado de rondas al pie.
