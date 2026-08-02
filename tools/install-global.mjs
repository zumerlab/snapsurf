/**
 * install-global.mjs — installs the oracle harness as a MACHINE-GLOBAL tool
 * (~/.claude/snapdom-agent), independent of which branch the repo sits on:
 *
 *   node packages/agent/tools/install-global.mjs      # run from agent-lab
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
 * Re-run after changing packages/agent/src or browse.mjs to refresh.
 * NOTHING is published: everything stays in this machine's ~/.claude.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const HOME = process.env.HOME
const DEST = join(HOME, '.claude', 'snapdom-agent')
const SKILLDIR = join(HOME, '.claude', 'skills', 'agent-browse')

// Same bundle definition the daemon builds in dev mode — one source, no drift.
const { buildSdk } = await import(join(HERE, 'sdk-bundle.mjs'))
const SDK = await buildSdk(REPO)

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
await writeFile(join(DEST, 'paths.json'), JSON.stringify({ repo: REPO }))

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

// User-level skill: the repo one, with the global harness paths.
const skill = await readFile(join(REPO, '.claude', 'skills', 'agent-browse', 'SKILL.md'), 'utf8')
await mkdir(SKILLDIR, { recursive: true })
await writeFile(join(SKILLDIR, 'SKILL.md'),
  skill.replaceAll('packages/agent/tools/browse.mjs', join(DEST, 'browse.mjs'))
    .replace('# agent-browse — browse with the oracle instead of screenshots',
      `# agent-browse — browse with the oracle instead of screenshots\n\n> MACHINE-GLOBAL install (~/.claude/snapdom-agent). Refresh after agent-lab changes:\n> \`node ${join(REPO, 'packages/agent/tools/install-global.mjs')}\``))

console.log(`installed:
  ${join(DEST, 'browse.mjs')} (+ sdk.js ${Math.round(SDK.length / 1024)}KB, paths.json, logs/)
  ${join(DEST, 'server.mjs')} (MCP server — register Claude Code/Desktop against THIS path)
  ${COMPANION}/ (Chrome extension — load unpacked from here)
  ${join(SKILLDIR, 'SKILL.md')} (user-level global skill)`)
