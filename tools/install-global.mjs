/**
 * install-global.mjs — installs SnapSurf as a MACHINE-GLOBAL tool (~/.snapsurf),
 * independent of which checkout or npm install it came from:
 *
 *   node tools/install-global.mjs
 *
 * Writes:
 *   ~/.snapsurf/browse.mjs        copy of the CLI/daemon
 *   ~/.snapsurf/server.mjs        copy of the MCP server (for Claude Code/Desktop)
 *   ~/.snapsurf/sdk.js            prebuilt in-page bundle (SnapSurf + snapDOM + plugins)
 *   ~/.snapsurf/companion/        the Chrome extension, loadable from here
 *   ~/.snapsurf/paths.json        self-contained installed runtime path and version
 *   ~/.claude/skills/snapsurf/    USER-level Claude Code skill (every session)
 *
 * Everything a consumer points at lives under a fixed path, so checking out another
 * branch cannot break a registered MCP server or an extension Chrome loaded unpacked.
 * Runtime dependencies are resolved during installation and copied into that tree.
 *
 * Re-run after changing src or browse.mjs to refresh.
 * NOTHING is published: everything stays on this machine.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, copyFile, readdir, access, cp } from 'node:fs/promises'
import { engineSourceHash, sha256 } from './runtime-identity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.SNAPSURF_INSTALL_HOME || process.env.SNAPDOM_AGENT_INSTALL_HOME || process.env.HOME
if (!HOME) throw new Error('HOME (or SNAPSURF_INSTALL_HOME for an isolated install) is required')
const DEST = join(HOME, '.snapsurf')
const SKILLDIR = join(HOME, '.claude', 'skills', 'snapsurf')

const exists = async (p) => { try { await access(p); return true } catch { return false } }

const AGENT = join(HERE, '..')
const STANDALONE = await exists(join(AGENT, 'src', 'plugin.js'))
if (!STANDALONE) {
  console.error(`⛔ standalone agent sources not found under ${AGENT}`)
  process.exit(2)
}

// Same bundle definition the daemon builds in dev mode — one source, no drift.
const { buildSdk } = await import(join(HERE, 'sdk-bundle.mjs'))
const SDK = await buildSdk(AGENT)

// Copying a file that does not parse is silent until the client fails to start: this
// installer shipped a broken server.mjs once, because it validates the SDK bundle's
// globals but never checked the sources it copies. Parse them first.
const { execFileSync } = await import('node:child_process')
for (const f of [join(HERE, 'browse.mjs'), join(HERE, 'runtime-identity.mjs'), join(HERE, '..', 'mcp', 'server.mjs')]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) {
    console.error(`⛔ ${f} does not parse — refusing to install:\n${(e.stderr || '').toString().split('\n').slice(0, 3).join('\n')}`)
    process.exit(2)
  }
}

await mkdir(DEST, { recursive: true })
await mkdir(join(DEST, 'logs'), { recursive: true })
await copyFile(join(AGENT, 'LICENSE'), join(DEST, 'LICENSE'))
await copyFile(join(AGENT, 'vendor', 'snapdom', 'LICENSE'), join(DEST, 'SNAPDOM-LICENSE'))
await writeFile(join(DEST, 'sdk.js'), SDK)
await copyFile(join(HERE, 'browse.mjs'), join(DEST, 'browse.mjs'))
await copyFile(join(HERE, 'runtime-identity.mjs'), join(DEST, 'runtime-identity.mjs'))
// The installed daemon must survive the checkout moving or disappearing. It only needs
// Playwright at runtime because sdk.js is already built; copy the pinned runtime instead
// of pointing back at the repository's node_modules. Resolve from this module rather
// than assuming dependencies are nested under AGENT/node_modules: npm normally hoists
// them when this installer itself is running from an installed tarball.
await mkdir(join(DEST, 'node_modules'), { recursive: true })
for (const [dep, required] of [['playwright', true], ['playwright-core', true], ['fsevents', false]]) {
  let source
  try {
    source = dirname(fileURLToPath(import.meta.resolve(`${dep}/package.json`)))
  } catch (error) {
    if (required) throw new Error(`required runtime dependency ${dep} could not be resolved`, { cause: error })
    continue
  }
  await cp(source, join(DEST, 'node_modules', dep), { recursive: true, force: true })
}
const { version } = JSON.parse(await readFile(join(AGENT, 'package.json'), 'utf8'))
await writeFile(join(DEST, 'paths.json'), JSON.stringify({ agent: DEST, version, engineSourceHash: await engineSourceHash(AGENT), sdkHash: sha256(SDK) }))

// The MCP server, so Claude Code and Claude Desktop can be registered against a path
// that does not disappear when the repo changes branch. It finds the daemon by looking
// next to itself, which is exactly where browse.mjs was just copied.
await copyFile(join(HERE, '..', 'mcp', 'server.mjs'), join(DEST, 'server.mjs'))

// The extension, for the same reason: Chrome loads it unpacked from a fixed path and
// disables it if that path goes away.
const COMPANION = join(DEST, 'companion')
await mkdir(COMPANION, { recursive: true })
await copyFile(join(AGENT, 'LICENSE'), join(COMPANION, 'LICENSE'))
await copyFile(join(AGENT, 'vendor', 'snapdom', 'LICENSE'), join(COMPANION, 'SNAPDOM-LICENSE'))
for (const f of await readdir(join(HERE, '..', 'companion'))) {
  if (f === 'content.bundle.js' || f === 'manifest.json' || f === 'worker.js' || f === 'PROMPT-extension.md') {
    await copyFile(join(HERE, '..', 'companion', f), join(COMPANION, f))
  }
}

// User-level skill: the versioned one, with the global harness paths. The rewrites are
// idempotent so re-installing from an already-rewritten copy cannot double the header.
const SKILLSRC = [join(AGENT, 'skill', 'SKILL.md')]
const skillPath = (await Promise.all(SKILLSRC.map(async (p) => (await exists(p)) ? p : null))).find(Boolean)
if (!skillPath) {
  console.error(`⛔ no SKILL.md source found. Tried:\n  ${SKILLSRC.join('\n  ')}`)
  process.exit(2)
}
const HEADING = '# snapsurf — browse by reading semantic diffs instead of screenshots'
const NOTE = `> MACHINE-GLOBAL install (~/.snapsurf). Refresh after source changes:\n> \`node ${join(AGENT, 'tools', 'install-global.mjs')}\``
const skill = (await readFile(skillPath, 'utf8'))
  .replaceAll('$HOME/.snapsurf/browse.mjs', join(DEST, 'browse.mjs'))
  .replaceAll('companion/PROMPT-extension.md', join(COMPANION, 'PROMPT-extension.md'))
  .replace(new RegExp(`${HEADING}\\n\\n> MACHINE-GLOBAL install[\\s\\S]*?\\n\\n`), `${HEADING}\n\n`)
await mkdir(SKILLDIR, { recursive: true })
await writeFile(join(SKILLDIR, 'SKILL.md'), skill.replace(HEADING, `${HEADING}\n\n${NOTE}`))

console.log(`installed:
  ${join(DEST, 'browse.mjs')} (+ sdk.js ${Math.round(SDK.length / 1024)}KB, paths.json, logs/)
  ${join(DEST, 'server.mjs')} (MCP server — register Claude Code/Desktop against THIS path)
  ${COMPANION}/ (Chrome extension — load unpacked from here)
  ${join(SKILLDIR, 'SKILL.md')} (user-level global skill)`)
