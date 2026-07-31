/**
 * install-global.mjs — instala el harness del oráculo como herramienta GLOBAL de la
 * máquina (~/.claude/snapdom-agent), independiente de en qué rama esté el repo:
 *
 *   node packages/agent/tools/install-global.mjs      # correr desde agent-lab
 *
 * Escribe:
 *   ~/.claude/snapdom-agent/browse.mjs   copia del CLI/daemon
 *   ~/.claude/snapdom-agent/sdk.js       bundle prebuild del oráculo + snapdom + plugins
 *   ~/.claude/snapdom-agent/paths.json   ruta al repo (para node_modules/playwright)
 *   ~/.claude/skills/agent-browse/       skill a nivel USUARIO (todas las sesiones)
 *
 * Re-correr después de cambiar packages/agent/src o browse.mjs para refrescar.
 * NADA se publica: todo queda en ~/.claude de esta máquina.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const HOME = process.env.HOME
const DEST = join(HOME, '.claude', 'snapdom-agent')
const SKILLDIR = join(HOME, '.claude', 'skills', 'agent-browse')

const esbuild = await import(join(REPO, 'node_modules/esbuild/lib/main.js'))
const SDK = (await esbuild.build({
  stdin: {
    contents: `import { observe, buildUi, agentOracle } from '${join(REPO, 'packages/agent/src/plugin.js')}'
import { snapdom } from '${join(REPO, 'src/api/snapdom.js')}'
import { videoExport } from '${join(REPO, 'packages/plugins/video-export.js')}'
import { gifExport } from '${join(REPO, 'packages/plugins/gif-export.js')}'
window.__agentObserve = observe
window.__agentBuildUi = buildUi
window.__agentOracle = agentOracle
window.__snapdom = snapdom
window.__snapdomVideo = videoExport
window.__snapdomGif = gifExport
`,
    resolveDir: REPO, loader: 'js',
  },
  bundle: true, minify: true, format: 'iife', write: false, platform: 'browser',
  alias: { '@zumer/snapdom': join(REPO, 'src/api/snapdom.js') },
})).outputFiles[0].text

await mkdir(DEST, { recursive: true })
await mkdir(join(DEST, 'logs'), { recursive: true })
await writeFile(join(DEST, 'sdk.js'), SDK)
await copyFile(join(HERE, 'browse.mjs'), join(DEST, 'browse.mjs'))
await writeFile(join(DEST, 'paths.json'), JSON.stringify({ repo: REPO }))

// Skill a nivel usuario: la del repo, con las rutas del harness global.
const skill = await readFile(join(REPO, '.claude', 'skills', 'agent-browse', 'SKILL.md'), 'utf8')
await mkdir(SKILLDIR, { recursive: true })
await writeFile(join(SKILLDIR, 'SKILL.md'),
  skill.replaceAll('packages/agent/tools/browse.mjs', join(DEST, 'browse.mjs'))
    .replace('# agent-browse — navegar con el oráculo en vez de screenshots',
      `# agent-browse — navegar con el oráculo en vez de screenshots\n\n> Instalación GLOBAL de esta máquina (~/.claude/snapdom-agent). Para refrescarla tras\n> cambios en agent-lab: \`node ${join(REPO, 'packages/agent/tools/install-global.mjs')}\``))

console.log(`instalado:\n  ${join(DEST, 'browse.mjs')} (+ sdk.js ${Math.round(SDK.length / 1024)}KB, paths.json, logs/)\n  ${join(SKILLDIR, 'SKILL.md')} (skill global de usuario)`)
