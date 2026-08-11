/**
 * install-global.mjs — installs the oracle harness as a MACHINE-GLOBAL tool
 * (~/.claude/snapdom-agent), independent of which branch the repo sits on:
 *
 *   node tools/install-global.mjs
 *
 * Writes:
 *   ~/.claude/snapdom-agent/browse.mjs   copy of the CLI/daemon
 *   ~/.claude/snapdom-agent/server.mjs   copy of the MCP server (for Claude Code/Desktop)
 *   ~/.claude/snapdom-agent/sdk.js       prebuilt bundle (oracle + snapdom + plugins)
 *   ~/.claude/snapdom-agent/companion/   the Chrome extension, loadable from here
 *   ~/.claude/snapdom-agent/paths.json   repo path (for node_modules/playwright)
 *   ~/.claude/skills/agent-browse/       USER-level skill (every session)
 *
 * Everything a consumer points at lives under ~/.claude, so checking out another branch
 * cannot break a registered MCP server or an extension Chrome loaded unpacked. Only
 * node_modules (playwright, esbuild) is still resolved from the repo via paths.json.
 *
 * Re-run after changing src or browse.mjs to refresh.
 * NOTHING is published: everything stays in this machine's ~/.claude.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, copyFile, readdir, access } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME
const DEST = join(HOME, '.claude', 'snapdom-agent')
const SKILLDIR = join(HOME, '.claude', 'skills', 'agent-browse')

const exists = async (p) => { try { await access(p); return true } catch { return false } }

// Two roots since the subtree split (github.com/zumerlab/snapdom-agent): AGENT holds the
// oracle sources, HOST holds snapdom itself (src/api, packages/plugins) plus the
// node_modules the bundle and the daemon borrow (esbuild, playwright). In the old
// monorepo layout both were the same tree, so keep that path working.
const AGENT = join(HERE, '..')
const STANDALONE = await exists(join(AGENT, 'src', 'plugin.js'))
const { resolveHost } = await import(join(HERE, 'host-repo.mjs'))
const HOST = STANDALONE
  ? (() => { try { return resolveHost() } catch (e) { console.error(`⛔ ${e.message}`); process.exit(2) } })()
  : join(HERE, '..', '..', '..')

// Same bundle definition the daemon builds in dev mode — one source, no drift.
const { buildSdk } = await import(join(HERE, 'sdk-bundle.mjs'))
const SDK = await buildSdk(HOST, STANDALONE ? AGENT : join(HOST, 'packages', 'agent'))

// Copying a file that does not parse is silent until the client fails to start: this
// installer shipped a broken server.mjs once, because it validates the SDK bundle's
// globals but never checked the sources it copies. Parse them first.
const { execFileSync } = await import('node:child_process')
for (const f of [join(HERE, 'browse.mjs'), join(HERE, '..', 'mcp', 'server.mjs')]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) {
    console.error(`⛔ ${f} does not parse — refusing to install:\n${(e.stderr || '').toString().split('\n').slice(0, 3).join('\n')}`)
    process.exit(2)
  }
}

await mkdir(DEST, { recursive: true })
await mkdir(join(DEST, 'logs'), { recursive: true })
await writeFile(join(DEST, 'sdk.js'), SDK)
await copyFile(join(HERE, 'browse.mjs'), join(DEST, 'browse.mjs'))
await writeFile(join(DEST, 'paths.json'), JSON.stringify({ repo: HOST, agent: AGENT }))

// The MCP server, so Claude Code and Claude Desktop can be registered against a path
// that does not disappear when the repo changes branch. It finds the daemon by looking
// next to itself, which is exactly where browse.mjs was just copied.
await copyFile(join(HERE, '..', 'mcp', 'server.mjs'), join(DEST, 'server.mjs'))

// The extension, for the same reason: Chrome loads it unpacked from a fixed path and
// disables it if that path goes away.
const COMPANION = join(DEST, 'companion')
await mkdir(COMPANION, { recursive: true })
for (const f of await readdir(join(HERE, '..', 'companion'))) {
  if (f === 'content.bundle.js' || f === 'manifest.json') {
    await copyFile(join(HERE, '..', 'companion', f), join(COMPANION, f))
  }
}

// User-level skill: the versioned one, with the global harness paths. The rewrites are
// idempotent so re-installing from an already-rewritten copy cannot double the header.
const SKILLSRC = [join(AGENT, 'skill', 'SKILL.md'), join(HOST, '.claude', 'skills', 'agent-browse', 'SKILL.md')]
const skillPath = (await Promise.all(SKILLSRC.map(async (p) => (await exists(p)) ? p : null))).find(Boolean)
if (!skillPath) {
  console.error(`⛔ no SKILL.md source found. Tried:\n  ${SKILLSRC.join('\n  ')}`)
  process.exit(2)
}
const HEADING = '# agent-browse — browse with the oracle instead of screenshots'
const NOTE = `> MACHINE-GLOBAL install (~/.claude/snapdom-agent). Refresh after agent changes:\n> \`node ${join(AGENT, 'tools', 'install-global.mjs')}\``
const skill = (await readFile(skillPath, 'utf8'))
  .replaceAll('packages/agent/tools/browse.mjs', join(DEST, 'browse.mjs'))
  .replace(new RegExp(`${HEADING}\\n\\n> MACHINE-GLOBAL install[\\s\\S]*?\\n\\n`), `${HEADING}\n\n`)
await mkdir(SKILLDIR, { recursive: true })
await writeFile(join(SKILLDIR, 'SKILL.md'), skill.replace(HEADING, `${HEADING}\n\n${NOTE}`))

console.log(`installed:
  ${join(DEST, 'browse.mjs')} (+ sdk.js ${Math.round(SDK.length / 1024)}KB, paths.json, logs/)
  ${join(DEST, 'server.mjs')} (MCP server — register Claude Code/Desktop against THIS path)
  ${COMPANION}/ (Chrome extension — load unpacked from here)
  ${join(SKILLDIR, 'SKILL.md')} (user-level global skill)`)
